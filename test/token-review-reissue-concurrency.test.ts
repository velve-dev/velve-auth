import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import {
	createOneTimeTokens,
	ONE_TIME_TOKEN_PURPOSES,
	type OneTimeTokenPurpose,
	type OneTimeTokens,
	type SecretToken,
} from "../src/core/token/index.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

// Eight is enough to show the effect and small enough to leave the suite its connections;
// the writer's own race file already holds fifty open.
const ATTEMPTS = 8;
const REPETITIONS = 20;

let connections: TestConnection[] = [];
let schema: string;
let user: string;
let issuers: OneTimeTokens[] = [];

/** The suite already holds fifty connections open for the writer's own race file; a default
 * PostgreSQL has a hundred. Waiting for a slot keeps this file's failures about re-issue. */
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
	const migrated = await openMigratedSchema("velve_review_reissue");
	schema = migrated.schema;
	connections = [migrated.connection];
	for (let index = 1; index < ATTEMPTS; index += 1) {
		connections.push(await openConnectionWaitingForASlot());
	}
	user = await createUser(connections[0] as TestConnection, schema);
	issuers = connections.map((connection) =>
		createOneTimeTokens(createOneTimeTokenRepository({ driver: connection, schema })),
	);
}, 120_000);

afterAll(async () => {
	const [first] = connections;
	if (first !== undefined) {
		await dropSchema(first, schema);
	}
	await Promise.all(connections.map((connection) => connection.close()));
});

async function liveTokens(purpose: OneTimeTokenPurpose): Promise<number> {
	const [row] = await (connections[0] as TestConnection).query<{ stored: number }>(
		`SELECT count(*)::int AS stored FROM ${schema}.one_time_token
		 WHERE user_id = $1 AND purpose = $2 AND expires_at > now()`,
		[user, purpose],
	);
	return row?.stored ?? -1;
}

async function issueSimultaneously(purpose: OneTimeTokenPurpose): Promise<SecretToken[]> {
	let release = (): void => undefined;
	const gate = new Promise<void>((resolve) => {
		release = () => resolve();
	});
	const issued = issuers.map((issuer) => gate.then(() => issuer.issue({ purpose, userId: user })));
	release();
	return (await Promise.all(issued)).map((result) => result.token);
}

// Section 3.7, last sentence, and S-TOKEN-3: a newly requested token of a purpose deletes
// the user's earlier ones of that purpose. The replacement is one statement and therefore
// atomic, but at READ COMMITTED its DELETE works from the snapshot taken when the statement
// began, and a row another request inserted after that snapshot is not a row it can delete.
// This check failed when it was written — eight simultaneous requests left up to eight live
// tokens, every one of them redeemable — and passes because the replacement now takes a lock
// on the owner row first (E-259). Deleting that lock brings the eight back. T-TOKEN-3
// exercises only the sequential case, which is why this file exists beside it.
describe("a re-issue leaves one live token of that purpose (S-TOKEN-3)", () => {
	it.each(ONE_TIME_TOKEN_PURPOSES)(
		"%s keeps one live token through eight simultaneous requests",
		async (purpose) => {
			const counts: number[] = [];
			for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
				await (connections[0] as TestConnection).query(`DELETE FROM ${schema}.one_time_token`, []);
				await issueSimultaneously(purpose);
				counts.push(await liveTokens(purpose));
			}

			expect(Math.max(...counts)).toBe(1);
		},
		300_000,
	);

	it("leaves no superseded token redeemable", async () => {
		await (connections[0] as TestConnection).query(`DELETE FROM ${schema}.one_time_token`, []);
		const minted = await issueSimultaneously("password_reset");

		const redeemer = issuers[0] as OneTimeTokens;
		let redeemed = 0;
		for (const token of minted) {
			if ((await redeemer.redeem({ token, purpose: "password_reset" })) !== null) {
				redeemed += 1;
			}
		}

		expect(redeemed).toBe(1);
	}, 300_000);
});
