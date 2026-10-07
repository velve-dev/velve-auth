import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookAttemptOn } from "../src/core/factor/pending/booking.js";
import { MAXIMUM_PENDING_ATTEMPTS, type PendingToken } from "../src/core/factor/pending/index.js";
import { hashPendingToken } from "../src/core/factor/pending/token.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { beginPendingState, pendingAuthenticationsOn } from "./totp-fixtures.js";

//booking before evaluating spends exactly the budget under concurrent wrong codes (E-3208)

const GUESSES = 10;

let owner: TestConnection;
let others: TestConnection[] = [];
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("attempt_booking");
	owner = migrated.connection;
	schema = migrated.schema;
	others = await Promise.all(Array.from({ length: GUESSES }, () => openTestConnection()));
});

afterAll(async () => {
	await dropSchema(owner, schema);
	await owner.close();
	await Promise.all(others.map((connection) => connection.close()));
});

async function pendingRow(): Promise<{
	userId: string;
	token: PendingToken;
	tokenHash: Uint8Array;
}> {
	const userId = await createUser(owner, schema);
	const { token } = await beginPendingState(pendingAuthenticationsOn(owner, schema), userId);
	return { userId, token, tokenHash: hashPendingToken(token) };
}

async function attemptsOf(
	connection: TestConnection,
	tokenHash: Uint8Array,
): Promise<number | null> {
	const [row] = await connection.query<{ attempts: number }>(
		`SELECT attempts FROM ${schema}.pending_authentication WHERE token_sha256 = $1`,
		[tokenHash],
	);
	return row === undefined ? null : row.attempts;
}

async function bookOrRefuse(
	connection: TestConnection,
	tokenHash: Uint8Array,
): Promise<"booked" | "exhausted" | "missing"> {
	let pinned = await attemptsOf(connection, tokenHash);
	for (let round = 0; round <= MAXIMUM_PENDING_ATTEMPTS; round += 1) {
		if (pinned === null) {
			return "missing";
		}
		if (pinned >= MAXIMUM_PENDING_ATTEMPTS) {
			return "exhausted";
		}
		const hit = await connection.query(
			`UPDATE ${schema}.pending_authentication SET attempts = $3
			 WHERE token_sha256 = $1 AND attempts = $2 RETURNING attempts`,
			[tokenHash, pinned, pinned + 1],
		);
		if (hit.length === 1) {
			return "booked";
		}
		const reread = await attemptsOf(connection, tokenHash);
		if (reread !== null && reread <= pinned) {
			throw new Error("a re-read that did not rise is the manipulation case, not a race");
		}
		pinned = reread;
	}
	throw new Error("the booking did not settle within the attempt budget");
}

describe("premise: concurrent wrong second-factor codes on one pending authentication (L-8)", () => {
	it("the library's booking books exactly the budget and refuses the rest as exhausted", async () => {
		const { tokenHash, token } = await pendingRow();
		const outcomes = await Promise.all(
			others.map((connection) =>
				bookAttemptOn(pendingAuthenticationsOn(connection, schema), token),
			),
		);
		expect({
			booked: outcomes.filter((outcome) => outcome.outcome === "booked").length,
			exhausted: outcomes.filter((outcome) => outcome.outcome === "exhausted").length,
			attempts: await attemptsOf(owner, tokenHash),
		}).toStrictEqual({
			booked: MAXIMUM_PENDING_ATTEMPTS,
			exhausted: GUESSES - MAXIMUM_PENDING_ATTEMPTS,
			attempts: MAXIMUM_PENDING_ATTEMPTS,
		});
	});

	it("a count conditional on the verified value, every miss a refusal, counts one of ten", async () => {
		const { tokenHash } = await pendingRow();
		const hits = await Promise.all(
			others.map((connection) =>
				connection.query(
					`UPDATE ${schema}.pending_authentication SET attempts = attempts + 1
					 WHERE token_sha256 = $1 AND attempts = 0 RETURNING attempts`,
					[tokenHash],
				),
			),
		);
		expect(hits.filter((rows) => rows.length === 1).length).toBe(1);
	});

	it("booking before evaluating books exactly the budget and refuses the rest as exhausted", async () => {
		const { tokenHash } = await pendingRow();
		const outcomes = await Promise.all(
			others.map((connection) => bookOrRefuse(connection, tokenHash)),
		);
		expect({
			booked: outcomes.filter((outcome) => outcome === "booked").length,
			exhausted: outcomes.filter((outcome) => outcome === "exhausted").length,
			attempts: await attemptsOf(owner, tokenHash),
		}).toStrictEqual({
			booked: MAXIMUM_PENDING_ATTEMPTS,
			exhausted: GUESSES - MAXIMUM_PENDING_ATTEMPTS,
			attempts: MAXIMUM_PENDING_ATTEMPTS,
		});
	});
});
