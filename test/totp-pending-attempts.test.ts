import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	MAXIMUM_PENDING_ATTEMPTS,
	PENDING_CALLER_ROUTES,
	type PendingAuthenticationService,
} from "../src/core/factor/pending/index.js";
import { totpCodeForStep } from "../src/core/factor/totp/code.js";
import { TOTP_PERIOD_SECONDS, timeStepAt } from "../src/core/factor/totp/parameters.js";
import { createTotpService, type TotpService } from "../src/core/factor/totp/service.js";
import { toVisibleFailure } from "../src/core/http/error-map.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import {
	attemptsRecorded,
	beginPendingState,
	countRows,
	pendingAuthenticationsOn,
	secretBytesOfBase32,
	testKeyProvider,
} from "./totp-fixtures.js";

const FIXED_INSTANT = new Date("2026-07-01T12:00:00.000Z");

let connection: TestConnection;
let schema: string;
let clock: TestClock;
let pending: PendingAuthenticationService;
let totp: TotpService;

async function enrolAnAccount(accountName: string) {
	const userId = await createUser(connection, schema);
	const actor = actorOfTestUser(userId);
	const enrollment = await totp.enroll.start({ actor, accountName });
	const secretBytes = secretBytesOfBase32(enrollment.secretBase32);
	await totp.enroll.finish({ actor, code: totpCodeForStep(secretBytes, timeStepAt(clock.now())) });
	return { userId, secretBytes };
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("totp_attempts");
	connection = migrated.connection;
	schema = migrated.schema;
	clock = createTestClock(FIXED_INSTANT);
	pending = pendingAuthenticationsOn(connection, schema);
	totp = createTotpService({
		driver: connection,
		schema,
		keys: testKeyProvider(),
		pending,
		issuer: "Velve",
		clock,
	});
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

/**
 * L-8 has no `T-` case in the test plan of architecture section 6. It is tested here anyway,
 * because a limit nobody checks is a limit nobody has. The number comes from the pending module,
 * so a change there fails this file rather than passing against a second copy of the five.
 */
describe("L-8: the permitted attempts per pending state, and then the row is gone", () => {
	it("answers the attempt that exhausts the budget with too_many_factor_attempts", async () => {
		const account = await enrolAnAccount("locked@example.com");
		const { token } = await beginPendingState(pending, account.userId);

		const statuses: number[] = [];
		const codes: string[] = [];
		for (let attempt = 1; attempt <= MAXIMUM_PENDING_ATTEMPTS; attempt += 1) {
			const failure = await totp
				.verify({ pendingToken: token, code: "000000" })
				.then(() => null)
				.catch((cause: unknown) => toVisibleFailure(cause));
			statuses.push(failure?.error.httpStatus ?? 200);
			codes.push(failure?.error.code ?? "accepted");
		}

		expect(statuses).toEqual([401, 401, 401, 401, 429]);
		expect(codes).toEqual([
			"invalid_factor_code",
			"invalid_factor_code",
			"invalid_factor_code",
			"invalid_factor_code",
			"too_many_factor_attempts",
		]);
		expect(await attemptsRecorded(connection, schema, account.userId)).toBeNull();
		expect(await countRows(connection, schema, "pending_authentication", account.userId)).toBe(0);
	});

	it("counts every failed attempt in the row, so the count is not held in the process", async () => {
		const account = await enrolAnAccount("counted@example.com");
		const { token } = await beginPendingState(pending, account.userId);

		await totp.verify({ pendingToken: token, code: "000000" }).catch(() => undefined);
		expect(await attemptsRecorded(connection, schema, account.userId)).toBe(1);
		await totp.verify({ pendingToken: token, code: "000000" }).catch(() => undefined);
		expect(await attemptsRecorded(connection, schema, account.userId)).toBe(2);
	});

	it("spends no attempt on a correct code", async () => {
		const account = await enrolAnAccount("correct@example.com");
		const { token } = await beginPendingState(pending, account.userId);
		clock.advanceBy(TOTP_PERIOD_SECONDS * 1000);

		await totp.verify({
			pendingToken: token,
			code: totpCodeForStep(account.secretBytes, timeStepAt(clock.now())),
		});

		expect(await attemptsRecorded(connection, schema, account.userId)).toBe(0);
	});

	it("answers a pending state that is gone as invalid_pending_authentication", async () => {
		const account = await enrolAnAccount("cancelled@example.com");
		const { token } = await beginPendingState(pending, account.userId);
		await pending.cancel({ token });

		const failure = await totp
			.verify({ pendingToken: token, code: "000000" })
			.then(() => null)
			.catch((cause: unknown) => toVisibleFailure(cause));

		expect(failure?.error.code).toBe("invalid_pending_authentication");
		expect(failure?.error.httpStatus).toBe(401);
		expect(failure?.loggedReason).toBe("pending_not_found");
	});

	it("reads the account out of the pending state and never out of the request", async () => {
		const owner = await enrolAnAccount("owner@example.com");
		const stranger = await enrolAnAccount("stranger@example.com");
		const { token } = await beginPendingState(pending, owner.userId);
		clock.advanceBy(TOTP_PERIOD_SECONDS * 1000);

		await expect(
			totp.verify({
				pendingToken: token,
				code: totpCodeForStep(stranger.secretBytes, timeStepAt(clock.now())),
			}),
		).rejects.toMatchObject({ reason: "totp_code_wrong" });
	});

	it("names both verifying routes among the four that read the cookie (3.6)", () => {
		expect(PENDING_CALLER_ROUTES).toHaveLength(4);
		expect(PENDING_CALLER_ROUTES).toContain("factor.totp.verify");
		expect(PENDING_CALLER_ROUTES).toContain("factor.recovery.verify");
	});
});
