import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { rootKeyProvider } from "../src/core/keys/index.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { sessionBinding } from "../src/core/session/binding.js";
import { createSessionToken } from "../src/core/session/token.js";
import { checkTokenBinding } from "../src/core/token/binding.js";
import { createVelveAuth, type SecurityStateReport, type VelveAuth } from "../src/index.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { configFor, TEST_ORIGIN } from "./auth-fixtures.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { generateRootKey } from "./keys-fixtures.js";
import { drawTestPassword } from "./password-fixtures.js";
import { sealDirectly } from "./security-state-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

//a root key rotation ends no session once the maintenance step has rebound everything (T-KEY-5, S-KEY-5)

const PASSWORD = drawTestPassword();
const ONE_TOTP_STEP_IN_MILLISECONDS = 30_000;
const firstRootKey = generateRootKey();
const secondRootKey = generateRootKey();
const ringV1 = (): KeyProvider =>
	rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: firstRootKey } });
const ringV2V1 = (): KeyProvider =>
	rootKeyProvider({ currentVersion: 2, keysByVersion: { 1: firstRootKey, 2: secondRootKey } });
const ringV2 = (): KeyProvider =>
	rootKeyProvider({ currentVersion: 2, keysByVersion: { 2: secondRootKey } });

let connection: TestConnection;
let schema: string;
let clock: TestClock;
const alarms: SecurityStateAlarm[] = [];

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("key_rotation_maintenance"));
	clock = createTestClock();
}, 60_000);

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
			securityState: { sealing: "required", alarm: (alarm) => alarms.push(alarm) },
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		}),
	);
	await auth.migrate();
	return auth;
}

function codeNow(secretBase32: string): string {
	clock.advanceBy(2 * ONE_TOTP_STEP_IN_MILLISECONDS);
	return totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now()));
}

async function signInWithTotp(
	auth: VelveAuth<"email">,
	email: string,
	secretBase32: string,
): Promise<string> {
	const begun = await auth.signIn.password({ email, password: PASSWORD, origin: TEST_ORIGIN });
	if (begun.status !== "second_factor_required") {
		throw new Error(`the account offers a second factor and was answered ${begun.status}`);
	}
	const verified = await auth.factor.totp.verify({
		code: codeNow(secretBase32),
		origin: TEST_ORIGIN,
		pendingToken: begun.pendingToken,
	});
	return verified.status;
}

async function keyVersionsOf(table: string): Promise<readonly number[]> {
	const rows = await connection.query<{ version: number }>(
		`SELECT DISTINCT key_version AS version FROM ${schema}.${table} ORDER BY 1`,
		[],
	);
	return rows.map((row) => Number(row.version));
}

async function delivered(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("T-KEY-5 with the maintenance step (S-KEY-5)", () => {
	it("keeps the session, the secret and the sign-in through both steps: 8/8 assertions", async () => {
		const processA = await restartWith(ringV1());
		const processB = await restartWith(ringV1());
		const first = await processA.signUp.withPassword({
			email: "first@example.com",
			password: PASSWORD,
			origin: TEST_ORIGIN,
		});
		const { secretBase32 } = await processA.factor.totp.enroll.start({
			origin: TEST_ORIGIN,
			sessionToken: first.sessionToken,
		});
		await processA.factor.totp.enroll.finish({
			code: codeNow(secretBase32),
			origin: TEST_ORIGIN,
			sessionToken: first.sessionToken,
		});

		const restartedA = await restartWith(ringV2V1());
		const writtenUnderV1 = await processB.signUp.withPassword({
			email: "written-under-v1@example.com",
			password: PASSWORD,
			origin: TEST_ORIGIN,
		});
		const restartedB = await restartWith(ringV2V1());
		const third = await restartedB.signUp.withPassword({
			email: "third@example.com",
			password: PASSWORD,
			origin: TEST_ORIGIN,
		});

		const resolvedAfterStepOne = await restartedA.session.resolve({
			origin: TEST_ORIGIN,
			sessionToken: first.sessionToken,
		});
		const secretOpensAfterStepOne = await signInWithTotp(
			restartedA,
			"first@example.com",
			secretBase32,
		);
		const [thirdRows] = await connection.query<{ password: number; seal: number }>(
			`SELECT p.key_version AS password, s.key_version AS seal
			 FROM ${schema}.password_credential p JOIN ${schema}.security_state s USING (user_id)
			 WHERE p.user_id = $1`,
			[third.user.id],
		);

		const forged = createSessionToken();
		await connection.query(
			`INSERT INTO ${schema}.session (id, token_sha256, user_id, factors, idle_expires_at, absolute_expires_at, token_mac, token_mac_key_version)
			 VALUES ($1, $2, $3, '{password}', now() + interval '1 day', now() + interval '2 days', $4, 1)`,
			[randomUUID(), forged.tokenHash, writtenUnderV1.user.id, randomBytes(32)],
		);
		let report: SecurityStateReport | null = null;
		for (let run = 0; run < 3; run += 1) {
			report = await restartedA.maintenance.sealSecurityState();
			const underV1 = report.rowsByKeyVersion[1];
			if (underV1 === undefined || (underV1.seals === 0 && underV1.tokens === 0)) {
				break;
			}
		}
		const sealVersions = await keyVersionsOf("security_state");

		const afterRotation = await restartWith(ringV2());
		alarms.length = 0;
		const resolvedAfterStepTwo = await afterRotation.session.resolve({
			origin: TEST_ORIGIN,
			sessionToken: first.sessionToken,
		});
		const signInAfterStepTwo = await signInWithTotp(
			afterRotation,
			"first@example.com",
			secretBase32,
		);
		const forgedResolved = await afterRotation.session.resolve({
			origin: TEST_ORIGIN,
			sessionToken: forged.token,
		});
		const [forgedRow] = await connection.query<{
			id: string;
			mac: Uint8Array;
			created_us: string;
		}>(
			`SELECT id, token_mac AS mac, trunc(extract(epoch FROM created_at) * 1000000)::text AS created_us
			 FROM ${schema}.session WHERE token_sha256 = $1`,
			[forged.tokenHash],
		);
		const forgedVerdict = await checkTokenBinding(
			ringV2(),
			sessionBinding(writtenUnderV1.user.id, forged.tokenHash, ["password"], {
				sessionId: forgedRow?.id ?? "",
				sessionEpoch: 1,
				createdAtMicros: Number(forgedRow?.created_us),
			}),
			{ tokenMac: new Uint8Array(forgedRow?.mac ?? []), tokenMacKeyVersion: 1 },
		);
		await delivered();

		const assertions = {
			sessionAfterStepOne: resolvedAfterStepOne?.user.id === first.user.id,
			secretOpensAfterStepOne: secretOpensAfterStepOne === "signed_in",
			newValuesUnderV2: thirdRows?.password === 2 && thirdRows?.seal === 2,
			sessionAfterStepTwo: resolvedAfterStepTwo?.user.id === first.user.id,
			passwordSignInAfterStepTwo: signInAfterStepTwo === "signed_in",
			everySealUnderV2: sealVersions.length === 1 && sealVersions[0] === 2,
			reportEmptiesV1:
				report?.rowsByKeyVersion[1]?.seals === 0 &&
				report.rowsByKeyVersion[1]?.tokens === 0 &&
				report.rowsByKeyVersion[1]?.traces === 1,
			traceRefusedAsUnknownVersion:
				forgedResolved === null &&
				forgedVerdict === "key_version_unknown" &&
				alarms.some(
					(alarm) =>
						alarm.userId === writtenUnderV1.user.id && alarm.reason === "token_binding_mismatch",
				),
		};
		expect(assertions).toStrictEqual({
			sessionAfterStepOne: true,
			secretOpensAfterStepOne: true,
			newValuesUnderV2: true,
			sessionAfterStepTwo: true,
			passwordSignInAfterStepTwo: true,
			everySealUnderV2: true,
			reportEmptiesV1: true,
			traceRefusedAsUnknownVersion: true,
		});
	}, 120_000);

	//a seal over no envelope keeps its old key until the sealing path rewrites unchanged components (E-3178)
	it.fails("rewrites the seal of an account without any envelope under the new version", async () => {
		const userId = await createUser(connection, schema);
		await sealDirectly(connection, schema, ringV1(), userId);
		const during = await restartWith(ringV2V1());

		await during.maintenance.sealSecurityState();

		const [row] = await connection.query<{ key_version: number }>(
			`SELECT key_version FROM ${schema}.security_state WHERE user_id = $1`,
			[userId],
		);
		expect(Number(row?.key_version)).toBe(2);
	});
});
