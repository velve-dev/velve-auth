import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import type { PendingAuthenticationService } from "../src/core/factor/pending/index.js";
import { totpCodeForStep } from "../src/core/factor/totp/code.js";
import { TOTP_PERIOD_SECONDS, timeStepAt } from "../src/core/factor/totp/parameters.js";
import { createTotpService, type TotpService } from "../src/core/factor/totp/service.js";
import { toVisibleFailure } from "../src/core/http/error-map.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import {
	beginPendingState,
	pendingAuthenticationsOn,
	readUsedSteps,
	secretBytesOfBase32,
	testKeyProvider,
} from "./totp-fixtures.js";

const FIXED_INSTANT = new Date("2026-02-17T09:14:22.000Z");
const PERIOD_IN_MILLISECONDS = TOTP_PERIOD_SECONDS * 1000;

let connection: TestConnection;
let schema: string;
let clock: TestClock;
let pending: PendingAuthenticationService;
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
	const { token } = await beginPendingState(pending, account.userId);
	try {
		await totp.verify({
			pendingToken: token,
			code: totpCodeForStep(account.secretBytes, step),
		});
		return 200;
	} catch (failure) {
		return toVisibleFailure(failure).error.httpStatus;
	} finally {
		await pending.cancel({ token });
	}
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("totp_replay");
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

describe("T-REPLAY-4: one code per user and time step (S-REPLAY-4)", () => {
	it("answers 200, 401, 200, 200, 401 under a fixed clock", async () => {
		const account = await enrolAnAccount("reader@example.com");

		clock.advanceBy(PERIOD_IN_MILLISECONDS);
		const firstStep = account.enrolmentStep + 1;
		const statuses = [await submit(account, firstStep), await submit(account, firstStep)];

		clock.advanceBy(PERIOD_IN_MILLISECONDS);
		const secondStep = firstStep + 1;
		statuses.push(await submit(account, secondStep));

		/* The clock stands in `secondStep` and the code belongs to the step after it, which the
		   tolerance of one step accepts. It is the case S-REPLAY-4's second clause exists for:
		   what the guard records has to be that step and not the one the clock is in (E-407). */
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
		clock.advanceBy(PERIOD_IN_MILLISECONDS * 3);

		const standingIn = timeStepAt(clock.now());
		const oneStepBehind = standingIn - 1;
		expect(await submit(account, oneStepBehind)).toBe(200);

		const recorded = await readUsedSteps(connection, schema, account.userId);
		expect(recorded).toEqual([account.enrolmentStep, oneStepBehind]);
		expect(recorded).not.toContain(standingIn);
	});

	it("refuses a code from the tolerance window whose step is already spent", async () => {
		const account = await enrolAnAccount("third@example.com");
		clock.advanceBy(PERIOD_IN_MILLISECONDS);

		const { token } = await beginPendingState(pending, account.userId);
		await expect(
			totp.verify({
				pendingToken: token,
				code: totpCodeForStep(account.secretBytes, account.enrolmentStep),
			}),
		).rejects.toMatchObject({ reason: "totp_step_replayed" });
	});

	it("writes nothing to the guard when the code does not match", async () => {
		const account = await enrolAnAccount("fourth@example.com");
		const before = await readUsedSteps(connection, schema, account.userId);

		const { token } = await beginPendingState(pending, account.userId);
		await expect(totp.verify({ pendingToken: token, code: "000000" })).rejects.toMatchObject({
			reason: "totp_code_wrong",
		});

		expect(await readUsedSteps(connection, schema, account.userId)).toEqual(before);
	});

	it("tells a replayed step from a wrong code only in the log, never in the answer", async () => {
		const account = await enrolAnAccount("fifth@example.com");
		clock.advanceBy(PERIOD_IN_MILLISECONDS);

		const replayed = await totp
			.verify({
				pendingToken: (await beginPendingState(pending, account.userId)).token,
				code: totpCodeForStep(account.secretBytes, account.enrolmentStep),
			})
			.then(() => null)
			.catch((failure: unknown) => toVisibleFailure(failure));
		const wrong = await totp
			.verify({
				pendingToken: (await beginPendingState(pending, account.userId)).token,
				code: "000000",
			})
			.then(() => null)
			.catch((failure: unknown) => toVisibleFailure(failure));

		expect(replayed?.error.code).toBe("invalid_factor_code");
		expect(replayed?.error.code).toBe(wrong?.error.code);
		expect(replayed?.error.message).toBe(wrong?.error.message);
		expect(replayed?.loggedReason).toBe("totp_step_replayed");
		expect(wrong?.loggedReason).toBe("totp_code_wrong");
	});

	it("hands back the resolved account without consuming the pending row (E-410)", async () => {
		const account = await enrolAnAccount("handback@example.com");
		clock.advanceBy(PERIOD_IN_MILLISECONDS);

		const { token } = await beginPendingState(pending, account.userId);
		const resolution = await totp.verify({
			pendingToken: token,
			code: totpCodeForStep(account.secretBytes, timeStepAt(clock.now())),
		});

		expect(resolution.userId).toBe(account.userId);
		expect(await pending.resolve(token)).not.toBeNull();
	});
});
