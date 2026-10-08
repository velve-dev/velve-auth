import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withReadCommittedTransactions } from "../src/core/db/read-committed.js";
import { bookAttemptOn } from "../src/core/factor/pending/booking.js";
import { createPendingAuthenticationService } from "../src/core/factor/pending/index.js";
import { hashPendingToken } from "../src/core/factor/pending/token.js";
import { testKeyProvider } from "./auth-fixtures.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

//a booking on a connection defaulting to repeatable read waits out a concurrent write and books, never failing with 40001 (E-3481)

const keys = testKeyProvider();
let first: TestConnection;
let second: TestConnection;
let observer: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("booking_repeatable_read");
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
			 WHERE wait_event_type = 'Lock' AND query LIKE '%SET attempts%'`,
			[],
		);
		if ((row?.n ?? 0) > 0) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("the booking never waited on the row lock");
}

describe("a booking whose row another transaction holds", () => {
	it("books once that transaction commits, through the library's transaction", async () => {
		const userId = await createUser(first, schema);
		const issuer = createPendingAuthenticationService({ driver: first, keys, schema });
		const { token } = await issuer.begin({ userId, factorsCompleted: ["password"] });
		const booker = createPendingAuthenticationService({
			driver: withReadCommittedTransactions(second),
			keys,
			schema,
		});
		await first.query("BEGIN", []);
		await first.query(
			`UPDATE ${schema}.pending_authentication SET attempts = attempts WHERE token_sha256 = $1`,
			[hashPendingToken(token)],
		);
		const booking = bookAttemptOn(booker, token).then(
			(booked) => booked.outcome,
			(failure: { sqlState?: string; code?: string }) =>
				failure.sqlState ?? failure.code ?? "threw",
		);
		await untilSomeoneWaits();
		await first.query("COMMIT", []);

		expect(await booking).toBe("booked");
	});
});
