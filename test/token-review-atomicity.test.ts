import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import {
	createOneTimeTokens,
	hashSecretToken,
	ONE_TIME_TOKEN_PURPOSES,
	type OneTimeTokenPurpose,
	type OneTimeTokenRedemption,
	type OneTimeTokens,
} from "../src/core/token/index.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

// T-RACE-1 fixes 50 simultaneous attempts, 20 repetitions per purpose, tolerance 0. The
// repetitions, the purposes and the tolerance are kept; the attempt count is not, because a
// second file holding many connections does not fit beside `test/token-race.test.ts` in a
// default PostgreSQL and starves it. That file carries the fifty; this one carries the
// barrier and the planted fault below, which is what makes either of them evidence.
const ATTEMPTS = 12;
const REPETITIONS = 20;

let connections: TestConnection[] = [];
let schema: string;
let user: string;
let issuer: OneTimeTokens;
let atomicRedeemers: OneTimeTokens[] = [];
let readThenWriteRedeemers: OneTimeTokens[] = [];

/** The fault T-RACE-1 exists to catch, written out so the harness can be shown to catch it. */
function readThenWriteRedeemer(connection: TestConnection, schemaName: string): OneTimeTokens {
	return {
		issue() {
			return Promise.reject(new Error("the negative control only redeems"));
		},
		async redeem({ token, purpose }) {
			const hash = hashSecretToken(token);
			const [found] = await connection.query<{ user_id: string | null }>(
				`SELECT user_id FROM ${schemaName}.one_time_token
				 WHERE token_sha256 = $1 AND purpose = $2 AND expires_at > now()`,
				[hash, purpose],
			);
			if (found === undefined || found.user_id === null) {
				return null;
			}
			await connection.query(
				`DELETE FROM ${schemaName}.one_time_token WHERE token_sha256 = $1 AND purpose = $2`,
				[hash, purpose],
			);
			return { purpose, userId: found.user_id, payload: null };
		},
	};
}

/** The suite already holds fifty connections open for the writer's own race file; a default
 * PostgreSQL has a hundred. Waiting for a slot keeps this file's failures about atomicity. */
async function openConnectionWaitingForASlot(): Promise<TestConnection> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await openTestConnection();
		} catch (error) {
			if (attempt >= 240) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("velve_review_race");
	schema = migrated.schema;
	connections = [migrated.connection];
	for (let index = 1; index < ATTEMPTS; index += 1) {
		connections.push(await openConnectionWaitingForASlot());
	}
	user = await createUser(connections[0] as TestConnection, schema);
	issuer = createOneTimeTokens(
		createOneTimeTokenRepository({ driver: connections[0] as TestConnection, schema }),
	);
	atomicRedeemers = connections.map((connection) =>
		createOneTimeTokens(createOneTimeTokenRepository({ driver: connection, schema })),
	);
	readThenWriteRedeemers = connections.map((connection) =>
		readThenWriteRedeemer(connection, schema),
	);
}, 120_000);

afterAll(async () => {
	const [first] = connections;
	if (first !== undefined) {
		await dropSchema(first, schema);
	}
	await Promise.all(connections.map((connection) => connection.close()));
});

async function countRows(purpose: OneTimeTokenPurpose): Promise<number> {
	const [row] = await (connections[0] as TestConnection).query<{ stored: number }>(
		`SELECT count(*)::int AS stored FROM ${schema}.one_time_token
		 WHERE user_id = $1 AND purpose = $2`,
		[user, purpose],
	);
	return row?.stored ?? -1;
}

interface Round {
	readonly winners: number;
	readonly nulls: number;
	readonly thrown: number;
	readonly remaining: number;
}

/** Every attempt waits on the same promise, so none of them can be handed to the server
 * before the last one has been prepared. */
async function raceOneToken(
	purpose: OneTimeTokenPurpose,
	redeemers: readonly OneTimeTokens[],
): Promise<Round> {
	const { token } = await issuer.issue({ purpose, userId: user });

	let release = (): void => undefined;
	const gate = new Promise<void>((resolve) => {
		release = () => resolve();
	});
	const attempts = redeemers.map((redeemer) =>
		gate.then(() => redeemer.redeem({ token, purpose })),
	);
	release();

	const settled = await Promise.allSettled(attempts);
	const answers = settled.flatMap((result) =>
		result.status === "fulfilled" ? [result.value] : [],
	);

	return {
		winners: answers.filter(
			(answer: OneTimeTokenRedemption | null) =>
				answer !== null && answer.userId === user && answer.purpose === purpose,
		).length,
		nulls: answers.filter((answer) => answer === null).length,
		thrown: settled.length - answers.length,
		remaining: await countRows(purpose),
	};
}

async function raceRepeatedly(
	purpose: OneTimeTokenPurpose,
	redeemers: readonly OneTimeTokens[],
): Promise<Round[]> {
	const rounds: Round[] = [];
	for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
		rounds.push(await raceOneToken(purpose, redeemers));
	}
	return rounds;
}

describe("exactly one simultaneous redemption wins (S-RACE-1, T-RACE-1)", () => {
	it.each(ONE_TIME_TOKEN_PURPOSES)(
		"%s, twenty rounds, tolerance zero",
		async (purpose) => {
			const rounds = await raceRepeatedly(purpose, atomicRedeemers);

			expect(rounds.map((round) => round.winners)).toStrictEqual(
				Array.from({ length: REPETITIONS }, () => 1),
			);
			expect(rounds.map((round) => round.nulls)).toStrictEqual(
				Array.from({ length: REPETITIONS }, () => ATTEMPTS - 1),
			);
			expect(rounds.map((round) => round.thrown)).toStrictEqual(
				Array.from({ length: REPETITIONS }, () => 0),
			);
			expect(rounds.map((round) => round.remaining)).toStrictEqual(
				Array.from({ length: REPETITIONS }, () => 0),
			);
		},
		300_000,
	);
});

describe("the harness has teeth", () => {
	it("uses one connection per attempt, so the server does the serialising", () => {
		expect(connections).toHaveLength(ATTEMPTS);
		expect(new Set(connections).size).toBe(ATTEMPTS);
	});

	// A concurrency test that has never failed is not evidence. This plants the fault the
	// requirement forbids — a read before the write — and asserts the harness sees it.
	it("reports many winners when the redemption reads before it writes", async () => {
		const rounds = await raceRepeatedly("password_reset", readThenWriteRedeemers);
		const winners = rounds.map((round) => round.winners);

		expect(Math.max(...winners)).toBeGreaterThan(1);
		expect(winners.filter((count) => count > 1).length).toBeGreaterThanOrEqual(REPETITIONS - 1);
	}, 300_000);
});
