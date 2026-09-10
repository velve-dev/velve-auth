import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import {
	createSessionRepository,
	PreviousSessionMissingError,
	SessionOwnerMismatchError,
	type SessionRepository,
} from "../src/core/db/repositories/session.js";
import { createSessionToken } from "../src/core/session/token.js";
import {
	actorOfTestUser,
	createUser,
	dropSchema,
	type MigratedSchema,
	openMigratedSchema,
} from "./db-fixtures.js";
import {
	countingDriver,
	DAY,
	HOUR,
	MINUTE,
	sessionInsertFor,
	statementsMatching,
} from "./session-fixtures.js";

let migrated: MigratedSchema;
let sessions: SessionRepository;
let ownerId: string;
let owner: Actor;
let strangerId: string;
let stranger: Actor;

async function ageSession(sessionId: string, by: number): Promise<void> {
	const backwards = "make_interval(secs => $2::double precision)";
	await migrated.connection.query(
		`UPDATE ${migrated.schema}.session
		 SET created_at = created_at - ${backwards},
		     last_used_at = last_used_at - ${backwards},
		     idle_expires_at = idle_expires_at - ${backwards},
		     absolute_expires_at = absolute_expires_at - ${backwards}
		 WHERE id = $1 AND user_id = $3`,
		[sessionId, by / 1000, ownerId],
	);
}

async function expireSession(sessionId: string, column: string): Promise<void> {
	await migrated.connection.query(
		`UPDATE ${migrated.schema}.session
		 SET ${column} = now() - interval '1 second'
		 WHERE id = $1 AND user_id = $2`,
		[sessionId, ownerId],
	);
}

async function countRows(): Promise<number> {
	const [row] = await migrated.connection.query<{ total: number }>(
		`SELECT count(*)::int AS total FROM ${migrated.schema}.session WHERE user_id = $1`,
		[ownerId],
	);
	return row?.total ?? -1;
}

beforeAll(async () => {
	migrated = await openMigratedSchema("velve_session_repository");
	sessions = createSessionRepository({
		driver: migrated.connection,
		schema: migrated.schema,
	});
	ownerId = await createUser(migrated.connection, migrated.schema);
	owner = actorOfTestUser(ownerId);
	strangerId = await createUser(migrated.connection, migrated.schema);
	stranger = actorOfTestUser(strangerId);
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("inserting a session (architecture 3.5)", () => {
	it("writes the hash and nothing that could be replayed", async () => {
		const issued = createSessionToken();

		const session = await sessions.insertSession(
			sessionInsertFor(ownerId, { tokenHash: issued.tokenHash }),
		);
		const [row] = await migrated.connection.query<Record<string, unknown>>(
			`SELECT * FROM ${migrated.schema}.session WHERE id = $1`,
			[session.id],
		);

		expect(Buffer.from(row?.token_sha256 as Uint8Array)).toEqual(Buffer.from(issued.tokenHash));
		expect(JSON.stringify(row)).not.toContain(issued.token);
	});

	it("sets both deadlines from the database clock", async () => {
		const session = await sessions.insertSession(
			sessionInsertFor(ownerId, { idleTimeoutMs: 7 * DAY, absoluteTimeoutMs: 30 * DAY }),
		);
		const idleAfter = session.idleExpiresAt.getTime() - session.createdAt.getTime();
		const absoluteAfter = session.absoluteExpiresAt.getTime() - session.createdAt.getTime();

		expect(idleAfter).toBeGreaterThan(7 * DAY - MINUTE);
		expect(idleAfter).toBeLessThan(7 * DAY + MINUTE);
		expect(absoluteAfter).toBeGreaterThan(30 * DAY - MINUTE);
		expect(absoluteAfter).toBeLessThan(30 * DAY + MINUTE);
	});

	it("keeps the factors it was given and reads them back as an array", async () => {
		const session = await sessions.insertSession(
			sessionInsertFor(ownerId, { factors: ["password", "totp"] }),
		);

		expect(session.factors).toEqual(["password", "totp"]);
		expect(
			(await sessions.insertSession(sessionInsertFor(ownerId, { factors: [] }))).factors,
		).toEqual([]);
	});

	it("stores the metadata it was handed, and null when there is none", async () => {
		const session = await sessions.insertSession(
			sessionInsertFor(ownerId, { ipAddress: "203.0.113.0/24", userAgent: "Chrome on macOS" }),
		);

		expect(session.ipAddress).toBe("203.0.113.0/24");
		expect(session.userAgent).toBe("Chrome on macOS");
		expect((await sessions.insertSession(sessionInsertFor(ownerId))).ipAddress).toBeNull();
	});
});

describe("finding a session by its token hash (S-CACHE-2, S-TIM-4)", () => {
	it("answers with the session, its owner and the account state", async () => {
		const issued = createSessionToken();
		const inserted = await sessions.insertSession(
			sessionInsertFor(ownerId, { tokenHash: issued.tokenHash }),
		);

		const found = await sessions.findSessionByTokenHash(issued.tokenHash);

		expect(found?.session.id).toBe(inserted.id);
		expect(found?.userId).toBe(ownerId);
		expect(found?.userDisabledAt).toBeNull();
		expect(found?.observedAt.getTime()).toBeGreaterThanOrEqual(
			found?.session.createdAt.getTime() ?? 0,
		);
		// 3.15 C: the field is set in session.list and nowhere else.
		expect(found?.session.isCurrent).toBe(false);
	});

	it("answers null for a hash no row carries", async () => {
		expect(await sessions.findSessionByTokenHash(createSessionToken().tokenHash)).toBeNull();
	});

	it("answers null once either deadline has passed", async () => {
		for (const column of ["idle_expires_at", "absolute_expires_at"]) {
			const issued = createSessionToken();
			const session = await sessions.insertSession(
				sessionInsertFor(ownerId, { tokenHash: issued.tokenHash }),
			);
			await expireSession(session.id, column);

			expect({ column, found: await sessions.findSessionByTokenHash(issued.tokenHash) }).toEqual({
				column,
				found: null,
			});
		}
	});

	it("costs exactly one statement per answer, however often it is asked (S-CACHE-1)", async () => {
		const counted = countingDriver(migrated.connection);
		const counting = createSessionRepository({ driver: counted.driver, schema: migrated.schema });
		const issued = createSessionToken();
		await counting.insertSession(sessionInsertFor(ownerId, { tokenHash: issued.tokenHash }));
		counted.reset();

		for (let call = 0; call < 5; call += 1) {
			expect((await counting.findSessionByTokenHash(issued.tokenHash))?.userId).toBe(ownerId);
		}

		expect(counted.statements).toHaveLength(5);
		expect(statementsMatching(counted, /FROM \S+\.session s/)).toHaveLength(5);
	});
});

describe("extending the idle deadline (architecture 3.5)", () => {
	it("writes nothing while the write interval has not passed", async () => {
		const session = await sessions.insertSession(sessionInsertFor(ownerId));

		const extended = await sessions.extendIdleDeadline({
			sessionId: session.id,
			actor: owner,
			idleTimeoutMs: 7 * DAY,
			writtenNoSoonerThanMs: HOUR,
		});

		expect(extended).toBeNull();
	});

	it("writes once the interval has passed, and moves only the idle deadline", async () => {
		const issued = createSessionToken();
		const session = await sessions.insertSession(
			sessionInsertFor(ownerId, { tokenHash: issued.tokenHash }),
		);
		await ageSession(session.id, 2 * HOUR);
		const aged = await sessions.findSessionByTokenHash(issued.tokenHash);

		const extended = await sessions.extendIdleDeadline({
			sessionId: session.id,
			actor: owner,
			idleTimeoutMs: 7 * DAY,
			writtenNoSoonerThanMs: HOUR,
		});
		const after = await sessions.findSessionByTokenHash(issued.tokenHash);

		expect(extended).not.toBeNull();
		expect(after?.session.idleExpiresAt.getTime()).toBeGreaterThan(
			aged?.session.idleExpiresAt.getTime() ?? 0,
		);
		expect(after?.session.absoluteExpiresAt).toEqual(aged?.session.absoluteExpiresAt);
		expect(after?.session.createdAt).toEqual(aged?.session.createdAt);
	});

	it("writes nothing for a session of another user", async () => {
		const session = await sessions.insertSession(sessionInsertFor(ownerId));
		await ageSession(session.id, 2 * HOUR);

		const extended = await sessions.extendIdleDeadline({
			sessionId: session.id,
			actor: stranger,
			idleTimeoutMs: 7 * DAY,
			writtenNoSoonerThanMs: HOUR,
		});

		expect(extended).toBeNull();
	});
});

describe("removing sessions (S-OWNER-2, S-OWNER-4)", () => {
	it("removes the row a token addresses and reports whose it was", async () => {
		const issued = createSessionToken();
		const session = await sessions.insertSession(
			sessionInsertFor(ownerId, { tokenHash: issued.tokenHash }),
		);

		expect(await sessions.deleteSessionByTokenHash(issued.tokenHash)).toEqual({
			id: session.id,
			userId: ownerId,
		});
		expect(await sessions.deleteSessionByTokenHash(issued.tokenHash)).toBeNull();
	});

	it("removes a session of another user through no method", async () => {
		const session = await sessions.insertSession(sessionInsertFor(ownerId));

		expect(await sessions.deleteSessionOwnedBy({ sessionId: session.id, actor: stranger })).toBe(0);
		expect(await sessions.deleteEverySessionOwnedBy({ actor: stranger })).toBe(0);
		expect(await sessions.deleteSessionOwnedBy({ sessionId: session.id, actor: owner })).toBe(1);
	});

	it("answers a session that never existed exactly as one that belongs elsewhere", async () => {
		const session = await sessions.insertSession(sessionInsertFor(ownerId));
		const invented = "00000000-0000-4000-8000-000000000000";

		expect(await sessions.deleteSessionOwnedBy({ sessionId: invented, actor: stranger })).toBe(
			await sessions.deleteSessionOwnedBy({ sessionId: session.id, actor: stranger }),
		);
	});

	it("keeps exactly the session it was told to keep", async () => {
		await sessions.deleteEverySessionOwnedBy({ actor: owner });
		const kept = await sessions.insertSession(sessionInsertFor(ownerId));
		await sessions.insertSession(sessionInsertFor(ownerId));
		await sessions.insertSession(sessionInsertFor(ownerId));

		const removed = await sessions.deleteEveryOtherSessionOwnedBy({
			actor: owner,
			keptSessionId: kept.id,
		});

		expect(removed).toBe(2);
		expect(await countRows()).toBe(1);
	});
});

describe("replacing a session (S-FIX-1, E-23)", () => {
	it("inserts the new row and removes the old one in one transaction", async () => {
		const previous = createSessionToken();
		const old = await sessions.insertSession(
			sessionInsertFor(ownerId, { tokenHash: previous.tokenHash }),
		);
		const next = createSessionToken();

		const replacement = await sessions.replaceSession({
			previousTokenHash: previous.tokenHash,
			insert: sessionInsertFor(ownerId, {
				tokenHash: next.tokenHash,
				factors: ["password", "totp"],
			}),
		});

		expect(replacement.id).not.toBe(old.id);
		expect(replacement.factors).toEqual(["password", "totp"]);
		expect(await sessions.findSessionByTokenHash(previous.tokenHash)).toBeNull();
		expect((await sessions.findSessionByTokenHash(next.tokenHash))?.session.id).toBe(
			replacement.id,
		);
	});

	it("issues nothing when the session it was to replace is already gone (E-239)", async () => {
		const before = await countRows();

		await expect(
			sessions.replaceSession({
				previousTokenHash: createSessionToken().tokenHash,
				insert: sessionInsertFor(ownerId),
			}),
		).rejects.toBeInstanceOf(PreviousSessionMissingError);
		expect(await countRows()).toBe(before);
	});

	it("refuses to hand a user's session to another user", async () => {
		const previous = createSessionToken();
		await sessions.insertSession(sessionInsertFor(ownerId, { tokenHash: previous.tokenHash }));

		await expect(
			sessions.replaceSession({
				previousTokenHash: previous.tokenHash,
				insert: sessionInsertFor(strangerId),
			}),
		).rejects.toBeInstanceOf(SessionOwnerMismatchError);
		expect(await sessions.findSessionByTokenHash(previous.tokenHash)).not.toBeNull();
	});

	it("replaces every session of the user when the credentials changed (S-FIX-6)", async () => {
		await sessions.deleteEverySessionOwnedBy({ actor: owner });
		const elsewhere = createSessionToken();
		await sessions.insertSession(sessionInsertFor(ownerId, { tokenHash: elsewhere.tokenHash }));
		await sessions.insertSession(sessionInsertFor(ownerId));

		const replacement = await sessions.replaceEverySessionOfUser({
			actor: owner,
			insert: sessionInsertFor(ownerId),
		});

		expect(await countRows()).toBe(1);
		expect(await sessions.findSessionByTokenHash(elsewhere.tokenHash)).toBeNull();
		expect(replacement.userId).toBe(ownerId);
	});

	it("refuses to replace the sessions of a user the actor is not", async () => {
		await expect(
			sessions.replaceEverySessionOfUser({ actor: stranger, insert: sessionInsertFor(ownerId) }),
		).rejects.toBeInstanceOf(SessionOwnerMismatchError);
	});
});

describe("listing sessions (3.15 B.2)", () => {
	it("lists only the caller's live sessions, newest first, marking the current one", async () => {
		await sessions.deleteEverySessionOwnedBy({ actor: owner });
		const first = await sessions.insertSession(sessionInsertFor(ownerId));
		const second = await sessions.insertSession(sessionInsertFor(ownerId));
		const expired = await sessions.insertSession(sessionInsertFor(ownerId));
		await expireSession(expired.id, "idle_expires_at");
		await sessions.insertSession(sessionInsertFor(strangerId));

		const listed = await sessions.listSessionsOwnedBy({
			actor: owner,
			currentSessionId: second.id,
		});

		expect(listed.map((session) => session.id)).toEqual([second.id, first.id]);
		expect(listed.map((session) => session.isCurrent)).toEqual([true, false]);
	});

	it("lists nothing for a user with no session", async () => {
		await sessions.deleteEverySessionOwnedBy({ actor: stranger });

		expect(
			await sessions.listSessionsOwnedBy({ actor: stranger, currentSessionId: "none" }),
		).toEqual([]);
	});
});
