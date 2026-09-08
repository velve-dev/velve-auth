import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createRecoveryCodeService,
	type RecoveryCodeService,
} from "../src/core/factor/recovery/service.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { countingAttempt, countRows, testKeyProvider } from "./totp-fixtures.js";

// T-RACE-4 fixes the thresholds: 50 simultaneous redemptions, 20 repetitions, 9 rows left.
const ATTEMPTS = 50;
const REPETITIONS = 20;
const CODES_PER_SET = 10;

let connections: TestConnection[] = [];
let schema: string;
let keys: KeyProvider;
let issuer: RecoveryCodeService;
let racers: RecoveryCodeService[] = [];

beforeAll(async () => {
	const migrated = await openMigratedSchema("recovery_race");
	schema = migrated.schema;
	connections = [migrated.connection];
	for (let index = 1; index < ATTEMPTS; index += 1) {
		connections.push(await openTestConnection());
	}
	keys = testKeyProvider();
	issuer = createRecoveryCodeService({ driver: connections[0] as TestConnection, schema, keys });
	racers = connections.map((connection) =>
		createRecoveryCodeService({ driver: connection, schema, keys }),
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
	readonly remaining: number;
}

async function raceOneCode(): Promise<RoundOutcome> {
	const first = connections[0] as TestConnection;
	const userId = await createUser(first, schema);
	const { codes } = await issuer.generate({ actor: actorOfTestUser(userId) });
	const code = codes[0] ?? "";

	const results = await Promise.allSettled(
		racers.map((recovery) => recovery.verify({ attempt: countingAttempt(userId), code })),
	);

	return {
		accepted: results.filter((result) => result.status === "fulfilled").length,
		refused: results.filter((result) => result.status === "rejected").length,
		remaining: await countRows(first, schema, "recovery_code", userId),
	};
}

describe("T-RACE-4: fifty redemptions of one recovery code leave one winner (S-RACE-4)", () => {
	it(
		"accepts exactly one in every round and leaves nine codes",
		async () => {
			const rounds: RoundOutcome[] = [];
			for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
				rounds.push(await raceOneCode());
			}

			expect(rounds).toHaveLength(REPETITIONS);
			expect(rounds.filter((round) => round.accepted === 1)).toHaveLength(REPETITIONS);
			expect(rounds.filter((round) => round.remaining === CODES_PER_SET - 1)).toHaveLength(
				REPETITIONS,
			);
			expect(rounds.reduce((total, round) => total + round.accepted + round.refused, 0)).toBe(
				REPETITIONS * ATTEMPTS,
			);
		},
		300_000,
	);
});
