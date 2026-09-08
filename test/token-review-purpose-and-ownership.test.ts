import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import {
	createOneTimeTokens,
	hashSecretToken,
	ONE_TIME_TOKEN_PURPOSES,
	type OneTimeTokenPurpose,
	type OneTimeTokens,
} from "../src/core/token/index.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

let connection: TestConnection;
let schema: string;
let tokens: OneTimeTokens;
let alice: string;
let bob: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("velve_review_purpose");
	connection = migrated.connection;
	schema = migrated.schema;
	tokens = createOneTimeTokens(createOneTimeTokenRepository({ driver: connection, schema }));
	alice = await createUser(connection, schema);
	bob = await createUser(connection, schema);
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

async function clear(): Promise<void> {
	await connection.query(`DELETE FROM ${schema}.one_time_token`, []);
}

async function countRows(userId: string, purpose: OneTimeTokenPurpose): Promise<number> {
	const [row] = await connection.query<{ stored: number }>(
		`SELECT count(*)::int AS stored FROM ${schema}.one_time_token
		 WHERE user_id = $1 AND purpose = $2`,
		[userId, purpose],
	);
	return row?.stored ?? -1;
}

// T-TOKEN-2 asks for the whole cross matrix, so this walks all sixteen and none of the
// twelve off-diagonal attempts is allowed to consume the row it was refused.
describe("a token of one purpose is nothing at another (S-TOKEN-1, S-TOKEN-2)", () => {
	it("refuses all twelve off-diagonal combinations and consumes none of them", async () => {
		const refused: string[] = [];
		const accepted: string[] = [];

		for (const minted of ONE_TIME_TOKEN_PURPOSES) {
			for (const attempted of ONE_TIME_TOKEN_PURPOSES) {
				await clear();
				const issued = await tokens.issue({ purpose: minted, userId: alice });
				const answer = await tokens.redeem({ token: issued.token, purpose: attempted });
				const combination = `${minted} as ${attempted}`;

				if (answer === null) {
					refused.push(combination);
					expect(await countRows(alice, minted), combination).toBe(1);
					// The refusal costs the token nothing: it still works for what it was minted for.
					expect(
						await tokens.redeem({ token: issued.token, purpose: minted }),
						combination,
					).not.toBeNull();
					continue;
				}

				accepted.push(combination);
				expect(minted).toBe(attempted);
				expect(answer.userId).toBe(alice);
				expect(answer.purpose).toBe(attempted);
			}
		}

		expect(accepted).toStrictEqual(
			ONE_TIME_TOKEN_PURPOSES.map((purpose) => `${purpose} as ${purpose}`),
		);
		expect(refused).toHaveLength(12);
	});

	it("answers every off-diagonal attempt exactly as it answers a token nobody minted", async () => {
		for (const minted of ONE_TIME_TOKEN_PURPOSES) {
			for (const attempted of ONE_TIME_TOKEN_PURPOSES) {
				if (minted === attempted) {
					continue;
				}
				await clear();
				const issued = await tokens.issue({ purpose: minted, userId: alice });

				expect(await tokens.redeem({ token: issued.token, purpose: attempted })).toBeNull();
				expect(
					await tokens.redeem({
						token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
						purpose: attempted,
					}),
				).toBeNull();
			}
		}
	});
});

// T-TOKEN-3 and section 3.7, last sentence. Eight slots are filled, then each is
// re-issued in turn; the other seven must survive untouched every time.
describe("re-issuing touches one purpose of one user (S-TOKEN-3)", () => {
	const slots = ONE_TIME_TOKEN_PURPOSES.flatMap((purpose) =>
		[
			{ owner: "alice", purpose },
			{ owner: "bob", purpose },
		].map((slot) => slot),
	);

	function idOf(owner: string): string {
		return owner === "alice" ? alice : bob;
	}

	it.each(slots)("re-issuing $owner's $purpose leaves the other seven alone", async (slot) => {
		await clear();

		const live = new Map<string, string>();
		for (const other of slots) {
			const issued = await tokens.issue({ purpose: other.purpose, userId: idOf(other.owner) });
			live.set(`${other.owner}/${other.purpose}`, issued.token);
		}

		const replaced = live.get(`${slot.owner}/${slot.purpose}`) ?? "";
		const successor = await tokens.issue({ purpose: slot.purpose, userId: idOf(slot.owner) });

		expect(await countRows(idOf(slot.owner), slot.purpose)).toBe(1);
		expect(await tokens.redeem({ token: replaced, purpose: slot.purpose })).toBeNull();

		for (const other of slots) {
			const key = `${other.owner}/${other.purpose}`;
			if (key === `${slot.owner}/${slot.purpose}`) {
				continue;
			}
			expect(await countRows(idOf(other.owner), other.purpose), key).toBe(1);
			expect(
				await tokens.redeem({ token: live.get(key) ?? "", purpose: other.purpose }),
				key,
			).not.toBeNull();
		}

		expect(await tokens.redeem({ token: successor.token, purpose: slot.purpose })).not.toBeNull();
	});
});

// S-TOKEN-4: the account is the column and nothing else can name it.
describe("a redemption yields the account the row names (S-TOKEN-4)", () => {
	it("yields the minted owner even when the payload claims another one", async () => {
		await clear();
		const issued = await tokens.issue({
			purpose: "email_change",
			userId: bob,
			payload: { userId: alice, user_id: alice, sub: alice },
		});

		const answer = await tokens.redeem({ token: issued.token, purpose: "email_change" });

		expect(answer?.userId).toBe(bob);
		expect(answer?.userId).not.toBe(alice);
	});

	it("yields the owner of a row written around the library, whoever wrote it", async () => {
		await clear();
		const planted = "written-past-the-library-for-bob";
		await connection.query(
			`INSERT INTO ${schema}.one_time_token (token_sha256, purpose, user_id, expires_at)
			 VALUES ($1, $2, $3, now() + interval '1 hour')`,
			[hashSecretToken(planted), "password_reset", bob],
		);

		const answer = await tokens.redeem({ token: planted, purpose: "password_reset" });

		expect(answer?.userId).toBe(bob);
	});

	it("cannot be pointed at an account the row does not name", async () => {
		await clear();
		const issued = await tokens.issue({ purpose: "magic_link", userId: alice });
		const stranger = await createUser(connection, schema);

		const answers = await Promise.all([
			tokens.redeem({ token: issued.token, purpose: "magic_link" }),
		]);

		expect(answers[0]?.userId).toBe(alice);
		expect(answers[0]?.userId).not.toBe(bob);
		expect(answers[0]?.userId).not.toBe(stranger);
	});

	it("refuses a row whose owner the schema allows to be missing, and takes the row with it", async () => {
		await clear();
		const planted = "an-owner-less-row";
		await connection.query(
			`INSERT INTO ${schema}.one_time_token (token_sha256, purpose, expires_at)
			 VALUES ($1, $2, now() + interval '1 hour')`,
			[hashSecretToken(planted), "email_verify"],
		);

		expect(await tokens.redeem({ token: planted, purpose: "email_verify" })).toBeNull();

		const [row] = await connection.query<{ stored: number }>(
			`SELECT count(*)::int AS stored FROM ${schema}.one_time_token`,
			[],
		);
		expect(row?.stored).toBe(0);
	});
});
