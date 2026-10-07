import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPendingToken } from "../src/core/factor/pending/token.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { beginPendingState, pendingAuthenticationsOn } from "./totp-fixtures.js";

// Section 3.18 point 3 books a second-factor attempt by compare-and-set on the attempts value and
// the token_mac its read verified, and, when the booking hits no row, re-reads once. The booking
// and the re-read are their own READ COMMITTED statements, where a lost booking misses and the
// re-read sees the winner, also when the losing booking waits on the winner's row lock. The MAC
// guard makes a booking miss when a writer changed only the MAC; its control shows the same
// booking without the guard goes through. The last control holds why the factor check no longer
// reads inside a REPEATABLE READ transaction: there the lost booking is refused with 40001 and the
// case table is never reached (E-3280, E-3303). The token_mac column is the token branch's; it is
// added here if absent, so these cases hold the statement and not the code.

let owner: TestConnection;
let other: TestConnection;
let observer: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("booking_isolation");
	owner = migrated.connection;
	schema = migrated.schema;
	other = await openTestConnection();
	observer = await openTestConnection();
	await owner.query(
		`ALTER TABLE ${schema}.pending_authentication ADD COLUMN IF NOT EXISTS token_mac bytea`,
		[],
	);
});

afterAll(async () => {
	await dropSchema(owner, schema);
	await owner.close();
	await other.close();
	await observer.close();
});

interface PendingRow {
	readonly tokenHash: Uint8Array;
	readonly attempts: number;
	readonly mac: Buffer;
}

async function pendingRowWithMac(): Promise<PendingRow> {
	const userId = await createUser(owner, schema);
	const { token } = await beginPendingState(pendingAuthenticationsOn(owner, schema), userId);
	const tokenHash = hashPendingToken(token);
	const [row] = await owner.query<{ attempts: number; mac: Buffer }>(
		`UPDATE ${schema}.pending_authentication SET token_mac = decode(repeat('01', 32), 'hex')
		 WHERE token_sha256 = $1 RETURNING attempts, token_mac AS mac`,
		[tokenHash],
	);
	return { tokenHash, attempts: row?.attempts ?? -1, mac: Buffer.from(row?.mac ?? []) };
}

const WINNING_BOOKING = `UPDATE PENDING SET attempts = attempts + 1, token_mac = decode(repeat('02', 32), 'hex')
	WHERE token_sha256 = $1`;

function winningBooking(): string {
	return WINNING_BOOKING.replace("PENDING", `${schema}.pending_authentication`);
}

function booking(connection: TestConnection, row: PendingRow, guardTheMac = true) {
	const macCondition = guardTheMac ? "AND token_mac = $3" : "AND $3::bytea IS NOT NULL";
	return connection
		.query(
			`UPDATE ${schema}.pending_authentication
			 SET attempts = $2 + 1, token_mac = decode(repeat('03', 32), 'hex')
			 WHERE token_sha256 = $1 AND attempts = $2 ${macCondition} RETURNING attempts`,
			[row.tokenHash, row.attempts, row.mac],
		)
		.then(
			(rows) => (rows.length === 0 ? "missed" : "booked"),
			(error: { sqlState?: string; code?: string }) => error.sqlState ?? error.code ?? "error",
		);
}

async function attemptsNow(row: PendingRow): Promise<number> {
	const [now] = await observer.query<{ attempts: number }>(
		`SELECT attempts FROM ${schema}.pending_authentication WHERE token_sha256 = $1`,
		[row.tokenHash],
	);
	return now?.attempts ?? -1;
}

async function losingBookingAt(isolation: string): Promise<string> {
	const row = await pendingRowWithMac();
	await other.query(`BEGIN ISOLATION LEVEL ${isolation}`, []);
	try {
		await other.query(
			`SELECT attempts FROM ${schema}.pending_authentication WHERE token_sha256 = $1`,
			[row.tokenHash],
		);
		await owner.query(winningBooking(), [row.tokenHash]);
		return await booking(other, row);
	} finally {
		await other.query("ROLLBACK", []).catch(() => undefined);
	}
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

async function bookingAfterAWriterChangedOnlyTheMac(guardTheMac: boolean): Promise<string> {
	const row = await pendingRowWithMac();
	await owner.query(
		`UPDATE ${schema}.pending_authentication SET token_mac = decode(repeat('ee', 32), 'hex')
		 WHERE token_sha256 = $1`,
		[row.tokenHash],
	);
	return booking(other, row, guardTheMac);
}

describe("a booking that loses to a concurrent booking (section 3.18 point 3)", () => {
	it("at READ COMMITTED misses, so the re-read of the case table is reached", async () => {
		expect(await losingBookingAt("READ COMMITTED")).toBe("missed");
	});

	it("misses after waiting on the winner's row lock, and the re-read sees the winner's count", async () => {
		const row = await pendingRowWithMac();
		const loserBackend = await backendOf(other);
		await owner.query("BEGIN ISOLATION LEVEL READ COMMITTED", []);
		try {
			await owner.query(winningBooking(), [row.tokenHash]);
			const losing = booking(other, row);
			await untilWaiting(loserBackend);
			await owner.query("COMMIT", []);
			expect({ booking: await losing, reRead: await attemptsNow(row) }).toStrictEqual({
				booking: "missed",
				reRead: row.attempts + 1,
			});
		} finally {
			await owner.query("ROLLBACK", []).catch(() => undefined);
		}
	});

	it("misses when a writer changed only the MAC, because the booking compares it", async () => {
		expect(await bookingAfterAWriterChangedOnlyTheMac(true)).toBe("missed");
	});

	it("control: the same booking without the MAC in its condition books over the writer's MAC", async () => {
		expect(await bookingAfterAWriterChangedOnlyTheMac(false)).toBe("booked");
	});

	it("control: inside a REPEATABLE READ transaction is refused with 40001 instead", async () => {
		expect(await losingBookingAt("REPEATABLE READ")).toBe("40001");
	});
});
