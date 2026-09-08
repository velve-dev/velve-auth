import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCodeForStep } from "../src/core/factor/totp/code.js";
import { timeStepAt } from "../src/core/factor/totp/parameters.js";
import { createTotpService, type TotpService } from "../src/core/factor/totp/service.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import {
	countingAttempt,
	countRows,
	enrolConfirmedCredential,
	settableClock,
	testKeyProvider,
} from "./totp-fixtures.js";

// T-RACE-3 fixes the thresholds: 50 simultaneous submissions, 20 repetitions, tolerance 0.
const ATTEMPTS = 50;
const REPETITIONS = 20;
const FIXED_INSTANT = new Date("2026-09-08T07:30:00.000Z");

let connections: TestConnection[] = [];
let schema: string;
let keys: KeyProvider;
let racers: TotpService[] = [];

/** The plan runs this nightly; it costs a few seconds and the blocking tier is where a race that stops serialising has to be caught. */
beforeAll(async () => {
	const migrated = await openMigratedSchema("totp_race");
	schema = migrated.schema;
	connections = [migrated.connection];
	for (let index = 1; index < ATTEMPTS; index += 1) {
		connections.push(await openTestConnection());
	}
	keys = testKeyProvider();
	racers = connections.map((connection) =>
		createTotpService({
			driver: connection,
			schema,
			keys,
			issuer: "Velve",
			clock: settableClock(FIXED_INSTANT),
		}),
	);
}, 120_000);

afterAll(async () => {
	const [first] = connections;
	if (first !== undefined) {
		await dropSchema(first, schema);
	}
	await Promise.all(connections.map((connection) => connection.close()));
});

interface RoundOutcome {
	readonly accepted: number;
	readonly refused: number;
	readonly usedSteps: number;
}

async function raceOneCode(): Promise<RoundOutcome> {
	const first = connections[0] as TestConnection;
	const userId = await createUser(first, schema);
	const secretBytes = await enrolConfirmedCredential(first, schema, keys, userId);
	const code = totpCodeForStep(secretBytes, timeStepAt(FIXED_INSTANT));

	const results = await Promise.allSettled(
		racers.map((totp) => totp.verify({ attempt: countingAttempt(userId), code })),
	);

	return {
		accepted: results.filter((result) => result.status === "fulfilled").length,
		refused: results.filter((result) => result.status === "rejected").length,
		usedSteps: await countRows(first, schema, "totp_used_step", userId),
	};
}

describe("T-RACE-3: fifty submissions of one code leave one winner (S-RACE-3)", () => {
	it(
		"accepts exactly one in every round and records exactly one used step",
		async () => {
			const rounds: RoundOutcome[] = [];
			for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
				rounds.push(await raceOneCode());
			}

			expect(rounds).toHaveLength(REPETITIONS);
			expect(rounds.filter((round) => round.accepted === 1)).toHaveLength(REPETITIONS);
			expect(rounds.filter((round) => round.usedSteps === 1)).toHaveLength(REPETITIONS);
			expect(
				rounds.reduce((total, round) => total + round.accepted + round.refused, 0),
			).toBe(REPETITIONS * ATTEMPTS);
			expect(rounds.reduce((total, round) => total + round.accepted, 0)).toBe(REPETITIONS);
		},
		300_000,
	);
});
