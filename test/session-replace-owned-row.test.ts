import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import {
	createSessionRepository,
	PreviousSessionMissingError,
	SessionOwnerMismatchError,
	type SessionRepository,
} from "../src/core/db/repositories/session.js";
import { createSessionService, type SessionService } from "../src/core/session/service.js";
import {
	actorOfTestUser,
	createUser,
	dropSchema,
	type MigratedSchema,
	openMigratedSchema,
} from "./db-fixtures.js";
import { sessionInsertFor } from "./session-fixtures.js";

/**
 * The primitive `identity.link.start` reaches for lives in a module three features are editing, and
 * until this file it was exercised only through the OAuth routes (E-966).
 */
let migrated: MigratedSchema;
let sessions: SessionRepository;
let service: SessionService;
let ownerId: string;
let owner: Actor;
let strangerId: string;

const NOTHING_OBSERVED = { ipAddress: null, userAgent: null };

async function countRows(userId: string): Promise<number> {
	const [row] = await migrated.connection.query<{ total: number }>(
		`SELECT count(*)::int AS total FROM ${migrated.schema}.session WHERE user_id = $1`,
		[userId],
	);
	return row?.total ?? -1;
}

beforeAll(async () => {
	migrated = await openMigratedSchema("velve_replace_owned");
	sessions = createSessionRepository({
		driver: migrated.connection,
		schema: migrated.schema,
	});
	service = createSessionService({ driver: migrated.connection, schema: migrated.schema });
	ownerId = await createUser(migrated.connection, migrated.schema);
	owner = actorOfTestUser(ownerId);
	strangerId = await createUser(migrated.connection, migrated.schema);
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("replaceSessionOwnedBy (S-FIX-1)", () => {
	it("removes the named row and inserts the new one, leaving the account's others alone", async () => {
		await sessions.deleteEverySessionOwnedBy({ actor: owner });
		const replaced = await sessions.insertSession(sessionInsertFor(ownerId));
		const untouched = await sessions.insertSession(sessionInsertFor(ownerId));

		const inserted = await sessions.replaceSessionOwnedBy({
			actor: owner,
			previousSessionId: replaced.id,
			insert: sessionInsertFor(ownerId),
		});

		const remaining = await sessions.listSessionsOfUser({ userId: ownerId });
		expect(remaining.map((session) => session.id).sort()).toEqual(
			[untouched.id, inserted.id].sort(),
		);
	});

	it("refuses a row that is already gone and inserts nothing in its place", async () => {
		await sessions.deleteEverySessionOwnedBy({ actor: owner });
		const previous = await sessions.insertSession(sessionInsertFor(ownerId));
		await sessions.deleteSessionOwnedBy({ sessionId: previous.id, actor: owner });

		await expect(
			sessions.replaceSessionOwnedBy({
				actor: owner,
				previousSessionId: previous.id,
				insert: sessionInsertFor(ownerId),
			}),
		).rejects.toBeInstanceOf(PreviousSessionMissingError);
		expect(await countRows(ownerId)).toBe(0);
	});

	/**
	 * An expired row lives until `maintenance.sweep()` removes it, so a delete without a deadline
	 * predicate matches it and the replacement succeeds — the same request granted or refused
	 * depending on whether garbage collection has run (E-971).
	 */
	it("refuses a row that is past its deadline but not yet swept", async () => {
		await sessions.deleteEverySessionOwnedBy({ actor: owner });
		const previous = await sessions.insertSession(sessionInsertFor(ownerId));
		await migrated.connection.query(
			`UPDATE ${migrated.schema}.session
			 SET idle_expires_at = now() - interval '1 second',
			     absolute_expires_at = now() - interval '1 second'
			 WHERE id = $1`,
			[previous.id],
		);

		await expect(
			sessions.replaceSessionOwnedBy({
				actor: owner,
				previousSessionId: previous.id,
				insert: sessionInsertFor(ownerId),
			}),
		).rejects.toBeInstanceOf(PreviousSessionMissingError);
		expect(await countRows(ownerId)).toBe(1);
		expect(await sessions.listSessionsOfUser({ userId: ownerId })).toEqual([]);
	});

	// L-4: the resolution joins `user` so a disabled account cannot pass as signed in; so does this.
	it("refuses a live row whose account is disabled", async () => {
		await sessions.deleteEverySessionOwnedBy({ actor: owner });
		const previous = await sessions.insertSession(sessionInsertFor(ownerId));
		await migrated.connection.query(
			`UPDATE ${migrated.schema}.user SET disabled_at = now() WHERE id = $1`,
			[ownerId],
		);

		await expect(
			sessions.replaceSessionOwnedBy({
				actor: owner,
				previousSessionId: previous.id,
				insert: sessionInsertFor(ownerId),
			}),
		).rejects.toBeInstanceOf(PreviousSessionMissingError);
		expect(await countRows(ownerId)).toBe(1);
		await migrated.connection.query(
			`UPDATE ${migrated.schema}.user SET disabled_at = NULL WHERE id = $1`,
			[ownerId],
		);
	});

	// The revoke path must still remove such a row, which is why the two deletes are separate statements.
	it("still lets a revocation remove the row a replacement refused", async () => {
		await sessions.deleteEverySessionOwnedBy({ actor: owner });
		const previous = await sessions.insertSession(sessionInsertFor(ownerId));
		await migrated.connection.query(
			`UPDATE ${migrated.schema}.session SET idle_expires_at = now() - interval '1 second'
			 WHERE id = $1`,
			[previous.id],
		);

		expect(await sessions.deleteSessionOwnedBy({ sessionId: previous.id, actor: owner })).toBe(1);
		expect(await countRows(ownerId)).toBe(0);
	});

	// S-OWNER-4: another account's session is neither replaced nor distinguishable from one that never existed.
	it("refuses a row that belongs to another account and leaves it standing", async () => {
		await sessions.deleteEverySessionOwnedBy({ actor: owner });
		const theirs = await sessions.insertSession(sessionInsertFor(strangerId));

		await expect(
			sessions.replaceSessionOwnedBy({
				actor: owner,
				previousSessionId: theirs.id,
				insert: sessionInsertFor(ownerId),
			}),
		).rejects.toBeInstanceOf(PreviousSessionMissingError);
		expect(await countRows(strangerId)).toBe(1);
		expect(await countRows(ownerId)).toBe(0);
	});

	it("refuses to insert a session for a user the actor is not", async () => {
		await expect(
			sessions.replaceSessionOwnedBy({
				actor: owner,
				previousSessionId: crypto.randomUUID(),
				insert: sessionInsertFor(strangerId),
			}),
		).rejects.toBeInstanceOf(SessionOwnerMismatchError);
	});
});

describe("reissueSessionOfUser (S-FIX-1)", () => {
	it("hands back a token the previous one cannot be mistaken for", async () => {
		await sessions.deleteEverySessionOwnedBy({ actor: owner });
		const previous = await service.issue({
			userId: ownerId,
			factors: ["oauth"],
			observed: NOTHING_OBSERVED,
		});

		const reissued = await service.reissueSessionOfUser({
			actor: owner,
			previousSessionId: previous.session.id,
			factors: ["oauth"],
			observed: NOTHING_OBSERVED,
		});

		expect(reissued.token).not.toBe(previous.token);
		expect(await service.resolve(previous.token)).toBeNull();
		expect(await service.resolve(reissued.token)).not.toBeNull();
		expect(await countRows(ownerId)).toBe(1);
	});

	it("passes the refusal through unmapped, so the caller decides what the outside learns", async () => {
		await sessions.deleteEverySessionOwnedBy({ actor: owner });

		await expect(
			service.reissueSessionOfUser({
				actor: owner,
				previousSessionId: crypto.randomUUID(),
				factors: ["oauth"],
				observed: NOTHING_OBSERVED,
			}),
		).rejects.toBeInstanceOf(PreviousSessionMissingError);
		expect(await countRows(ownerId)).toBe(0);
	});
});
