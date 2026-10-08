import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withReadCommittedTransactions } from "../src/core/db/read-committed.js";
import { createWebAuthnChallenges } from "../src/core/factor/webauthn/challenge.js";
import { hashSecretToken, toSecretToken } from "../src/core/token/secret-token.js";
import { testKeyProvider } from "./auth-fixtures.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

//a challenge consumption on a connection defaulting to repeatable read waits out a concurrent write and consumes, never failing with 40001 (E-3486)

const keys = testKeyProvider();
let first: TestConnection;
let second: TestConnection;
let observer: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("webauthn_challenge_repeatable_read");
	first = migrated.connection;
	schema = migrated.schema;
	second = await openTestConnection();
	observer = await openTestConnection();
	await second.query("SET default_transaction_isolation = 'repeatable read'", []);
});

afterAll(async () => {
	await dropSchema(first, schema);
	await first.close();
	await second.close();
	await observer.close();
});

async function untilSomeoneWaits(): Promise<void> {
	for (let poll = 0; poll < 300; poll += 1) {
		const [row] = await observer.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM pg_stat_activity
			 WHERE wait_event_type = 'Lock' AND query LIKE '%DELETE FROM%webauthn_challenge%'`,
			[],
		);
		if ((row?.n ?? 0) > 0) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("the consumption never waited on the row lock");
}

describe("a challenge consumption whose row another transaction holds", () => {
	it("consumes once that transaction commits, never failing with 40001", async () => {
		const userId = await createUser(first, schema);
		const issuer = createWebAuthnChallenges({ driver: first, schema, keys });
		const { challengeToken } = await issuer.issue({ purpose: "register", userId });
		const consumer = createWebAuthnChallenges({
			driver: withReadCommittedTransactions(second),
			schema,
			keys,
		});
		await first.query("BEGIN", []);
		await first.query(
			`UPDATE ${schema}.webauthn_challenge SET purpose = purpose WHERE challenge_sha256 = $1`,
			[hashSecretToken(toSecretToken(challengeToken))],
		);
		const consumption = consumer.consume({ challengeToken, purpose: "register", userId }).then(
			(consumed) => (consumed ? "consumed" : "missing"),
			(failure: { sqlState?: string; code?: string }) =>
				failure.sqlState ?? failure.code ?? "threw",
		);
		await untilSomeoneWaits();
		await first.query("COMMIT", []);

		expect(await consumption).toBe("consumed");
	});
});
