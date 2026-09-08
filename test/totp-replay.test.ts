import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import { totpCodeForStep } from "../src/core/factor/totp/code.js";
import { TOTP_PERIOD_SECONDS, timeStepAt } from "../src/core/factor/totp/parameters.js";
import { createTotpService, type TotpService } from "../src/core/factor/totp/service.js";
import { toVisibleFailure } from "../src/core/http/error-map.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import {
	countingAttempt,
	createPendingState,
	readUsedSteps,
	secretBytesOfBase32,
	type SettableClock,
	settableClock,
	testKeyProvider,
} from "./totp-fixtures.js";

const FIXED_INSTANT = new Date("2026-02-17T09:14:22.000Z");

let connection: TestConnection;
let schema: string;
let clock: SettableClock;
let totp: TotpService;

interface EnrolledAccount {
	readonly userId: string;
	readonly actor: Actor;
	readonly secretBytes: Uint8Array<ArrayBuffer>;
	readonly enrolmentStep: number;
}

async function enrolAnAccount(accountName: string): Promise<EnrolledAccount> {
	const userId = await createUser(connection, schema);
	const actor = actorOfTestUser(userId);
	const enrollment = await totp.enroll.start({ actor, accountName });
	const secretBytes = secretBytesOfBase32(enrollment.secretBase32);
	const enrolmentStep = timeStepAt(clock.now());
	await totp.enroll.finish({ actor, code: totpCodeForStep(secretBytes, enrolmentStep) });
	return { userId, actor, secretBytes, enrolmentStep };
}

/** The status a route would answer with, so the plan's "200, 401" reads the way the plan writes it. */
async function submit(account: EnrolledAccount, step: number): Promise<number> {
	try {
		await totp.verify({
			attempt: countingAttempt(account.userId),
			code: totpCodeForStep(account.secretBytes, step),
		});
		return 200;
	} catch (failure) {
		return toVisibleFailure(failure).error.httpStatus;
	}
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("totp_replay");
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

describe("T-REPLAY-4: one code per user and time step (S-REPLAY-4)", () => {
	it("answers 200, 401, 200, 200, 401 under a fixed clock", async () => {
		const account = await enrolAnAccount("reader@example.com");

		clock.advanceSeconds(TOTP_PERIOD_SECONDS);
		const firstStep = account.enrolmentStep + 1;
		const statuses = [await submit(account, firstStep), await submit(account, firstStep)];

		clock.advanceSeconds(TOTP_PERIOD_SECONDS);
		const secondStep = firstStep + 1;
		statuses.push(await submit(account, secondStep));

		/* The clock stands in `secondStep` and the code belongs to the step after it, which the
		   tolerance of one step accepts. It is the case S-REPLAY-4's second clause exists for:
		   what the guard records has to be that step and not the one the clock is in. */
		const toleratedStep = secondStep + 1;
		statuses.push(await submit(account, toleratedStep));
		statuses.push(await submit(account, toleratedStep));

		expect(statuses).toEqual([200, 401, 200, 200, 401]);
		expect(await readUsedSteps(connection, schema, account.userId)).toEqual([
			account.enrolmentStep,
			firstStep,
			secondStep,
			toleratedStep,
		]);
	});

	it("records the step that matched and not the step the clock is in", async () => {
		const account = await enrolAnAccount("second@example.com");
		clock.advanceSeconds(TOTP_PERIOD_SECONDS * 3);

		const standingIn = timeStepAt(clock.now());
		const oneStepBehind = standingIn - 1;
		expect(await submit(account, oneStepBehind)).toBe(200);

		const recorded = await readUsedSteps(connection, schema, account.userId);
		expect(recorded).toEqual([account.enrolmentStep, oneStepBehind]);
		expect(recorded).not.toContain(standingIn);
	});

	it("refuses a code from the tolerance window whose step is already spent", async () => {
		const account = await enrolAnAccount("third@example.com");
		clock.advanceSeconds(TOTP_PERIOD_SECONDS);

		await expect(
			totp.verify({
				attempt: countingAttempt(account.userId),
				code: totpCodeForStep(account.secretBytes, account.enrolmentStep),
			}),
		).rejects.toMatchObject({ reason: "totp_step_replayed" });
	});

	it("writes nothing to the guard when the code does not match", async () => {
		const account = await enrolAnAccount("fourth@example.com");
		const before = await readUsedSteps(connection, schema, account.userId);

		const pending = await createPendingState(connection, schema, account.userId);
		await expect(totp.verify({ attempt: pending, code: "000000" })).rejects.toMatchObject({
			reason: "totp_code_wrong",
		});

		expect(await readUsedSteps(connection, schema, account.userId)).toEqual(before);
	});

	it("tells a replayed step from a wrong code only in the log, never in the answer", async () => {
		const account = await enrolAnAccount("fifth@example.com");
		clock.advanceSeconds(TOTP_PERIOD_SECONDS);

		const replayed = await totp
			.verify({
				attempt: countingAttempt(account.userId),
				code: totpCodeForStep(account.secretBytes, account.enrolmentStep),
			})
			.catch((failure: unknown) => toVisibleFailure(failure));
		const wrong = await totp
			.verify({ attempt: countingAttempt(account.userId), code: "000000" })
			.catch((failure: unknown) => toVisibleFailure(failure));

		expect(replayed).toBeDefined();
		expect(wrong).toBeDefined();
		expect(replayed?.error.code).toBe("invalid_factor_code");
		expect(replayed?.error.code).toBe(wrong?.error.code);
		expect(replayed?.error.message).toBe(wrong?.error.message);
		expect(replayed?.loggedReason).toBe("totp_step_replayed");
		expect(wrong?.loggedReason).toBe("totp_code_wrong");
	});
});
