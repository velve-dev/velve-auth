import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import type { Driver } from "../src/core/db/driver.js";
import {
	createSessionRepository,
	SessionOwnerMismatchError,
	type SessionRepository,
} from "../src/core/db/repositories/session.js";
import { createSessionService, type SessionService } from "../src/core/session/service.js";
import { createSessionToken, sessionTokenHash } from "../src/core/session/token.js";
import {
	actorOfTestUser,
	createUser,
	dropSchema,
	type MigratedSchema,
	openMigratedSchema,
} from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { sessionInsertFor, testClock } from "./session-fixtures.js";

const NOWHERE = { ipAddress: null, userAgent: null };

interface Traced {
	readonly driver: Driver;
	readonly log: string[];
	reset(): void;
}

function verbOf(sql: string): string {
	return sql.trimStart().split(/\s+/, 1)[0]?.toUpperCase() ?? "";
}

function tracingDriver(inner: Driver): Traced {
	const log: string[] = [];

	function wrap(target: Driver, inside: boolean): Driver {
		return {
			query(sql, params) {
				log.push(inside ? `tx ${verbOf(sql)}` : verbOf(sql));
				return target.query(sql, params);
			},
			transaction(fn) {
				log.push("BEGIN");
				return target
					.transaction((tx) => fn(wrap(tx, true)))
					.then(
						(value) => {
							log.push("COMMIT");
							return value;
						},
						(error: unknown) => {
							log.push("ROLLBACK");
							throw error;
						},
					);
			},
		};
	}

	return { driver: wrap(inner, false), log, reset: () => log.splice(0, log.length) };
}

let migrated: MigratedSchema;
let traced: Traced;
let service: SessionService;
let sessions: SessionRepository;
let userId: string;
let owner: Actor;
let strangerId: string;

async function liveSessionsOf(user: string): Promise<number> {
	const [row] = await migrated.connection.query<{ total: number }>(
		`SELECT count(*)::int AS total FROM ${migrated.schema}.session
		 WHERE user_id = $1 AND idle_expires_at > now() AND absolute_expires_at > now()`,
		[user],
	);
	return row?.total ?? -1;
}

async function rowsWithTokenHash(token: string): Promise<number> {
	const [row] = await migrated.connection.query<{ total: number }>(
		`SELECT count(*)::int AS total FROM ${migrated.schema}.session WHERE token_sha256 = $1`,
		[sessionTokenHash(token)],
	);
	return row?.total ?? -1;
}

beforeAll(async () => {
	migrated = await openMigratedSchema("velve_review_reissue");
	traced = tracingDriver(migrated.connection);
	service = createSessionService({
		driver: traced.driver,
		schema: migrated.schema,
		clock: testClock(),
	});
	sessions = createSessionRepository({ driver: traced.driver, schema: migrated.schema });
	userId = await createUser(migrated.connection, migrated.schema);
	owner = actorOfTestUser(userId);
	strangerId = await createUser(migrated.connection, migrated.schema);
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("E-23, S-FIX-1: a re-issue is an INSERT and a DELETE in one transaction", () => {
	it("runs one transaction holding one DELETE and one INSERT, and no UPDATE", async () => {
		const previous = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		traced.reset();

		await service.reissue({
			previousToken: previous.token,
			userId,
			factors: ["password", "totp"],
			observed: NOWHERE,
		});

		expect(traced.log).toEqual(["BEGIN", "tx DELETE", "tx INSERT", "COMMIT"]);
	});

	it("does the same when every other session goes with it", async () => {
		const here = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		const resolved = await service.resolve(here.token);
		if (resolved === null) {
			throw new Error("the session under test did not resolve");
		}
		traced.reset();

		await service.reissueAfterCredentialChange({
			resolved,
			factors: ["password"],
			observed: NOWHERE,
		});

		expect(traced.log).toEqual(["BEGIN", "tx DELETE", "tx INSERT", "COMMIT"]);
	});

	it("leaves the previous row in place when the insert fails halfway", async () => {
		const previous = createSessionToken();
		await sessions.insertSession(sessionInsertFor(userId, { tokenHash: previous.tokenHash }));
		traced.reset();

		await expect(
			sessions.replaceSession({
				previousTokenHash: previous.tokenHash,
				insert: sessionInsertFor(randomUUID()),
			}),
		).rejects.toBeDefined();

		expect(traced.log.at(-1)).toBe("ROLLBACK");
		expect(await sessions.findSessionByTokenHash(previous.tokenHash)).not.toBeNull();
	});

	it("refuses a replacement whose owner differs, and keeps the row it was about to remove", async () => {
		const previous = createSessionToken();
		await sessions.insertSession(sessionInsertFor(userId, { tokenHash: previous.tokenHash }));
		const before = await liveSessionsOf(strangerId);

		await expect(
			sessions.replaceSession({
				previousTokenHash: previous.tokenHash,
				insert: sessionInsertFor(strangerId),
			}),
		).rejects.toBeInstanceOf(SessionOwnerMismatchError);

		expect(await sessions.findSessionByTokenHash(previous.tokenHash)).not.toBeNull();
		expect(await liveSessionsOf(strangerId)).toBe(before);
	});

	it("refuses the same at the service, so no caller can move a session between accounts", async () => {
		const previous = await service.issue({ userId, factors: ["password"], observed: NOWHERE });

		await expect(
			service.reissue({
				previousToken: previous.token,
				userId: strangerId,
				factors: ["password"],
				observed: NOWHERE,
			}),
		).rejects.toBeInstanceOf(SessionOwnerMismatchError);

		expect(await rowsWithTokenHash(previous.token)).toBe(1);
	});

	it("leaves the previous token addressing nothing afterwards (S-FIX-3)", async () => {
		const previous = await service.issue({ userId, factors: ["password"], observed: NOWHERE });

		const next = await service.reissue({
			previousToken: previous.token,
			userId,
			factors: ["password", "webauthn"],
			observed: NOWHERE,
		});

		expect(await rowsWithTokenHash(previous.token)).toBe(0);
		expect(next.token).not.toBe(previous.token);
		expect(await service.resolve(previous.token)).toBe(
			await service.resolve(createSessionToken().token),
		);
	});
});

describe("S-FIX-2: the trigger is the second lock, and the code does not lean on it", () => {
	it("refuses an owner reassignment written directly against the table", async () => {
		const session = await sessions.insertSession(sessionInsertFor(userId));

		const failure = await migrated.connection
			.query(`UPDATE ${migrated.schema}.session SET user_id = $2 WHERE id = $1`, [
				session.id,
				strangerId,
			])
			.then(() => null)
			.catch((error: unknown) => error as { sqlState?: string });

		expect(failure).not.toBeNull();
		expect(failure?.sqlState).not.toBe("00000");
	});

	it("assigns user_id in none of the statements the repository runs", async () => {
		const assigning: string[] = [];
		const recording: Driver = {
			query: async (sql: string) => {
				const assigned = /\bSET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(sql)?.[1] ?? "";
				if (/\buser_id\b/.test(assigned)) {
					assigning.push(sql);
				}
				return [];
			},
			transaction: (fn) => fn(recording),
		};
		const quiet = createSessionRepository({ driver: recording, schema: "velve" });
		const insert = sessionInsertFor(userId);

		await quiet.insertSession(insert).catch(() => undefined);
		await quiet.findSessionByTokenHash(insert.tokenHash);
		await quiet.extendIdleDeadline({
			sessionId: randomUUID(),
			actor: owner,
			idleTimeoutMs: 1,
			writtenNoSoonerThanMs: 1,
		});
		await quiet.deleteSessionByTokenHash(insert.tokenHash);
		await quiet.deleteSessionOwnedBy({ sessionId: randomUUID(), actor: owner });
		await quiet.deleteEverySessionOwnedBy({ actor: owner });
		await quiet.deleteEveryOtherSessionOwnedBy({ actor: owner, keptSessionId: randomUUID() });
		await quiet.replaceSession({ previousTokenHash: insert.tokenHash, insert }).catch(() => {});
		await quiet.replaceEverySessionOfUser({ actor: owner, insert }).catch(() => {});

		expect(assigning).toEqual([]);
	});
});

describe("two re-issues of one session at the same moment", () => {
	it("leaves one live session behind, not two", async () => {
		const second: TestConnection = await openTestConnection();
		const other = createSessionRepository({ driver: second, schema: migrated.schema });
		const previous = createSessionToken();
		await sessions.deleteEverySessionOwnedBy({ actor: owner });
		await sessions.insertSession(sessionInsertFor(userId, { tokenHash: previous.tokenHash }));

		await Promise.allSettled([
			sessions.replaceSession({
				previousTokenHash: previous.tokenHash,
				insert: sessionInsertFor(userId),
			}),
			other.replaceSession({
				previousTokenHash: previous.tokenHash,
				insert: sessionInsertFor(userId),
			}),
		]);
		const live = await liveSessionsOf(userId);
		await second.close();

		expect(live).toBe(1);
	});
});
