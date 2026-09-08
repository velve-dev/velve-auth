import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import {
	createOneTimeTokens,
	ONE_TIME_TOKEN_PURPOSES,
	type OneTimeTokenPurpose,
	type OneTimeTokens,
} from "../src/core/token/index.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

// T-RACE-1 fixes the thresholds: 50 simultaneous redemptions, 20 repetitions, tolerance 0.
const ATTEMPTS = 50;
const REPETITIONS = 20;
const ARTIFICIAL_DELAY_MS = 50;

let connections: TestConnection[] = [];
let schema: string;
let user: string;
let issuer: OneTimeTokens;
let racers: OneTimeTokens[] = [];
let delayedRacers: OneTimeTokens[] = [];

function afterDelay(driver: Driver, milliseconds: number): Driver {
	return {
		async query(sql, params) {
			await new Promise((resolve) => setTimeout(resolve, milliseconds));
			return driver.query(sql, params);
		},
		transaction(fn) {
			return driver.transaction(fn);
		},
	};
}

function tokensOn(driver: Driver): OneTimeTokens {
	return createOneTimeTokens(createOneTimeTokenRepository({ driver, schema }));
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("velve_race");
	schema = migrated.schema;
	connections = [migrated.connection];
	for (let index = 1; index < ATTEMPTS; index += 1) {
		connections.push(await openTestConnection());
	}
	user = await createUser(connections[0] as TestConnection, schema);
	issuer = tokensOn(connections[0] as TestConnection);
	racers = connections.map((connection) => tokensOn(connection));
	delayedRacers = connections.map((connection) =>
		tokensOn(afterDelay(connection, ARTIFICIAL_DELAY_MS)),
	);
}, 60_000);

afterAll(async () => {
	const [first] = connections;
	if (first !== undefined) {
		await dropSchema(first, schema);
	}
	await Promise.all(connections.map((connection) => connection.close()));
});

async function remainingRows(purpose: OneTimeTokenPurpose): Promise<number> {
	const [row] = await (connections[0] as TestConnection).query<{ stored: number }>(
		`SELECT count(*)::int AS stored FROM ${schema}.one_time_token
		 WHERE user_id = $1 AND purpose = $2`,
		[user, purpose],
	);
	return row?.stored ?? -1;
}

interface RaceOutcome {
	readonly winners: number;
	readonly losers: number;
	readonly rejected: number;
	readonly remaining: number;
}

async function race(
	purpose: OneTimeTokenPurpose,
	contenders: readonly OneTimeTokens[],
): Promise<RaceOutcome> {
	const { token } = await issuer.issue({ purpose, userId: user });

	const results = await Promise.allSettled(
		contenders.map((tokens) => tokens.redeem({ token, purpose })),
	);

	const answers = results.flatMap((result) =>
		result.status === "fulfilled" ? [result.value] : [],
	);

	return {
		winners: answers.filter((answer) => answer?.userId === user).length,
		losers: answers.filter((answer) => answer === null).length,
		rejected: results.length - answers.length,
		remaining: await remainingRows(purpose),
	};
}

function summarise(outcomes: readonly RaceOutcome[]): Record<string, number> {
	return {
		rounds: outcomes.length,
		winners: outcomes.reduce((total, outcome) => total + outcome.winners, 0),
		losers: outcomes.reduce((total, outcome) => total + outcome.losers, 0),
		rejected: outcomes.reduce((total, outcome) => total + outcome.rejected, 0),
		remaining: outcomes.reduce((total, outcome) => total + outcome.remaining, 0),
	};
}

describe("fifty simultaneous redemptions leave one winner (S-RACE-1)", () => {
	it.each(ONE_TIME_TOKEN_PURPOSES)(
		"%s",
		async (purpose) => {
			const outcomes: RaceOutcome[] = [];
			for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
				outcomes.push(await race(purpose, racers));
			}

			expect(summarise(outcomes)).toStrictEqual({
				rounds: REPETITIONS,
				winners: REPETITIONS,
				losers: REPETITIONS * (ATTEMPTS - 1),
				rejected: 0,
				remaining: 0,
			});
		},
		180_000,
	);
});

// T-RACE-2: the same race, with the driver held back so every attempt reaches the server inside
// the same window. Nothing reads the row first, so a delay has nowhere to open a gap.
describe("a delay between the call and the statement changes nothing (S-RACE-2)", () => {
	it.each(ONE_TIME_TOKEN_PURPOSES)(
		"%s",
		async (purpose) => {
			const outcomes: RaceOutcome[] = [];
			for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
				outcomes.push(await race(purpose, delayedRacers));
			}

			expect(summarise(outcomes)).toStrictEqual({
				rounds: REPETITIONS,
				winners: REPETITIONS,
				losers: REPETITIONS * (ATTEMPTS - 1),
				rejected: 0,
				remaining: 0,
			});
		},
		180_000,
	);
});

describe("the race is a race", () => {
	it("runs on one connection per attempt, so the server does the serialising", () => {
		expect(connections).toHaveLength(ATTEMPTS);
		expect(new Set(connections).size).toBe(ATTEMPTS);
	});
});
