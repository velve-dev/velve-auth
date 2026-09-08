import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createOneTimeTokenRepository,
	OneTimeTokenError,
	type OneTimeTokenRepository,
} from "../src/core/db/repositories/token.js";
import {
	createOneTimeTokens,
	hashSecretToken,
	ONE_TIME_TOKEN_LIFETIME_SECONDS,
	ONE_TIME_TOKEN_PURPOSES,
	type OneTimeTokenPurpose,
	type OneTimeTokens,
	toSecretToken,
} from "../src/core/token/index.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

let connection: TestConnection;
let schema: string;
let repository: OneTimeTokenRepository;
let tokens: OneTimeTokens;
let user: string;
let otherUser: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("velve_token");
	connection = migrated.connection;
	schema = migrated.schema;
	repository = createOneTimeTokenRepository({ driver: connection, schema });
	tokens = createOneTimeTokens(repository);
	user = await createUser(connection, schema);
	otherUser = await createUser(connection, schema);
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

async function storedRows(userId: string, purpose: OneTimeTokenPurpose): Promise<number> {
	const [row] = await connection.query<{ stored: number }>(
		`SELECT count(*)::int AS stored FROM ${schema}.one_time_token
		 WHERE user_id = $1 AND purpose = $2`,
		[userId, purpose],
	);
	return row?.stored ?? -1;
}

async function secondsUntilExpiry(userId: string): Promise<number> {
	const [row] = await connection.query<{ remaining: number }>(
		`SELECT extract(epoch FROM (expires_at - now()))::int AS remaining
		 FROM ${schema}.one_time_token WHERE user_id = $1`,
		[userId],
	);
	return row?.remaining ?? -1;
}

async function expire(userId: string): Promise<void> {
	await connection.query(
		`UPDATE ${schema}.one_time_token SET expires_at = now() - interval '1 second'
		 WHERE user_id = $1`,
		[userId],
	);
}

async function clear(): Promise<void> {
	await connection.query(`DELETE FROM ${schema}.one_time_token`, []);
}

// T-REPLAY-2: all four purposes, issued, redeemed, redeemed again.
describe("a one-time token is valid exactly once (S-REPLAY-1, S-REPLAY-2)", () => {
	it.each(ONE_TIME_TOKEN_PURPOSES)("%s", async (purpose) => {
		await clear();
		const issued = await tokens.issue({ purpose, userId: user });

		expect(await storedRows(user, purpose)).toBe(1);
		expect(await tokens.redeem({ token: issued.token, purpose })).toStrictEqual({
			purpose,
			userId: user,
			payload: null,
		});
		expect(await storedRows(user, purpose)).toBe(0);
		expect(await tokens.redeem({ token: issued.token, purpose })).toBeNull();
	});

	it("stores the hash of the token and never the token", async () => {
		await clear();
		const issued = await tokens.issue({ purpose: "magic_link", userId: user });

		const [row] = await connection.query<{ token_sha256: Uint8Array; row_text: string }>(
			`SELECT token_sha256, one_time_token::text AS row_text FROM ${schema}.one_time_token`,
			[],
		);

		expect(Buffer.from(row?.token_sha256 ?? new Uint8Array())).toStrictEqual(
			Buffer.from(hashSecretToken(issued.token)),
		);
		expect(row?.row_text).not.toContain(issued.token);
	});
});

// T-TOKEN-2: the full 4 x 4 cross matrix plus an invented token.
describe("a purpose is part of the lookup, not a check afterwards (S-TOKEN-1, S-TOKEN-2)", () => {
	it("redeems only on the diagonal, and rejects everything else the same way", async () => {
		const outcomes: { minted: OneTimeTokenPurpose; redeemed: OneTimeTokenPurpose; ok: boolean }[] =
			[];

		for (const minted of ONE_TIME_TOKEN_PURPOSES) {
			for (const redeemed of ONE_TIME_TOKEN_PURPOSES) {
				await clear();
				const issued = await tokens.issue({ purpose: minted, userId: user });
				const result = await tokens.redeem({ token: issued.token, purpose: redeemed });
				outcomes.push({ minted, redeemed, ok: result !== null });

				if (minted !== redeemed) {
					expect(result).toBeNull();
					expect(await storedRows(user, minted)).toBe(1);
				}
			}
		}

		expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(4);
		expect(outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.minted)).toStrictEqual(
			[...ONE_TIME_TOKEN_PURPOSES],
		);
		expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(12);
	});

	it("answers a token of the wrong purpose exactly as it answers an invented one", async () => {
		await clear();
		const issued = await tokens.issue({ purpose: "password_reset", userId: user });

		expect(await tokens.redeem({ token: issued.token, purpose: "email_verify" })).toBeNull();
		expect(
			await tokens.redeem({ token: toSecretToken("not-a-token"), purpose: "email_verify" }),
		).toBeNull();
		expect(await tokens.redeem({ token: toSecretToken(""), purpose: "email_verify" })).toBeNull();
	});
});

// T-REPLAY-3: expired, consumed and never issued are one answer.
describe("expired, consumed and unknown are one answer (S-REPLAY-3)", () => {
	it.each(ONE_TIME_TOKEN_PURPOSES)("%s", async (purpose) => {
		await clear();

		const consumed = await tokens.issue({ purpose, userId: user });
		await tokens.redeem({ token: consumed.token, purpose });

		const expired = await tokens.issue({ purpose, userId: user });
		await expire(user);

		const answers = [
			await tokens.redeem({ token: consumed.token, purpose }),
			await tokens.redeem({ token: expired.token, purpose }),
			await tokens.redeem({ token: toSecretToken("never-issued"), purpose }),
		];

		expect(answers).toStrictEqual([null, null, null]);
	});

	it("removes nothing when the token has expired", async () => {
		await clear();
		const issued = await tokens.issue({ purpose: "magic_link", userId: user });
		await expire(user);

		expect(await tokens.redeem({ token: issued.token, purpose: "magic_link" })).toBeNull();
		expect(await storedRows(user, "magic_link")).toBe(1);
	});
});

// T-TOKEN-3 and section 3.7, last sentence.
describe("a new token of the same purpose supersedes the earlier ones (S-TOKEN-3)", () => {
	it("leaves exactly one row and rejects the token it replaced", async () => {
		await clear();
		const first = await tokens.issue({ purpose: "password_reset", userId: user });
		const second = await tokens.issue({ purpose: "password_reset", userId: user });

		expect(await storedRows(user, "password_reset")).toBe(1);
		expect(await tokens.redeem({ token: first.token, purpose: "password_reset" })).toBeNull();
		expect(await tokens.redeem({ token: second.token, purpose: "password_reset" })).not.toBeNull();
	});

	it("supersedes only the same purpose", async () => {
		await clear();
		const verify = await tokens.issue({ purpose: "email_verify", userId: user });
		await tokens.issue({ purpose: "password_reset", userId: user });

		expect(await tokens.redeem({ token: verify.token, purpose: "email_verify" })).not.toBeNull();
	});

	it("supersedes only the same user", async () => {
		await clear();
		const mine = await tokens.issue({ purpose: "magic_link", userId: user });
		await tokens.issue({ purpose: "magic_link", userId: otherUser });

		expect(await storedRows(user, "magic_link")).toBe(1);
		expect(await tokens.redeem({ token: mine.token, purpose: "magic_link" })).not.toBeNull();
	});
});

describe("the deadlines of section 3.7", () => {
	it.each(ONE_TIME_TOKEN_PURPOSES)("%s expires on the database clock", async (purpose) => {
		await clear();
		await tokens.issue({ purpose, userId: user });

		const expected = ONE_TIME_TOKEN_LIFETIME_SECONDS[purpose];
		const remaining = await secondsUntilExpiry(user);
		expect(remaining).toBeGreaterThan(expected - 5);
		expect(remaining).toBeLessThanOrEqual(expected);
	});

	it("names the deadlines the specification names", () => {
		expect(ONE_TIME_TOKEN_LIFETIME_SECONDS).toStrictEqual({
			email_verify: 86_400,
			password_reset: 3_600,
			email_change: 3_600,
			magic_link: 600,
		});
	});

	it("reports the expiry as an ISO-8601 instant in UTC", async () => {
		await clear();
		const issued = await tokens.issue({ purpose: "magic_link", userId: user });
		expect(issued.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});
});

describe("the payload travels with the token", () => {
	it("returns what was stored", async () => {
		await clear();
		const issued = await tokens.issue({
			purpose: "email_change",
			userId: user,
			payload: { newEmail: "next@example.com" },
		});

		expect(await tokens.redeem({ token: issued.token, purpose: "email_change" })).toStrictEqual({
			purpose: "email_change",
			userId: user,
			payload: { newEmail: "next@example.com" },
		});
	});

	it("is null when none was given", async () => {
		await clear();
		const issued = await tokens.issue({ purpose: "email_verify", userId: user });
		const redeemed = await tokens.redeem({ token: issued.token, purpose: "email_verify" });
		expect(redeemed?.payload).toBeNull();
	});
});

// S-TOKEN-4: the target account is the column, and a row without one has no target.
describe("the target account comes from the row alone (S-TOKEN-4)", () => {
	it("rejects a row that names no user, and consumes it all the same", async () => {
		await clear();
		const token = toSecretToken("a-row-written-around-the-library");
		await connection.query(
			`INSERT INTO ${schema}.one_time_token (token_sha256, purpose, expires_at)
			 VALUES ($1, $2, now() + interval '1 hour')`,
			[hashSecretToken(token), "magic_link"],
		);

		expect(await tokens.redeem({ token, purpose: "magic_link" })).toBeNull();

		const [row] = await connection.query<{ stored: number }>(
			`SELECT count(*)::int AS stored FROM ${schema}.one_time_token`,
			[],
		);
		expect(row?.stored).toBe(0);
	});

	it("names the user the token was minted for, not the one who asks", async () => {
		await clear();
		const issued = await tokens.issue({ purpose: "email_change", userId: otherUser });
		const redeemed = await tokens.redeem({ token: issued.token, purpose: "email_change" });

		expect(redeemed?.userId).toBe(otherUser);
		expect(redeemed?.userId).not.toBe(user);
	});
});

// Both of these reach the driver as a constraint violation if nothing stops them first, and a
// driver's error names the table and the constraint.
describe("what issuing refuses, and how it says so", () => {
	it("refuses an account that no longer exists, with a code and no driver text", async () => {
		await clear();
		const doomed = await createUser(connection, schema);
		await connection.query(`DELETE FROM ${schema}.user WHERE id = $1`, [doomed]);

		const raised = (await tokens
			.issue({ purpose: "password_reset", userId: doomed })
			.catch((error: unknown) => error)) as OneTimeTokenError;

		expect(raised).toBeInstanceOf(OneTimeTokenError);
		expect(raised.code).toBe("one_time_token_owner_unknown");
		expect(raised.message).not.toContain("one_time_token");
		expect(raised.message).not.toContain(doomed);
	});

	it("refuses a purpose outside the four, with a code and no driver text", async () => {
		await clear();

		const raised = (await tokens
			.issue({ purpose: "totp_step" as unknown as OneTimeTokenPurpose, userId: user })
			.catch((error: unknown) => error)) as OneTimeTokenError;

		expect(raised).toBeInstanceOf(OneTimeTokenError);
		expect(raised.code).toBe("one_time_token_purpose_unknown");
		expect(raised.message).not.toContain("expires_at");
	});
});

// S-TOKEN-5: the row belongs to the user and goes when the user goes.
describe("deleting the user deletes the token (S-TOKEN-5)", () => {
	it("leaves no row behind", async () => {
		await clear();
		const doomed = await createUser(connection, schema);
		await tokens.issue({ purpose: "email_verify", userId: doomed });

		await connection.query(`DELETE FROM ${schema}.user WHERE id = $1`, [doomed]);

		expect(await storedRows(doomed, "email_verify")).toBe(0);
	});
});
