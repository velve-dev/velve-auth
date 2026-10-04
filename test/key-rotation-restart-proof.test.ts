import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { rootKeyProvider } from "../src/core/keys/index.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { configFor, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { generateRootKey } from "./keys-fixtures.js";
import { drawTestPassword } from "./password-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

/**
 * T-KEY-5 through the assembled instance. Each step is a new `createVelveAuth` over the same
 * database with a new ring, which is what a process restart leaves behind, and each restart runs
 * `migrate()` because that is where a ring missing a stored version is refused (E-1697).
 */

const PASSWORD = drawTestPassword();
const ONE_TOTP_STEP_IN_MILLISECONDS = 30_000;
const REWRITE_SETTLE_LIMIT_MS = 20_000;

const firstRootKey = generateRootKey();
const secondRootKey = generateRootKey();

const ringBeforeRotation = (): KeyProvider =>
	rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: firstRootKey } });
const ringDuringRotation = (): KeyProvider =>
	rootKeyProvider({ currentVersion: 2, keysByVersion: { 1: firstRootKey, 2: secondRootKey } });
const ringAfterRotation = (): KeyProvider =>
	rootKeyProvider({ currentVersion: 2, keysByVersion: { 2: secondRootKey } });

let connection: TestConnection;
let schema: string;
let clock: TestClock;

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("keyrestart"));
	clock = createTestClock();
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

async function restartWith(keys: KeyProvider): Promise<VelveAuth<"email">> {
	const auth = createVelveAuth(
		configFor({
			database: connection,
			schema,
			keys,
			clock,
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		}),
	);
	await auth.migrate();
	return auth;
}

function totpCodeNow(secretBase32: string): string {
	return totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now()));
}

function nextTotpStep(): void {
	clock.advanceBy(2 * ONE_TOTP_STEP_IN_MILLISECONDS);
}

async function enrolTotp(auth: VelveAuth<"email">, sessionToken: string): Promise<string> {
	const { secretBase32 } = await auth.factor.totp.enroll.start({
		origin: TEST_ORIGIN,
		sessionToken,
	});
	await auth.factor.totp.enroll.finish({
		code: totpCodeNow(secretBase32),
		origin: TEST_ORIGIN,
		sessionToken,
	});
	nextTotpStep();
	return secretBase32;
}

async function keyVersionIn(table: string, userId: string): Promise<number | null> {
	const [row] = await connection.query<{ key_version: number }>(
		`SELECT key_version FROM ${schema}.${table} WHERE user_id = $1`,
		[userId],
	);
	return row === undefined ? null : Number(row.key_version);
}

async function sessionIds(): Promise<readonly string[]> {
	const rows = await connection.query<{ id: string }>(
		`SELECT id FROM ${schema}.session ORDER BY id`,
		[],
	);
	return rows.map((row) => row.id);
}

async function passwordRewrittenUnder(version: number, userId: string): Promise<boolean> {
	const deadline = Date.now() + REWRITE_SETTLE_LIMIT_MS;
	while (Date.now() < deadline) {
		if ((await keyVersionIn("password_credential", userId)) === version) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return false;
}

describe("T-KEY-5 — a rotation of the root key ends no session (S-KEY-5)", () => {
	it("keeps the session valid after both restarts, opens the old secret and writes new ones under v2", async () => {
		const beforeRotation = await restartWith(ringBeforeRotation());
		const signedUp = await beforeRotation.signUp.withPassword({
			email: "rotating@example.com",
			password: PASSWORD,
			origin: TEST_ORIGIN,
		});
		const userId = signedUp.user.id;
		const sessionToken = signedUp.sessionToken;
		const totpSecret = await enrolTotp(beforeRotation, sessionToken);
		expect(await keyVersionIn("totp_credential", userId)).toBe(1);
		const sessionsBeforeRotation = await sessionIds();

		const duringRotation = await restartWith(ringDuringRotation());

		const readDuring = await duringRotation.session.resolve({ origin: TEST_ORIGIN, sessionToken });
		expect(readDuring?.user.id, "the session after v2 was put in front").toBe(userId);

		const begun = await duringRotation.signIn.password({
			email: "rotating@example.com",
			password: PASSWORD,
			origin: TEST_ORIGIN,
		});
		if (begun.status !== "second_factor_required") {
			throw new Error(`the account offers a second factor and was answered ${begun.status}`);
		}
		const verified = await duringRotation.factor.totp.verify({
			code: totpCodeNow(totpSecret),
			origin: TEST_ORIGIN,
			pendingToken: begun.pendingToken,
		});
		nextTotpStep();
		expect(verified.status, "the v1 TOTP secret opened under the grown ring").toBe("signed_in");

		const second = await duringRotation.signUp.withPassword({
			email: "rotated@example.com",
			password: PASSWORD,
			origin: TEST_ORIGIN,
		});
		await enrolTotp(duringRotation, second.sessionToken);
		expect(await keyVersionIn("totp_credential", second.user.id), "a new TOTP write").toBe(2);
		expect(await keyVersionIn("password_credential", second.user.id), "a new password write").toBe(
			2,
		);

		//the old version leaves the ring only once nothing refers to it
		expect(await passwordRewrittenUnder(2, userId)).toBe(true);
		await duringRotation.factor.totp.remove({
			code: totpCodeNow(totpSecret),
			origin: TEST_ORIGIN,
			sessionToken,
		});
		nextTotpStep();

		const afterRotation = await restartWith(ringAfterRotation());

		const readAfter = await afterRotation.session.resolve({ origin: TEST_ORIGIN, sessionToken });
		expect(readAfter?.user.id, "the session after v1 left the ring").toBe(userId);
		const secondRead = await afterRotation.session.resolve({
			origin: TEST_ORIGIN,
			sessionToken: second.sessionToken,
		});
		expect(secondRead?.user.id).toBe(second.user.id);

		expect(await sessionIds()).toEqual(expect.arrayContaining([...sessionsBeforeRotation]));
	}, 120_000);
});
