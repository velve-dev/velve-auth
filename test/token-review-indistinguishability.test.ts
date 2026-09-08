import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import {
	createOneTimeTokens,
	hashSecretToken,
	ONE_TIME_TOKEN_PURPOSES,
	type OneTimeTokenPurpose,
	type OneTimeTokens,
	type SecretToken,
	toSecretToken,
} from "../src/core/token/index.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

interface Call {
	readonly sql: string;
	readonly params: readonly unknown[];
}

let connection: TestConnection;
let schema: string;
let user: string;
let otherUser: string;
let tokens: OneTimeTokens;
let calls: Call[] = [];

function recording(driver: Driver): Driver {
	const recorder: Driver = {
		query<T>(sql: string, params: unknown[]): Promise<T[]> {
			calls.push({ sql, params });
			return driver.query<T>(sql, params);
		},
		transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
			return fn(recorder);
		},
	};
	return recorder;
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("velve_review_same");
	connection = migrated.connection;
	schema = migrated.schema;
	user = await createUser(connection, schema);
	otherUser = await createUser(connection, schema);
	tokens = createOneTimeTokens(
		createOneTimeTokenRepository({ driver: recording(connection), schema }),
	);
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

async function clear(): Promise<void> {
	await connection.query(`DELETE FROM ${schema}.one_time_token`, []);
}

async function backdate(): Promise<void> {
	await connection.query(
		`UPDATE ${schema}.one_time_token SET expires_at = now() - interval '1 second'`,
		[],
	);
}

interface Observation {
	readonly name: string;
	readonly answer: unknown;
	readonly calls: readonly Call[];
	readonly threw: unknown;
}

/** Everything a caller can see of one redemption: the answer, what reached the driver,
 * and whether anything was raised. */
async function observe(
	name: string,
	attempt: { token: SecretToken; purpose: OneTimeTokenPurpose },
): Promise<Observation> {
	calls = [];
	try {
		const answer = await tokens.redeem(attempt);
		return { name, answer, calls, threw: undefined };
	} catch (error) {
		return { name, answer: undefined, calls, threw: error };
	}
}

async function invalidObservations(purpose: OneTimeTokenPurpose): Promise<Observation[]> {
	await clear();

	const consumed = await tokens.issue({ purpose, userId: user });
	await tokens.redeem({ token: consumed.token, purpose });

	const expired = await tokens.issue({ purpose, userId: user });
	await backdate();

	const otherPurpose =
		ONE_TIME_TOKEN_PURPOSES.find((candidate) => candidate !== purpose) ?? purpose;
	await clear();
	const wrongPurpose = await tokens.issue({ purpose: otherPurpose, userId: user });

	await clear();
	const consumedAgain = await tokens.issue({ purpose, userId: user });
	await tokens.redeem({ token: consumedAgain.token, purpose });
	const expiredAgain = await tokens.issue({ purpose, userId: user });
	await backdate();

	const foreign = await tokens.issue({ purpose: otherPurpose, userId: otherUser });

	return [
		await observe("consumed", { token: consumedAgain.token, purpose }),
		await observe("expired", { token: expiredAgain.token, purpose }),
		await observe("never existed", {
			token: toSecretToken("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
			purpose,
		}),
		await observe("wrong purpose", { token: wrongPurpose.token, purpose }),
		await observe("another user's token", { token: foreign.token, purpose }),
		await observe("empty string", { token: toSecretToken(""), purpose }),
		await observe("not base64url at all", {
			token: toSecretToken("?????? not a token ??????"),
			purpose,
		}),
		await observe("a megabyte of text", { token: toSecretToken("x".repeat(1_000_000)), purpose }),
		await observe("consumed twice over", { token: consumed.token, purpose }),
		await observe("expired twice over", { token: expired.token, purpose }),
	];
}

// S-REPLAY-3 and T-REPLAY-3. The three cases the specification names are joined here by
// every other way a redemption can fail, because a fourth answer would separate them just
// as well as a third.
describe("expired, consumed, never existed and every other failure are one answer (S-REPLAY-3)", () => {
	it.each(ONE_TIME_TOKEN_PURPOSES)("%s", async (purpose) => {
		const observations = await invalidObservations(purpose);

		expect(observations.map((observation) => observation.name)).toHaveLength(10);

		for (const observation of observations) {
			expect(observation.threw, `${observation.name} raised`).toBeUndefined();
			expect(observation.answer, `${observation.name} answered something`).toBeNull();
		}
	});

	it.each(ONE_TIME_TOKEN_PURPOSES)(
		"%s asks the database the same thing every time",
		async (purpose) => {
			const observations = await invalidObservations(purpose);

			// One statement per attempt: a second query on any branch would be a channel of its own.
			expect(observations.map((observation) => observation.calls.length)).toStrictEqual(
				observations.map(() => 1),
			);

			const statements = new Set(observations.map((observation) => observation.calls[0]?.sql));
			expect(statements.size).toBe(1);

			// The bound values differ in the hash and in nothing else — same count, same purpose,
			// same 32-byte width, so not even the length of the input reaches the server.
			for (const observation of observations) {
				const params = observation.calls[0]?.params ?? [];
				expect(params, observation.name).toHaveLength(2);
				expect(Buffer.from(params[0] as Uint8Array), observation.name).toHaveLength(32);
				expect(params[1], observation.name).toBe(purpose);
			}
		},
	);

	it("answers a valid redemption with the same statement and the same number of queries", async () => {
		await clear();
		const issued = await tokens.issue({ purpose: "magic_link", userId: user });
		const success = await observe("valid", { token: issued.token, purpose: "magic_link" });
		const failure = await observe("invalid", { token: issued.token, purpose: "magic_link" });

		expect(success.calls).toHaveLength(1);
		expect(failure.calls).toHaveLength(1);
		expect(success.calls[0]?.sql).toBe(failure.calls[0]?.sql);
		expect(success.answer).not.toBeNull();
		expect(failure.answer).toBeNull();
	});

	it("returns the identical null value, not a null-shaped object", async () => {
		await clear();
		const observations = await invalidObservations("password_reset");

		for (const observation of observations) {
			expect(Object.is(observation.answer, null), observation.name).toBe(true);
		}
	});

	// A row the library never writes but the schema allows: no owner, therefore no target.
	it("answers a row without an owner like every other invalid token", async () => {
		await clear();
		const planted = toSecretToken("a-row-written-around-the-library");
		await connection.query(
			`INSERT INTO ${schema}.one_time_token (token_sha256, purpose, expires_at)
			 VALUES ($1, $2, now() + interval '1 hour')`,
			[hashSecretToken(planted), "magic_link"],
		);

		const observation = await observe("owner-less row", {
			token: planted,
			purpose: "magic_link",
		});

		expect(observation.answer).toBeNull();
		expect(observation.calls).toHaveLength(1);
	});
});
