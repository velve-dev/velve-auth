import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	MAXIMUM_PENDING_ATTEMPTS,
	type PendingAuthenticationService,
} from "../src/core/factor/pending/index.js";
import {
	createTotpService,
	type TotpService,
	timeStepAt,
	totpCodeForStep,
} from "../src/core/factor/totp/index.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import {
	beginPendingState,
	pendingAuthenticationsOn,
	secretBytesOfBase32,
	testKeyProvider,
} from "./totp-fixtures.js";

//a writer who resets attempts must get no more guesses than the budget once the token branch binds the counter (E-3091)

let connection: TestConnection;
let schema: string;
let clock: TestClock;
let pending: PendingAuthenticationService;
let totp: TotpService;

beforeAll(async () => {
	const migrated = await openMigratedSchema("attempt_budget");
	connection = migrated.connection;
	schema = migrated.schema;
	clock = createTestClock(new Date("2026-07-01T12:00:00.000Z"));
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

async function guessesAnsweredWhileAWriterResetsAttempts(): Promise<number> {
	const userId = await createUser(connection, schema);
	const actor = actorOfTestUser(userId);
	const enrollment = await totp.enroll.start({ actor, accountName: "victim@example.com" });
	const secret = secretBytesOfBase32(enrollment.secretBase32);
	await totp.enroll.finish({ actor, code: totpCodeForStep(secret, timeStepAt(clock.now())) });
	const { token } = await beginPendingState(pending, userId);

	let guessesAnswered = 0;
	for (let round = 0; round < 4; round += 1) {
		for (let attempt = 1; attempt < MAXIMUM_PENDING_ATTEMPTS; attempt += 1) {
			const outcome = await totp
				.verify({ pendingToken: token, code: "000000" })
				.then(() => "accepted")
				.catch((cause: { reason?: string }) => cause.reason ?? "unknown");
			if (outcome === "totp_code_wrong") {
				guessesAnswered += 1;
			}
		}
		await connection.query(
			`UPDATE ${schema}.pending_authentication SET attempts = 0 WHERE user_id = $1`,
			[userId],
		);
	}
	return guessesAnswered;
}

describe("a database writer and the pending attempt budget (section 3.18, L-8)", () => {
	it.fails("does not give a writer who resets attempts more guesses than the budget", async () => {
		expect(await guessesAnsweredWhileAWriterResetsAttempts()).toBeLessThanOrEqual(
			MAXIMUM_PENDING_ATTEMPTS,
		);
	});

	it("control: today the writer gets more answered guesses than the budget, so the placeholder fails for that reason", async () => {
		expect(await guessesAnsweredWhileAWriterResetsAttempts()).toBeGreaterThan(
			MAXIMUM_PENDING_ATTEMPTS,
		);
	});
});
