import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PendingAuthenticationService } from "../src/core/factor/pending/index.js";
import {
	createTotpService,
	TOTP_PERIOD_SECONDS,
	type TotpService,
	timeStepAt,
	totpCodeForStep,
} from "../src/core/factor/totp/index.js";
import { toVisibleFailure } from "../src/core/http/error-map.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import {
	beginPendingState,
	pendingAuthenticationsOn,
	secretBytesOfBase32,
	testKeyProvider,
	testKeyRing,
} from "./totp-fixtures.js";

const FIXED_INSTANT = new Date("2026-08-19T05:05:00.000Z");

let connection: TestConnection;
let schema: string;
let clock: TestClock;
let pending: PendingAuthenticationService;
let totp: TotpService;

interface Answer {
	readonly code: string;
	readonly message: string;
	readonly httpStatus: number;
	readonly loggedReason: string;
}

async function answerFor(userId: string, submitted: string): Promise<Answer> {
	const { token } = await beginPendingState(pending, userId);
	try {
		await totp.verify({ pendingToken: token, code: submitted });
		return { code: "accepted", message: "", httpStatus: 200, loggedReason: "accepted" };
	} catch (failure) {
		const visible = toVisibleFailure(failure);
		return {
			code: visible.error.code,
			message: visible.error.message,
			httpStatus: visible.error.httpStatus,
			loggedReason: visible.loggedReason,
		};
	}
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("totp_conceal");
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
 * The verifying route is reached with a pending state, and the account it names may be one an
 * attacker chose. Anything that distinguishes "this account has no TOTP" from "that code is
 * wrong" says which accounts carry a second factor (S-ENUM-2's shape, on a route of its own).
 */
describe("the verify path tells nothing about whether the factor exists", () => {
	it("answers a missing credential, an unconfirmed one, a wrong code and a spent step alike", async () => {
		const missing = await createUser(connection, schema);

		const unconfirmedId = await createUser(connection, schema);
		await totp.enroll.start({
			actor: actorOfTestUser(unconfirmedId),
			accountName: "unconfirmed@example.com",
		});

		const enrolledId = await createUser(connection, schema);
		const enrolledActor = actorOfTestUser(enrolledId);
		const enrollment = await totp.enroll.start({
			actor: enrolledActor,
			accountName: "enrolled@example.com",
		});
		const secretBytes = secretBytesOfBase32(enrollment.secretBase32);
		const enrolmentStep = timeStepAt(clock.now());
		await totp.enroll.finish({
			actor: enrolledActor,
			code: totpCodeForStep(secretBytes, enrolmentStep),
		});
		clock.advanceBy(TOTP_PERIOD_SECONDS * 1000);

		const answers = [
			await answerFor(missing, "000000"),
			await answerFor(unconfirmedId, "000000"),
			await answerFor(enrolledId, "000000"),
			await answerFor(enrolledId, totpCodeForStep(secretBytes, enrolmentStep)),
		];

		for (const answer of answers) {
			expect(answer.code).toBe("invalid_factor_code");
			expect(answer.httpStatus).toBe(401);
			expect(answer.message).toBe(answers[0]?.message);
		}

		expect(answers.map((answer) => answer.loggedReason)).toEqual([
			"totp_not_confirmed",
			"totp_not_confirmed",
			"totp_code_wrong",
			"totp_step_replayed",
		]);
	});

	it("never raises factor_not_enrolled from the verifying path, which does not declare it", async () => {
		const missing = await createUser(connection, schema);
		const answer = await answerFor(missing, "000000");

		expect(answer.code).not.toBe("factor_not_enrolled");
		expect(answer.httpStatus).not.toBe(409);
	});

	/**
	 * S-KEY-4's error is named at the throw site and was lost at the boundary: `KeyError` is neither
	 * a `VelveError` nor a `ConcealedError`, so it reached the caller as 500 — a status the route
	 * declaration does not carry (3.15 D.3) and one that only accounts whose secret predates a
	 * rotation could produce (E-428).
	 */
	it("answers a secret it cannot read the way it answers a wrong code", async () => {
		const ring = testKeyRing(2);
		const underVersionOne = createTotpService({
			driver: connection,
			schema,
			keys: ring.providerAt(1, [1]),
			pending,
			issuer: "Velve",
			clock,
		});
		const afterTheVersionWasDropped = createTotpService({
			driver: connection,
			schema,
			keys: ring.providerAt(2, [2]),
			pending,
			issuer: "Velve",
			clock,
		});

		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);
		const enrollment = await underVersionOne.enroll.start({
			actor,
			accountName: "rotated@example.com",
		});
		await underVersionOne.enroll.finish({
			actor,
			code: totpCodeForStep(secretBytesOfBase32(enrollment.secretBase32), timeStepAt(clock.now())),
		});

		const { token } = await beginPendingState(pending, userId);
		const unreadable = await afterTheVersionWasDropped
			.verify({ pendingToken: token, code: "000000" })
			.then(() => null)
			.catch((failure: unknown) => toVisibleFailure(failure));

		expect(unreadable?.error.code).toBe("invalid_factor_code");
		expect(unreadable?.error.httpStatus).toBe(401);
		expect(unreadable?.error.message).toBe("The code is not valid.");
		expect(unreadable?.loggedReason).not.toBe("unhandled_exception");
	});

	it("answers the same on the two paths a session reaches, so no route gains a 500", async () => {
		const ring = testKeyRing(2);
		const underVersionOne = createTotpService({
			driver: connection,
			schema,
			keys: ring.providerAt(1, [1]),
			pending,
			issuer: "Velve",
			clock,
		});
		const afterTheVersionWasDropped = createTotpService({
			driver: connection,
			schema,
			keys: ring.providerAt(2, [2]),
			pending,
			issuer: "Velve",
			clock,
		});

		const confirmed = actorOfTestUser(await createUser(connection, schema));
		const started = await underVersionOne.enroll.start({
			actor: confirmed,
			accountName: "removing@example.com",
		});
		await underVersionOne.enroll.finish({
			actor: confirmed,
			code: totpCodeForStep(secretBytesOfBase32(started.secretBase32), timeStepAt(clock.now())),
		});

		const unconfirmed = actorOfTestUser(await createUser(connection, schema));
		await underVersionOne.enroll.start({
			actor: unconfirmed,
			accountName: "confirming@example.com",
		});

		const onRemove = await afterTheVersionWasDropped
			.remove({ actor: confirmed, code: "000000" })
			.then(() => null)
			.catch((failure: unknown) => toVisibleFailure(failure));
		const onFinish = await afterTheVersionWasDropped.enroll
			.finish({ actor: unconfirmed, code: "000000" })
			.then(() => null)
			.catch((failure: unknown) => toVisibleFailure(failure));

		for (const answer of [onRemove, onFinish]) {
			expect(answer?.error.code).toBe("invalid_factor_code");
			expect(answer?.error.httpStatus).toBe(401);
			expect(answer?.loggedReason).not.toBe("unhandled_exception");
		}
	});

	it("still names factor_not_enrolled where a session proves the account (3.15 B.6)", async () => {
		const actor = actorOfTestUser(await createUser(connection, schema));

		await expect(totp.remove({ actor, code: "000000" })).rejects.toMatchObject({
			code: "factor_not_enrolled",
		});
		await expect(totp.enroll.finish({ actor, code: "000000" })).rejects.toMatchObject({
			code: "factor_not_enrolled",
		});
	});
});
