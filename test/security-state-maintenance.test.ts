import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { configFor, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { drawTestPassword } from "./password-fixtures.js";
import {
	insertPreUpgradeAccount,
	interceptingDriver,
	opensBound,
	passwordPlaintextOf,
	toPreUpgradeForm,
} from "./security-state-administration-fixtures.js";
import { enrolConfirmedCredential, testKeyRing } from "./totp-fixtures.js";

//the maintenance step seals an estate from before the upgrade (T-INTEG-8, S-INTEG-8)

const PASSWORD = drawTestPassword();
const ACCOUNTS = 200;
const INTERRUPTED_AFTER = 70;
const ring = testKeyRing(1);
const keys = ring.providerAt(1);

let connection: TestConnection;
let maintenanceConnection: TestConnection;
let schema: string;
let clock: TestClock;
const alarms: SecurityStateAlarm[] = [];

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("integ_maintenance"));
	maintenanceConnection = await openTestConnection();
	clock = createTestClock();
}, 60_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
	await maintenanceConnection.close();
});

function mount(database: Driver, provider: KeyProvider = keys): VelveAuth<"email"> {
	return createVelveAuth(
		configFor({
			database,
			schema,
			keys: provider,
			clock,
			securityState: { sealing: "migrating", alarm: (alarm) => alarms.push(alarm) },
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		}),
	);
}

function lowIdOf(index: number): string {
	return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

interface StoredEnvelopes {
	readonly userId: string;
	readonly sealed: boolean;
	readonly phc: { readonly keyVersion: number; readonly ciphertext: Uint8Array };
	readonly totp: { readonly keyVersion: number; readonly ciphertext: Uint8Array } | null;
}

async function storedEnvelopes(): Promise<readonly StoredEnvelopes[]> {
	const rows = await connection.query<{
		id: string;
		sealed: boolean;
		phc: Uint8Array;
		phc_version: number;
		secret_enc: Uint8Array | null;
		secret_version: number | null;
	}>(
		`SELECT u.id, s.user_id IS NOT NULL AS sealed, p.phc, p.key_version AS phc_version,
			t.secret_enc, t.key_version AS secret_version
		 FROM ${schema}.user u
		 JOIN ${schema}.password_credential p ON p.user_id = u.id
		 LEFT JOIN ${schema}.totp_credential t ON t.user_id = u.id
		 LEFT JOIN ${schema}.security_state s ON s.user_id = u.id
		 ORDER BY u.id`,
		[],
	);
	return rows.map((row) => ({
		userId: row.id,
		sealed: row.sealed,
		phc: { keyVersion: Number(row.phc_version), ciphertext: row.phc },
		totp:
			row.secret_enc === null
				? null
				: { keyVersion: Number(row.secret_version), ciphertext: row.secret_enc },
	}));
}

//an account is converted in seal and envelopes entirely or not at all (S-INTEG-8)
async function halfConverted(rows: readonly StoredEnvelopes[]): Promise<readonly string[]> {
	const half: string[] = [];
	for (const row of rows) {
		const passwordBound =
			(await opensBound(keys, "password_credential.phc", row.userId, row.phc)) !== null;
		const totpBound =
			row.totp === null ||
			(await opensBound(keys, "totp_credential.secret_enc", row.userId, row.totp)) !== null;
		const envelopesBound = passwordBound && totpBound;
		const envelopesOld = !passwordBound && (row.totp === null || !totpBound);
		if (row.sealed ? !envelopesBound : !envelopesOld) {
			half.push(row.userId);
		}
	}
	return half;
}

async function rowVersions(): Promise<string> {
	const rows = await connection.query<{ snapshot: string }>(
		`SELECT string_agg(t || ':' || x, ',' ORDER BY t, x) AS snapshot FROM (
			SELECT 's' AS t, xmin::text AS x FROM ${schema}.security_state
			UNION ALL SELECT 'p', xmin::text FROM ${schema}.password_credential
			UNION ALL SELECT 't', xmin::text FROM ${schema}.totp_credential) rows`,
		[],
	);
	return rows[0]?.snapshot ?? "";
}

async function insertEstate(
	phc: Uint8Array<ArrayBuffer>,
	passwords: Map<string, Uint8Array<ArrayBuffer>>,
	secrets: Map<string, Uint8Array<ArrayBuffer>>,
): Promise<void> {
	for (let index = 0; index < ACCOUNTS - 2; index += 1) {
		const id = lowIdOf(index);
		const totpSecret = index % 2 === 0 ? new Uint8Array(randomBytes(20)) : undefined;
		await insertPreUpgradeAccount(connection, schema, keys, {
			id,
			phc,
			...(totpSecret === undefined ? {} : { totpSecret }),
		});
		passwords.set(id, phc);
		if (totpSecret !== undefined) {
			secrets.set(id, totpSecret);
		}
	}
}

//every rewritten ciphertext opens to the plaintext the account held before (S-INTEG-8)
async function reEncryptionsOfAnotherPlaintext(
	rows: readonly StoredEnvelopes[],
	passwords: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
	secrets: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
): Promise<readonly string[]> {
	const differing: string[] = [];
	for (const row of rows) {
		const password = await opensBound(keys, "password_credential.phc", row.userId, row.phc);
		if (
			Buffer.compare(Buffer.from(password ?? []), Buffer.from(passwords.get(row.userId) ?? [1])) !==
			0
		) {
			differing.push(`${row.userId} password`);
		}
		if (row.totp === null) {
			continue;
		}
		const secret = await opensBound(keys, "totp_credential.secret_enc", row.userId, row.totp);
		if (
			Buffer.compare(Buffer.from(secret ?? []), Buffer.from(secrets.get(row.userId) ?? [1])) !== 0
		) {
			differing.push(`${row.userId} totp`);
		}
	}
	return differing;
}

describe("T-INTEG-8: sealing an estate from before the upgrade", () => {
	it("seals 200 accounts across an interruption, leaves none half converted and writes nothing twice", async () => {
		const auth = mount(connection);
		const holder = await auth.signUp.withPassword({
			email: "holder@example.com",
			password: PASSWORD,
			origin: TEST_ORIGIN,
		});
		const changer = await auth.signUp.withPassword({
			email: "changer@example.com",
			password: PASSWORD,
			origin: TEST_ORIGIN,
		});
		const changerSecret = await enrolConfirmedCredential(connection, schema, keys, changer.user.id);
		const phc = await passwordPlaintextOf(connection, schema, keys, holder.user.id);
		const secrets = new Map<string, Uint8Array<ArrayBuffer>>([[changer.user.id, changerSecret]]);
		const passwords = new Map<string, Uint8Array<ArrayBuffer>>([
			[holder.user.id, phc],
			[changer.user.id, await passwordPlaintextOf(connection, schema, keys, changer.user.id)],
		]);
		await insertEstate(phc, passwords, secrets);
		await toPreUpgradeForm(connection, schema, keys, holder.user.id);
		await toPreUpgradeForm(connection, schema, keys, changer.user.id);
		alarms.length = 0;

		let firstSeals = 0;
		const interrupted = mount(
			interceptingDriver(
				maintenanceConnection,
				(sql) => /^INSERT INTO \S+\.security_state/.test(sql),
				() => {
					firstSeals += 1;
					return firstSeals > INTERRUPTED_AFTER
						? Promise.reject(new Error("the maintenance process was stopped"))
						: Promise.resolve();
				},
			),
		);
		await expect(interrupted.maintenance.sealSecurityState()).rejects.toMatchObject({
			code: "security_state_account_failed",
		});

		const afterInterruption = await storedEnvelopes();
		expect(afterInterruption.filter((row) => row.sealed)).toHaveLength(INTERRUPTED_AFTER);
		expect(await halfConverted(afterInterruption)).toStrictEqual([]);
		const resolved = await auth.session.resolve({
			origin: TEST_ORIGIN,
			sessionToken: holder.sessionToken,
		});
		expect(resolved?.user.id, "a session of an account not yet converted").toBe(holder.user.id);
		await auth.factor.recovery.generate({
			origin: TEST_ORIGIN,
			sessionToken: changer.sessionToken,
		});

		const resumed = await mount(maintenanceConnection).maintenance.sealSecurityState();
		expect(resumed).toMatchObject({
			sealed: ACCOUNTS - INTERRUPTED_AFTER - 1,
			refused: 0,
			unchanged: INTERRUPTED_AFTER + 1,
		});
		const afterRun = await storedEnvelopes();
		expect(afterRun.filter((row) => row.sealed)).toHaveLength(ACCOUNTS);
		expect(await halfConverted(afterRun)).toStrictEqual([]);
		expect(await reEncryptionsOfAnotherPlaintext(afterRun, passwords, secrets)).toStrictEqual([]);

		const before = await rowVersions();
		const second = await mount(maintenanceConnection).maintenance.sealSecurityState();
		expect(second).toMatchObject({ sealed: 0, rekeyed: 0, refused: 0, unchanged: ACCOUNTS });
		const [tokenRows] = await connection.query<{ n: number }>(
			`SELECT ((SELECT count(*) FROM ${schema}.session) + (SELECT count(*) FROM ${schema}.one_time_token)
				+ (SELECT count(*) FROM ${schema}.pending_authentication)
				+ (SELECT count(*) FROM ${schema}.webauthn_challenge))::int AS n`,
			[],
		);
		expect(second.rowsByKeyVersion).toStrictEqual({
			1: { seals: ACCOUNTS, tokens: tokenRows?.n, traces: 0 },
		});
		expect(await rowVersions(), "the second run wrote no row").toBe(before);

		const begun = await auth.signIn.password({
			email: "changer@example.com",
			password: PASSWORD,
			origin: TEST_ORIGIN,
		});
		if (begun.status !== "second_factor_required") {
			throw new Error(`the converted account answered ${begun.status}`);
		}
		const verified = await auth.factor.totp.verify({
			code: totpCodeForStep(changerSecret, timeStepAt(clock.now())),
			origin: TEST_ORIGIN,
			pendingToken: begun.pendingToken,
		});
		expect(verified.status, "password and TOTP of the changed account").toBe("signed_in");
		expect(alarms).toStrictEqual([]);
	}, 300_000);
});
