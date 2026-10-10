import { randomBytes, randomUUID } from "node:crypto";
import type { Driver } from "../src/core/db/driver.js";
import { encodeBase64Url } from "../src/core/keys/base64url.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { FIRST_GENERATIONS } from "../src/core/security-state/encoding.js";
import { DEFAULT_LIMITS } from "../src/core/security-state/limits.js";
import {
	generationsOf,
	readSecurityState,
	sealedComponentsOf,
	securityStateOf,
} from "../src/core/security-state/read.js";
import {
	createSecurityStateRuntime,
	type SecurityStateRuntime,
} from "../src/core/security-state/runtime.js";
import { computeSeal } from "../src/core/security-state/seal.js";
import { createUser } from "./db-fixtures.js";

/** which components an account seeded for a seal test holds */
export interface SeededComponents {
	readonly password?: boolean;
	readonly passwordSetBySession?: boolean;
	readonly totp?: "confirmed" | "unconfirmed" | false;
	readonly passkeys?: number;
	readonly identities?: number;
	readonly recoveryCodes?: number;
	readonly resetRequired?: boolean;
	readonly verified?: boolean;
	readonly disabled?: boolean;
}

export const EVERY_COMPONENT: SeededComponents = {
	password: true,
	passwordSetBySession: true,
	totp: "confirmed",
	passkeys: 2,
	identities: 2,
	recoveryCodes: 3,
	resetRequired: true,
	verified: true,
	disabled: true,
};

export async function insertPasskey(driver: Driver, schema: string, userId: string): Promise<void> {
	await driver.query(
		`INSERT INTO ${schema}.webauthn_credential
  (user_id, credential_id, public_key, backup_eligible, backup_state, user_verified_at_registration)
VALUES ($1, $2, $3, false, false, true)`,
		[userId, randomBytes(32), randomBytes(77)],
	);
}

export async function insertIdentity(
	driver: Driver,
	schema: string,
	userId: string,
): Promise<void> {
	await driver.query(
		`INSERT INTO ${schema}.identity (user_id, provider, subject) VALUES ($1, $2, $3)`,
		[userId, "github", randomUUID()],
	);
}

export async function insertRecoveryCode(
	driver: Driver,
	schema: string,
	userId: string,
): Promise<void> {
	await driver.query(
		`INSERT INTO ${schema}.recovery_code (user_id, code_hmac, key_version) VALUES ($1, $2, 1)`,
		[userId, randomBytes(32)],
	);
}

export async function seedAccount(
	driver: Driver,
	schema: string,
	components: SeededComponents,
): Promise<string> {
	const userId = await createUser(driver, schema);
	if (components.verified === true || components.disabled === true) {
		await driver.query(
			`UPDATE ${schema}.user SET
  email_verified_at = CASE WHEN $2 THEN now() END,
  disabled_at = CASE WHEN $3 THEN now() END
WHERE id = $1`,
			[userId, components.verified === true, components.disabled === true],
		);
	}
	if (components.password === true) {
		await driver.query(
			`INSERT INTO ${schema}.password_credential (user_id, phc, key_version, scheme, set_by_session_id)
VALUES ($1, $2, 1, 'argon2id', $3)`,
			[userId, randomBytes(96), components.passwordSetBySession === true ? randomUUID() : null],
		);
	}
	if (components.totp !== undefined && components.totp !== false) {
		await driver.query(
			`INSERT INTO ${schema}.totp_credential (user_id, secret_enc, key_version, confirmed_at)
VALUES ($1, $2, 1, CASE WHEN $3 THEN now() END)`,
			[userId, randomBytes(48), components.totp === "confirmed"],
		);
	}
	for (let index = 0; index < (components.passkeys ?? 0); index += 1) {
		await insertPasskey(driver, schema, userId);
	}
	for (let index = 0; index < (components.identities ?? 0); index += 1) {
		await insertIdentity(driver, schema, userId);
	}
	for (let index = 0; index < (components.recoveryCodes ?? 0); index += 1) {
		await insertRecoveryCode(driver, schema, userId);
	}
	if (components.resetRequired === true) {
		await driver.query(
			`INSERT INTO ${schema}.password_reset_required (user_id, reason, source) VALUES ($1, 'test', 'test')`,
			[userId],
		);
	}
	return userId;
}

//a directly sealed account must hold the seal the library's first seal would write
export async function sealDirectly(
	driver: Driver,
	schema: string,
	keys: KeyProvider,
	userId: string,
	seal: { readonly version: number; readonly sessionEpoch: number } = {
		version: 1,
		sessionEpoch: 1,
	},
): Promise<{ readonly version: number; readonly digest: string }> {
	const read = await readSecurityState(driver, schema, userId);
	if (read === null) {
		throw new Error("the account to seal does not exist");
	}
	const sealed = await computeSeal(
		keys,
		securityStateOf(read, {
			...seal,
			...FIRST_GENERATIONS,
			digest: new Uint8Array(32),
			keyVersion: 1,
		}),
	);
	await driver.query(
		`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version, session_epoch)
VALUES ($1, $2, $3, $4, $5)`,
		[userId, seal.version, sealed.digest, sealed.keyVersion, seal.sessionEpoch],
	);
	return { version: seal.version, digest: encodeBase64Url(sealed.digest) };
}

/** a security-state runtime for a test that builds a service by hand, with the alarm collected */
export function testSecurityState(
	driver: Driver,
	schema: string,
	keys: KeyProvider,
	options: {
		readonly sealing?: "required" | "migrating";
		readonly alarms?: SecurityStateAlarm[];
	} = {},
): SecurityStateRuntime {
	return createSecurityStateRuntime({
		driver,
		schema,
		keys,
		//an account a test created by SQL is first sealed by its first change
		sealing: options.sealing ?? "migrating",
		limits: DEFAULT_LIMITS,
		anchors: [],
		alarm: (event) => {
			options.alarms?.push(event);
		},
		log: () => undefined,
		clock: { now: () => new Date() },
	});
}

//a test that wrote sign-in rows by SQL seals what it wrote as the account's legitimate state
export async function resealDirectly(
	driver: Driver,
	schema: string,
	keys: KeyProvider,
	userId: string,
): Promise<void> {
	const read = await readSecurityState(driver, schema, userId);
	if (read === null) {
		throw new Error("the account to seal does not exist");
	}
	const version = (read.seal?.version ?? 0) + 1;
	const sessionEpoch = read.seal?.sessionEpoch ?? 1;
	const sealed = await computeSeal(keys, {
		userId,
		version,
		sessionEpoch,
		...(read.seal === null ? FIRST_GENERATIONS : generationsOf(read.seal)),
		componentsVersion: version,
		...sealedComponentsOf(read),
	});
	await driver.query(
		`INSERT INTO ${schema}.security_state
  (user_id, version, digest, key_version, session_epoch, components_version)
VALUES ($1, $2, $3, $4, $5, $2)
ON CONFLICT (user_id) DO UPDATE SET version = EXCLUDED.version, digest = EXCLUDED.digest,
  key_version = EXCLUDED.key_version, session_epoch = EXCLUDED.session_epoch,
  components_version = EXCLUDED.components_version`,
		[userId, version, sealed.digest, sealed.keyVersion, sessionEpoch],
	);
}
