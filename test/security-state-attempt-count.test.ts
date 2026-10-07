import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAXIMUM_PENDING_ATTEMPTS } from "../src/core/factor/pending/index.js";
import { createPendingAuthenticationRepository } from "../src/core/factor/pending/repository.js";
import { hashPendingToken } from "../src/core/factor/pending/token.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { beginPendingState, pendingAuthenticationsOn } from "./totp-fixtures.js";

// A writer who holds a pending row sets attempts to 0 while an attempt waits on it. Section 3.18
// point 3 books every attempt by compare-and-set against the verified row before the code is
// evaluated; the writer's reset makes the booking miss, the re-read finds a count not above the
// pinned one with a MAC that does not match, and the row is answered as missing with the alarm.
// The booking is the token branch's (security-state-tokens), which also changes how the pinned
// values reach the repository; it adapts the call, turns the expected failure into a plain case
// and removes the control, which holds today's behaviour so that the expected failure cannot pass
// for a reason other than the one stated (E-3208).

let owner: TestConnection;
let writer: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("attempt_count");
	owner = migrated.connection;
	schema = migrated.schema;
	writer = await openTestConnection();
});

afterAll(async () => {
	await dropSchema(owner, schema);
	await owner.close();
	await writer.close();
});

async function backendOf(connection: TestConnection): Promise<number> {
	const [row] = await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid", []);
	if (row === undefined) {
		throw new Error("the connection named no backend");
	}
	return row.pid;
}

async function untilBlockedBy(waiter: number, holder: number): Promise<void> {
	for (let poll = 0; poll < 300; poll += 1) {
		const [row] = await writer.query<{ blocked: boolean }>(
			"SELECT $2::int = ANY (pg_blocking_pids($1::int)) AS blocked",
			[waiter, holder],
		);
		if (row?.blocked === true) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("the attempt never waited on the writer's row lock");
}

async function countWhileTheWriterResets(): Promise<unknown> {
	const userId = await createUser(owner, schema);
	const { token } = await beginPendingState(pendingAuthenticationsOn(owner, schema), userId);
	const tokenHash = hashPendingToken(token);
	const repository = createPendingAuthenticationRepository({ driver: owner, schema });
	for (let attempt = 1; attempt < MAXIMUM_PENDING_ATTEMPTS; attempt += 1) {
		await repository.countFailedAttempt({ tokenHash, maximumAttempts: MAXIMUM_PENDING_ATTEMPTS });
	}
	const ownerBackend = await backendOf(owner);
	const writerBackend = await backendOf(writer);

	await writer.query("BEGIN", []);
	try {
		await writer.query(
			`SELECT 1 FROM ${schema}.pending_authentication WHERE user_id = $1 FOR UPDATE`,
			[userId],
		);
		const counted = repository.countFailedAttempt({
			tokenHash,
			maximumAttempts: MAXIMUM_PENDING_ATTEMPTS,
		});
		await untilBlockedBy(ownerBackend, writerBackend);
		await writer.query(
			`UPDATE ${schema}.pending_authentication SET attempts = 0 WHERE user_id = $1`,
			[userId],
		);
		await writer.query("COMMIT", []);
		return await counted;
	} finally {
		await writer.query("ROLLBACK", []);
	}
}

describe("an attempt and a writer who resets the counter while it waits", () => {
	it("control: today the count carries the writer's reset forward", async () => {
		expect(await countWhileTheWriterResets()).toStrictEqual({ attempts: 1, exhausted: false });
	});

	it.fails("answers the row as missing instead of counting on from the reset", async () => {
		expect(await countWhileTheWriterResets()).toBeNull();
	});
});
