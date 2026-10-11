import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createPendingAuthenticationService,
	MAXIMUM_PENDING_ATTEMPTS,
	type PendingAuthenticationService,
	verifyUnderPendingAttemptLimit,
} from "../src/core/factor/pending/index.js";
import {
	createTotpService,
	type TotpService,
	timeStepAt,
	totpCodeForStep,
} from "../src/core/factor/totp/index.js";
import { toVisibleFailure } from "../src/core/http/error-map.js";
import type { TokenBindingRefusal } from "../src/core/token/binding.js";
import { createTestClock } from "../src/testing/index.js";
import { openConnectionPool } from "./connection-pool-fixtures.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { testSecurityState } from "./security-state-fixtures.js";
import { secretBytesOfBase32, testKeyProvider } from "./totp-fixtures.js";

/**
 * L-8 and S-INTEG-9 together: an attempt is booked before the factor is evaluated (E-3140), so
 * guesses that arrive at once on one pending state are evaluated at most as often as the budget
 * allows, and the orderings between them raise no alarm. Nothing here writes to the database past
 * the library.
 */

const GUESSES = 40;

let migrated: Awaited<ReturnType<typeof openMigratedSchema>>;
let pool: Awaited<ReturnType<typeof openConnectionPool>>;
let refusals: TokenBindingRefusal[];
let pending: PendingAuthenticationService;
let totp: TotpService;

beforeAll(async () => {
	migrated = await openMigratedSchema("pending_booking_race");
	pool = await openConnectionPool(GUESSES);
	const keys = testKeyProvider();
	pending = createPendingAuthenticationService({
		driver: pool,
		keys,
		schema: migrated.schema,
		reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
	});
	totp = createTotpService({
		securityState: testSecurityState(pool, migrated.schema, keys),
		driver: pool,
		schema: migrated.schema,
		keys,
		pending,
		issuer: "Velve",
		clock: createTestClock(new Date("2026-07-01T12:00:00.000Z")),
	});
}, 60_000);

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await pool.close();
	await migrated.connection.close();
});

async function pendingRowOf(userId: string): Promise<{ attempts: number } | undefined> {
	const [row] = await migrated.connection.query<{ attempts: number }>(
		`SELECT attempts FROM ${migrated.schema}.pending_authentication WHERE user_id = $1`,
		[userId],
	);
	return row;
}

describe("guesses that arrive together on one pending state (L-8, S-INTEG-9)", () => {
	it("evaluates exactly the budget, removes the row and raises no alarm", async () => {
		const userId = await createUser(migrated.connection, migrated.schema);
		const { token } = await pending.begin({ userId, factorsCompleted: ["password"] });
		refusals = [];
		let evaluated = 0;

		const answers = await Promise.all(
			Array.from({ length: GUESSES }, () =>
				verifyUnderPendingAttemptLimit(pending, token, async () => {
					evaluated += 1;
					throw new Error("a wrong code");
				}).catch((failure: unknown) =>
					failure instanceof Error && failure.message === "a wrong code"
						? "wrong"
						: toVisibleFailure(failure).error.code,
				),
			),
		);

		expect(evaluated).toBe(MAXIMUM_PENDING_ATTEMPTS);
		expect(answers.filter((answer) => answer === "wrong")).toHaveLength(
			MAXIMUM_PENDING_ATTEMPTS - 1,
		);
		expect(
			answers.filter(
				(answer) =>
					answer !== "wrong" &&
					answer !== "too_many_factor_attempts" &&
					answer !== "invalid_pending_authentication",
			),
		).toStrictEqual([]);
		expect(await pendingRowOf(userId)).toBeUndefined();
		expect(refusals).toStrictEqual([]);
	});

	it("answers fewer wrong TOTP codes than the budget when forty arrive at once", async () => {
		const userId = await createUser(migrated.connection, migrated.schema);
		const actor = actorOfTestUser(userId);
		const clock = createTestClock(new Date("2026-07-01T12:00:00.000Z"));
		const enrollment = await totp.enroll.start({ actor, accountName: "v@example.com" });
		const secret = secretBytesOfBase32(enrollment.secretBase32);
		await totp.enroll.finish({ actor, code: totpCodeForStep(secret, timeStepAt(clock.now())) });
		const { token } = await pending.begin({ userId, factorsCompleted: ["password"] });
		refusals = [];

		const outcomes = await Promise.all(
			Array.from({ length: GUESSES }, (_, index) =>
				totp
					.verify({ pendingToken: token, code: String(100000 + index) })
					.then(() => "accepted")
					.catch((cause: { reason?: string }) => cause.reason ?? "unknown"),
			),
		);

		expect(await pendingRowOf(userId)).toBeUndefined();
		expect(outcomes.filter((outcome) => outcome === "totp_code_wrong").length).toBeLessThan(
			MAXIMUM_PENDING_ATTEMPTS,
		);
		expect(refusals).toStrictEqual([]);
	});
});
