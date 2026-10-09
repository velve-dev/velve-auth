import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { encryptWithPurposeKey } from "../src/core/keys/envelope.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { configFor, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { drawTestPassword } from "./password-fixtures.js";
import {
	interceptingDriver,
	passwordPlaintextOf,
	toPreUpgradeForm,
} from "./security-state-administration-fixtures.js";
import { testKeyRing } from "./totp-fixtures.js";

//a tampered migration state is refused and alarmed, never sealed (T-INTEG-8, S-INTEG-8)

const PASSWORD = drawTestPassword();
const ring = testKeyRing(2);
const before = ring.providerAt(1, [1]);
const during = ring.providerAt(2, [1, 2]);

let connection: TestConnection;
let second: TestConnection;
let observer: TestConnection;
let schema: string;
let alarms: SecurityStateAlarm[];

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("integ_maintenance_tamper"));
	second = await openTestConnection();
	observer = await openTestConnection();
}, 60_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
	await second.close();
	await observer.close();
});

function mount(
	database: Driver,
	keys: KeyProvider,
	sealing: "migrating" | "required" = "migrating",
): VelveAuth<"email"> {
	return createVelveAuth(
		configFor({
			database,
			schema,
			keys,
			securityState: { sealing, alarm: (alarm) => alarms.push(alarm) },
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		}),
	);
}

async function clearEstate(): Promise<void> {
	await connection.query(`DELETE FROM ${schema}.user`, []);
	alarms = [];
}

async function signedUp(
	auth: VelveAuth<"email">,
): Promise<{ userId: string; email: string; sessionToken: string }> {
	const email = `${randomBytes(6).toString("hex")}@example.com`;
	const result = await auth.signUp.withPassword({ email, password: PASSWORD, origin: TEST_ORIGIN });
	return { userId: result.user.id, email, sessionToken: result.sessionToken };
}

async function sealRowOf(userId: string): Promise<string | null> {
	const [row] = await connection.query<{ row: string }>(
		`SELECT version::text || ':' || encode(digest, 'hex') || ':' || key_version::text AS row
		 FROM ${schema}.security_state WHERE user_id = $1`,
		[userId],
	);
	return row?.row ?? null;
}

async function phcOf(userId: string): Promise<string> {
	const [row] = await connection.query<{ phc: string }>(
		`SELECT encode(phc, 'hex') || ':' || key_version::text AS phc
		 FROM ${schema}.password_credential WHERE user_id = $1`,
		[userId],
	);
	return row?.phc ?? "";
}

function alarmsFor(userId: string | null): readonly Omit<SecurityStateAlarm, "suppressed">[] {
	return alarms
		.filter((alarm) => alarm.userId === userId)
		.map(({ userId: id, occasion, reason }) => ({ userId: id, occasion, reason }));
}

async function deliveredAlarms(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("T-INTEG-8: a tampered migration state", () => {
	it("refuses an old-form ciphertext a writer put into a sealed account", async () => {
		await clearEstate();
		const auth = mount(connection, before);
		const account = await signedUp(auth);
		const plaintext = await passwordPlaintextOf(connection, schema, before, account.userId);
		const old = await encryptWithPurposeKey(before, "password-enc", plaintext);
		await connection.query(
			`UPDATE ${schema}.password_credential SET phc = $2, key_version = $3 WHERE user_id = $1`,
			[account.userId, old.ciphertext, old.keyVersion],
		);
		const sealBefore = await sealRowOf(account.userId);

		const report = await auth.maintenance.sealSecurityState();
		await deliveredAlarms();

		expect(report).toMatchObject({ sealed: 0, rekeyed: 0, refused: 1, unchanged: 0 });
		expect(await sealRowOf(account.userId)).toBe(sealBefore);
		expect(alarmsFor(account.userId)).toStrictEqual([
			{ userId: account.userId, occasion: "maintenance", reason: "seal_mismatch" },
		]);
	});

	it("refuses an account whose seal row was deleted once the mode is required", async () => {
		await clearEstate();
		const account = await signedUp(mount(connection, before));
		await connection.query(`DELETE FROM ${schema}.security_state WHERE user_id = $1`, [
			account.userId,
		]);
		const required = mount(connection, before, "required");

		const report = await required.maintenance.sealSecurityState();
		await deliveredAlarms();
		const signIn = required.signIn.password({
			email: account.email,
			password: PASSWORD,
			origin: TEST_ORIGIN,
		});

		expect(report).toMatchObject({ sealed: 0, refused: 1 });
		expect(await sealRowOf(account.userId)).toBeNull();
		await expect(signIn).rejects.toMatchObject({ code: "invalid_credentials" });
		expect(alarmsFor(account.userId)[0]).toStrictEqual({
			userId: account.userId,
			occasion: "maintenance",
			reason: "seal_missing",
		});
	});

	it("does not re-encrypt a password ciphertext swapped for an older one after the verified read", async () => {
		await clearEstate();
		const auth = mount(connection, before);
		const account = await signedUp(auth);
		const older = await connection.query<{ phc: Uint8Array; key_version: number }>(
			`SELECT phc, key_version FROM ${schema}.password_credential WHERE user_id = $1`,
			[account.userId],
		);
		await auth.password.change({
			currentPassword: PASSWORD,
			newPassword: drawTestPassword(),
			origin: TEST_ORIGIN,
			sessionToken: account.sessionToken,
		});
		const sealBefore = await sealRowOf(account.userId);
		const swapped = interceptingDriver(
			second,
			(sql) => /^UPDATE \S+\.password_credential/.test(sql),
			async () => {
				await observer.query(
					`UPDATE ${schema}.password_credential SET phc = $2, key_version = $3 WHERE user_id = $1`,
					[account.userId, older[0]?.phc, older[0]?.key_version],
				);
			},
		);
		const phcSwapped = Buffer.from(older[0]?.phc ?? []).toString("hex");

		const report = await mount(swapped, during).maintenance.sealSecurityState();
		await deliveredAlarms();

		expect(report).toMatchObject({ rekeyed: 0, refused: 1 });
		expect(await phcOf(account.userId)).toBe(`${phcSwapped}:${older[0]?.key_version}`);
		expect(await sealRowOf(account.userId)).toBe(sealBefore);
		expect(alarmsFor(account.userId)).toStrictEqual([
			{ userId: account.userId, occasion: "maintenance", reason: "seal_mismatch" },
		]);
	});

	it("makes a change that meets the first seal wait on the account lock, with no retry and no alarm", async () => {
		await clearEstate();
		const account = await signedUp(mount(connection, before));
		await toPreUpgradeForm(connection, schema, before, account.userId);
		const [changeBackend] = await connection.query<{ pid: number }>(
			"SELECT pg_backend_pid() AS pid",
			[],
		);
		let changeSealInserts = 0;
		const requests = mount(
			interceptingDriver(
				connection,
				(sql) => /^INSERT INTO \S+\.security_state/.test(sql),
				() => {
					changeSealInserts += 1;
					return Promise.resolve();
				},
			),
			before,
		);
		let change: Promise<unknown> | null = null;
		const holding = interceptingDriver(
			second,
			(sql) => sql.includes("jsonb_build_object"),
			async () => {
				if (change !== null) {
					return;
				}
				change = requests.factor.recovery.generate({
					origin: TEST_ORIGIN,
					sessionToken: account.sessionToken,
				});
				await untilWaiting(changeBackend?.pid ?? -1);
			},
		);

		const report = await mount(holding, before).maintenance.sealSecurityState();
		await change;
		await deliveredAlarms();

		const [state] = await connection.query<{ rows: number; version: string }>(
			`SELECT count(*)::int AS rows, max(version)::text AS version FROM ${schema}.security_state WHERE user_id = $1`,
			[account.userId],
		);
		expect(change, "the change was started while the maintenance held the lock").not.toBeNull();
		expect(report).toMatchObject({ sealed: 1, refused: 0 });
		expect(state).toStrictEqual({ rows: 1, version: "2" });
		expect(changeSealInserts, "the change inserted no seal row and was not retried").toBe(0);
		expect(alarms).toStrictEqual([]);
	});

	it("leaves a session and a one-time token a writer inserted under the old version standing and unusable", async () => {
		await clearEstate();
		const auth = mount(connection, before);
		const sessionOwner = await signedUp(auth);
		const tokenOwner = await signedUp(auth);
		const forgedSessionMac = randomBytes(32);
		const forgedTokenMac = randomBytes(32);
		await connection.query(
			`INSERT INTO ${schema}.session (id, token_sha256, user_id, factors, idle_expires_at, absolute_expires_at, token_mac, token_mac_key_version)
			 VALUES ($1, $2, $3, '{password}', now() + interval '1 day', now() + interval '2 days', $4, 1)`,
			[randomUUID(), randomBytes(32), sessionOwner.userId, forgedSessionMac],
		);
		await connection.query(
			`INSERT INTO ${schema}.one_time_token (token_sha256, purpose, user_id, payload, expires_at, token_mac, token_mac_key_version)
			 VALUES ($1, 'password_reset', $2, NULL, now() + interval '1 hour', $3, 1)`,
			[randomBytes(32), tokenOwner.userId, forgedTokenMac],
		);

		const report = await mount(connection, during).maintenance.sealSecurityState();
		await deliveredAlarms();

		const standing = await connection.query<{ mac: string; version: number }>(
			`SELECT encode(token_mac, 'hex') AS mac, token_mac_key_version AS version FROM ${schema}.session WHERE token_mac = $1
			 UNION ALL SELECT encode(token_mac, 'hex'), token_mac_key_version FROM ${schema}.one_time_token WHERE token_mac = $2`,
			[forgedSessionMac, forgedTokenMac],
		);
		expect(standing.map((row) => Number(row.version))).toStrictEqual([1, 1]);
		expect(report.rowsByKeyVersion[1]).toStrictEqual({ seals: 0, tokens: 0, traces: 2 });
		expect(alarmsFor(sessionOwner.userId)).toStrictEqual([
			{ userId: sessionOwner.userId, occasion: "maintenance", reason: "token_binding_mismatch" },
		]);
		expect(alarmsFor(tokenOwner.userId)).toStrictEqual([
			{ userId: tokenOwner.userId, occasion: "maintenance", reason: "token_binding_mismatch" },
		]);
	});
});

async function untilWaiting(waiter: number): Promise<void> {
	for (let poll = 0; poll < 500; poll += 1) {
		const [row] = await observer.query<{ n: number }>(
			"SELECT cardinality(pg_blocking_pids($1::int))::int AS n",
			[waiter],
		);
		if ((row?.n ?? 0) > 0) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("the change never waited on the account lock");
}
