import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { withReadCommittedTransactions } from "../src/core/db/read-committed.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

//a compare-and-set whose miss the library interprets runs in a library transaction under any database default (E-3379)

let first: TestConnection;
let second: TestConnection;
let observer: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("standalone_isolation");
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

async function pendingRow(): Promise<Uint8Array> {
	const userId = await createUser(first, schema);
	const token = crypto.getRandomValues(new Uint8Array(32));
	await first.query(
		`INSERT INTO ${schema}.pending_authentication
		   (token_sha256, user_id, factors_completed, expires_at, token_mac, token_mac_key_version)
		 VALUES ($1, $2, ARRAY['password'], now() + interval '5 minutes', $3, 1)`,
		[token, userId, crypto.getRandomValues(new Uint8Array(32))],
	);
	return token;
}

function booking(connection: Driver, token: Uint8Array, readAttempts: number) {
	return connection.query<{ attempts: number }>(
		`UPDATE ${schema}.pending_authentication SET attempts = attempts + 1
		 WHERE token_sha256 = $1 AND attempts = $2 RETURNING attempts`,
		[token, readAttempts],
	);
}

async function backendOf(connection: TestConnection): Promise<number> {
	const [row] = await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid", []);
	return row?.pid ?? -1;
}

async function untilWaiting(waiter: number): Promise<void> {
	for (let poll = 0; poll < 300; poll += 1) {
		const [row] = await observer.query<{ n: number }>(
			"SELECT cardinality(pg_blocking_pids($1::int))::int AS n",
			[waiter],
		);
		if ((row?.n ?? 0) > 0) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("the losing booking never waited on the winner's row lock");
}

async function losingBooking(
	run: (token: Uint8Array) => Promise<readonly unknown[]>,
): Promise<{ missed: boolean; sqlState: string | null }> {
	const token = await pendingRow();
	const loser = await backendOf(second);
	await first.query("BEGIN", []);
	await booking(first, token, 0);
	const losing = run(token).then(
		(rows) => ({ missed: rows.length === 0, sqlState: null as string | null }),
		(error: { code?: string; sqlState?: string }) => ({
			missed: false,
			sqlState: error.sqlState ?? error.code ?? "unknown",
		}),
	);
	await untilWaiting(loser);
	await first.query("COMMIT", []);
	return losing;
}

describe("premise: a booking that loses its race on a connection defaulting to repeatable read (section 3.18 point 3)", () => {
	it("as a standalone statement fails with 40001 instead of missing", async () => {
		expect(await losingBooking((token) => booking(second, token, 0))).toStrictEqual({
			missed: false,
			sqlState: "40001",
		});
	});

	it("inside a transaction opened through the read-committed wrapper misses the row", async () => {
		const wrapped = withReadCommittedTransactions(second);
		expect(
			await losingBooking((token) => wrapped.transaction((tx) => booking(tx, token, 0))),
		).toStrictEqual({ missed: true, sqlState: null });
	});
});

describe("Sealing in the binding German specification", () => {
	it("runs every statement whose miss the library interprets in a library transaction", () => {
		const german = readFileSync(new URL("../VELVE-AUTH-ARCHITEKTUR.md", import.meta.url), "utf8");
		expect(german).toContain(
			"Jede Anweisung, deren Fehlschlag die Bibliothek deutet — die Buchung eines Versuchs und ihr erneutes Lesen",
		);
	});
});
