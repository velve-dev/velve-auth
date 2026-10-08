import { randomBytes, randomUUID } from "node:crypto";
import type { Driver } from "../src/core/db/driver.js";
import { encodeBase64Url } from "../src/core/keys/base64url.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { readSecurityState, securityStateOf } from "../src/core/security-state/read.js";
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
		securityStateOf(read, { ...seal, digest: new Uint8Array(32), keyVersion: 1 }),
	);
	await driver.query(
		`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version, session_epoch)
VALUES ($1, $2, $3, $4, $5)`,
		[userId, seal.version, sealed.digest, sealed.keyVersion, seal.sessionEpoch],
	);
	return { version: seal.version, digest: encodeBase64Url(sealed.digest) };
}
