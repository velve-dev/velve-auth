import { describe, expect, it } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import type { Driver } from "../src/core/db/driver.js";
import { createSessionRepository } from "../src/core/db/repositories/session.js";
import { createSessionToken } from "../src/core/session/token.js";
import { reassignsSessionOwner } from "../tools/session-owner-update.mjs";
import { sessionInsertFor } from "./session-fixtures.js";

const SCHEMA = "velve";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const ACTOR = USER_ID as Actor;

function recordingDriver(statements: string[]): Driver {
	const driver: Driver = {
		query: async (sql) => {
			statements.push(sql);
			return [];
		},
		transaction: (fn) => fn(driver),
	};
	return driver;
}

/**
 * The gate's scan reads source text, where this repository's table name is `${table}` and therefore
 * invisible to it (E-229). Here the statements are taken as they run, with the schema in place.
 */
async function statementsAsTheyRun(): Promise<string[]> {
	const statements: string[] = [];
	const sessions = createSessionRepository({
		driver: recordingDriver(statements),
		schema: SCHEMA,
	});
	const insert = sessionInsertFor(USER_ID);

	await sessions.insertSession(insert).catch(() => undefined);
	await sessions.findSessionByTokenHash(insert.tokenHash);
	await sessions.extendIdleDeadline({
		sessionId: SESSION_ID,
		actor: ACTOR,
		idleTimeoutMs: 1,
		writtenNoSoonerThanMs: 1,
	});
	await sessions.deleteSessionByTokenHash(createSessionToken().tokenHash);
	await sessions.deleteSessionOwnedBy({ sessionId: SESSION_ID, actor: ACTOR });
	await sessions.deleteEverySessionOwnedBy({ actor: ACTOR });
	await sessions.deleteEveryOtherSessionOwnedBy({ actor: ACTOR, keptSessionId: SESSION_ID });
	await sessions.listSessionsOwnedBy({ actor: ACTOR, currentSessionId: SESSION_ID });
	await sessions
		.replaceSession({ previousTokenHash: insert.tokenHash, insert })
		.catch(() => undefined);
	await sessions.replaceEverySessionOfUser({ actor: ACTOR, insert }).catch(() => undefined);

	return statements;
}

/** The rule test/db-static-sql.test.ts applies to the source, applied here to the statements as they run. */
const DECLARES_NO_ACTOR = /\/\*\s*no owner predicate:\s*S-[A-Z]+-\d+[\s\S]*?\*\//i;
const CHANGES_ROWS = /(?<!\bFOR\s{1,20})\b(DELETE\s+FROM|UPDATE)\b/i;

/** What S-FIX-2 is actually about: the columns a statement assigns, not the columns it filters on. */
function assignedColumns(sql: string): string {
	return /\bSET\b([\s\S]*?)\bWHERE\b/i.exec(sql)?.[1] ?? "";
}

describe("the statements this repository actually runs (S-FIX-2, E-23)", () => {
	it("names the session table in every one of them, so the scan has something to see", async () => {
		const statements = await statementsAsTheyRun();

		expect(statements.length).toBeGreaterThan(8);
		expect(statements.every((sql) => sql.includes(`${SCHEMA}.session`))).toBe(true);
	});

	it("assigns user_id in none of them", async () => {
		const writing = (await statementsAsTheyRun()).filter((sql) =>
			/^(INSERT|UPDATE|DELETE|MERGE)/.test(sql.trimStart()),
		);
		const reassigning = writing.filter((sql) => /\buser_id\b/.test(assignedColumns(sql)));

		expect(writing.length).toBeGreaterThan(4);
		expect(reassigning).toEqual([]);
		expect(writing.filter((sql) => /\bON\s+CONFLICT\b/i.test(sql))).toEqual([]);
	});

	it("gives every row-changing statement an owner predicate or a declared reason", async () => {
		const changing = (await statementsAsTheyRun()).filter((sql) => CHANGES_ROWS.test(sql));
		const unscoped = changing
			.filter((sql) => !DECLARES_NO_ACTOR.test(sql))
			.filter((sql) => {
				const predicate = sql.split(/\bRETURNING\b/i)[0] ?? "";
				return !/\bWHERE\b[\s\S]*\buser_id\s*=/i.test(predicate);
			});

		expect(changing.length).toBeGreaterThan(3);
		expect(unscoped).toEqual([]);
	});

	it("declares a reason in exactly the statement that cannot name an owner", async () => {
		const declaring = (await statementsAsTheyRun()).filter((sql) => DECLARES_NO_ACTOR.test(sql));

		expect(new Set(declaring).size).toBe(1);
		expect(declaring[0]).toContain("WHERE token_sha256 = $1");
	});

	it("would notice a reassignment written the way the trigger forbids", () => {
		expect(reassignsSessionOwner(`UPDATE ${SCHEMA}.session SET user_id = $1 WHERE id = $2`)).toBe(
			true,
		);
	});

	/** E-141 sharpened the gate's pattern to read the assignment list; this holds it to that. */
	it("is left alone by the gate's pattern too, now that it reads the assignment list", async () => {
		const flagged = (await statementsAsTheyRun()).filter(reassignsSessionOwner);

		expect(flagged).toEqual([]);
	});
});
