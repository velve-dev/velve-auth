import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCodeForStep } from "../src/core/factor/totp/code.js";
import { TOTP_PERIOD_SECONDS, timeStepAt } from "../src/core/factor/totp/parameters.js";
import {
	MAXIMUM_FACTOR_ATTEMPTS_PER_PENDING_STATE,
	spendPendingAttemptOn,
} from "../src/core/factor/totp/pending-attempt.js";
import { createTotpService, type TotpService } from "../src/core/factor/totp/service.js";
import { ConcealedError, toVisibleFailure, VelveError } from "../src/core/http/error-map.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import {
	countingAttempt,
	countRows,
	createPendingState,
	secretBytesOfBase32,
	type SettableClock,
	settableClock,
	testKeyProvider,
} from "./totp-fixtures.js";

const FIXED_INSTANT = new Date("2026-07-01T12:00:00.000Z");

let connection: TestConnection;
let schema: string;
let clock: SettableClock;
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
	clock = settableClock(FIXED_INSTANT);
	totp = createTotpService({
		driver: connection,
		schema,
		keys: testKeyProvider(),
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
 * because a limit nobody checks is a limit nobody has.
 */
describe("L-8: five attempts per pending state, then the row is gone", () => {
	it("allows exactly five and answers the fifth with too_many_factor_attempts", async () => {
		const account = await enrolAnAccount("locked@example.com");
		const pending = await createPendingState(connection, schema, account.userId);

		const statuses: number[] = [];
		const codes: string[] = [];
		for (let attempt = 1; attempt <= MAXIMUM_FACTOR_ATTEMPTS_PER_PENDING_STATE; attempt += 1) {
			const failure = await totp
				.verify({ attempt: pending, code: "000000" })
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
		expect(await pending.attemptsRecorded()).toBeNull();
		expect(await countRows(connection, schema, "pending_authentication", account.userId)).toBe(0);
	});

	it("counts every attempt in the row, so the count is not held in the process", async () => {
		const account = await enrolAnAccount("counted@example.com");
		const pending = await createPendingState(connection, schema, account.userId);

		await totp.verify({ attempt: pending, code: "000000" }).catch(() => undefined);
		expect(await pending.attemptsRecorded()).toBe(1);
		await totp.verify({ attempt: pending, code: "000000" }).catch(() => undefined);
		expect(await pending.attemptsRecorded()).toBe(2);
	});

	it("spends an attempt on a correct code as well, and leaves the state for its caller to consume", async () => {
		const account = await enrolAnAccount("correct@example.com");
		const pending = await createPendingState(connection, schema, account.userId);
		clock.advanceSeconds(TOTP_PERIOD_SECONDS);

		await totp.verify({
			attempt: pending,
			code: totpCodeForStep(account.secretBytes, timeStepAt(clock.now())),
		});

		expect(await pending.attemptsRecorded()).toBe(1);
	});

	it("answers a pending state that is gone as invalid_pending_authentication", async () => {
		const account = await enrolAnAccount("expired@example.com");
		const pending = await createPendingState(connection, schema, account.userId);
		await pending.discard();

		const failure = await totp
			.verify({ attempt: pending, code: "000000" })
			.catch((cause: unknown) => toVisibleFailure(cause));
		expect(failure?.error.code).toBe("invalid_pending_authentication");
		expect(failure?.error.httpStatus).toBe(401);
		expect(failure?.loggedReason).toBe("pending_not_found");
	});

	it("does not raise the counter past the limit on a state that expired mid-flight", async () => {
		const account = await enrolAnAccount("stale@example.com");
		const pending = await createPendingState(connection, schema, account.userId, -1);

		await expect(totp.verify({ attempt: pending, code: "000000" })).rejects.toBeInstanceOf(
			ConcealedError,
		);
		expect(await pending.attemptsRecorded()).toBe(0);
	});
});

describe("the attempt policy is the same one for every factor of the pending state", () => {
	it("passes the result of the verification through when the budget is not spent", async () => {
		const attempt = countingAttempt("00000000-0000-0000-0000-000000000000");
		await expect(spendPendingAttemptOn(attempt, async () => "verified")).resolves.toBe("verified");
		expect(attempt.spent).toEqual([1]);
		expect(attempt.discarded()).toBe(0);
	});

	it("re-raises the verification's own failure below the limit and discards nothing", async () => {
		const attempt = countingAttempt("00000000-0000-0000-0000-000000000000");
		const raised = new ConcealedError("recovery_code_not_found");
		await expect(
			spendPendingAttemptOn(attempt, () => Promise.reject(raised)),
		).rejects.toBe(raised);
		expect(attempt.discarded()).toBe(0);
	});

	it("replaces the failure with too_many_factor_attempts on the attempt that exhausts the budget", async () => {
		const attempt = countingAttempt(
			"00000000-0000-0000-0000-000000000000",
			MAXIMUM_FACTOR_ATTEMPTS_PER_PENDING_STATE - 1,
		);
		await expect(
			spendPendingAttemptOn(attempt, () =>
				Promise.reject(new ConcealedError("recovery_code_not_found")),
			),
		).rejects.toEqual(new VelveError("too_many_factor_attempts"));
		expect(attempt.discarded()).toBe(1);
	});

	it("keeps five as the number the specification names", () => {
		expect(MAXIMUM_FACTOR_ATTEMPTS_PER_PENDING_STATE).toBe(5);
	});
});
