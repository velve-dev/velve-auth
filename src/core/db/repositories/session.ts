import type { AuthenticationFactor, Session } from "../../http/caller.js";
import type { Actor } from "../actor.js";
import type { Driver } from "../driver.js";
import { qualifiedTableName } from "../identifier.js";

const AUTHENTICATION_FACTORS: readonly AuthenticationFactor[] = [
	"password",
	"totp",
	"webauthn",
	"recovery",
	"oauth",
];

export class PreviousSessionMissingError extends Error {
	readonly code = "previous_session_missing";

	constructor() {
		super("the session this re-issue replaces was already gone");
		this.name = "PreviousSessionMissingError";
	}
}

export class SessionOwnerMismatchError extends Error {
	readonly code = "session_owner_mismatch";

	constructor() {
		super("a session is replaced only by a session of the same user");
		this.name = "SessionOwnerMismatchError";
	}
}

export interface SessionInsert {
	readonly userId: string;
	readonly tokenHash: Uint8Array;
	readonly factors: readonly AuthenticationFactor[];
	readonly ipAddress: string | null;
	readonly userAgent: string | null;
	readonly idleTimeoutMs: number;
	readonly absoluteTimeoutMs: number;
}

export interface SessionWithOwner {
	readonly session: Session;
	readonly userId: string;
	readonly userDisabledAt: Date | null;
	/** The database's clock at the moment it answered, so no caller has to compare its own clock with the row. */
	readonly observedAt: Date;
}

export interface RemovedSession {
	readonly id: string;
	readonly userId: string;
}

interface SessionRepositoryOptions {
	readonly driver: Driver;
	readonly schema: string;
}

export interface SessionRepository {
	insertSession(input: SessionInsert): Promise<Session>;
	findSessionByTokenHash(tokenHash: Uint8Array): Promise<SessionWithOwner | null>;
	extendIdleDeadline(input: {
		readonly sessionId: string;
		readonly actor: Actor;
		readonly idleTimeoutMs: number;
		readonly writtenNoSoonerThanMs: number;
	}): Promise<Date | null>;
	deleteSessionByTokenHash(tokenHash: Uint8Array): Promise<RemovedSession | null>;
	listSessionsOwnedBy(input: {
		readonly actor: Actor;
		readonly currentSessionId: string;
	}): Promise<Session[]>;
	/** 3.15 G: the reading half of `FrozenRepositories`, which names an account and holds no proof of owning it. */
	listSessionsOfUser(input: { readonly userId: string }): Promise<Session[]>;
	/** The rows a revocation will remove, deadlines included, so what a hook is told matches what goes (E-765). */
	listEverySessionIdOwnedBy(input: { readonly actor: Actor }): Promise<string[]>;
	/** 3.15 G: `revokeSession` is given a session id and no owner, so the id is the whole predicate. */
	deleteSessionById(input: { readonly sessionId: string }): Promise<RemovedSession | null>;
	/** The owner a `SessionRevokeEvent` names, read before the row goes so the hook can still refuse (E-640). */
	findUserIdOfSession(input: { readonly sessionId: string }): Promise<string | null>;
	deleteSessionOwnedBy(input: {
		readonly sessionId: string;
		readonly actor: Actor;
	}): Promise<number>;
	deleteEverySessionOwnedBy(input: { readonly actor: Actor }): Promise<number>;
	deleteEveryOtherSessionOwnedBy(input: {
		readonly actor: Actor;
		readonly keptSessionId: string;
	}): Promise<number>;
	replaceSession(input: {
		readonly previousTokenHash: Uint8Array;
		readonly insert: SessionInsert;
	}): Promise<Session>;
	replaceEverySessionOfUser(input: {
		readonly actor: Actor;
		readonly insert: SessionInsert;
	}): Promise<Session>;
}

interface SessionRowShape {
	readonly id: string;
	readonly user_id: string;
	readonly created_at: unknown;
	readonly last_used_at: unknown;
	readonly idle_expires_at: unknown;
	readonly absolute_expires_at: unknown;
	readonly factors: string;
	readonly ip: string | null;
	readonly user_agent: string | null;
}

interface OwnedRowShape extends SessionRowShape {
	readonly disabled_at: unknown;
	readonly observed_at: unknown;
}

const SELECTED_COLUMNS = `id, user_id, created_at, last_used_at, idle_expires_at,
	absolute_expires_at, array_to_string(factors, ',') AS factors, ip, user_agent`;

/** Decoding a PostgreSQL type is the driver's work, not the repository's (E-227). */
function toDate(value: unknown): Date {
	if (value instanceof Date) {
		return value;
	}
	throw new TypeError("the driver must decode timestamptz into a Date");
}

function toOptionalDate(value: unknown): Date | null {
	return value === null || value === undefined ? null : toDate(value);
}

function isAuthenticationFactor(name: string): name is AuthenticationFactor {
	return (AUTHENTICATION_FACTORS as readonly string[]).includes(name);
}

function toFactors(joined: string): readonly AuthenticationFactor[] {
	if (joined === "") {
		return [];
	}
	const names = joined.split(",");
	for (const name of names) {
		if (!isAuthenticationFactor(name)) {
			throw new TypeError(`velve.session.factors holds a factor this library does not know`);
		}
	}
	return names.filter(isAuthenticationFactor);
}

/** The literal is built from a closed set, so no value from a request can reach it. */
function toFactorArray(factors: readonly AuthenticationFactor[]): string {
	for (const factor of factors) {
		if (!isAuthenticationFactor(factor)) {
			throw new TypeError(`velve.session.factors cannot hold "${factor}"`);
		}
	}
	return `{${[...new Set(factors)].join(",")}}`;
}

function toInterval(milliseconds: number): string {
	return `${Math.round(milliseconds)} milliseconds`;
}

/** 3.15 C: `isCurrent` is set in `session.list` and nowhere else, so everywhere else it is false. */
const NOT_LISTED = false;

function toSession(row: SessionRowShape, isCurrent: boolean): Session {
	return {
		id: row.id,
		userId: row.user_id,
		createdAt: toDate(row.created_at),
		lastUsedAt: toDate(row.last_used_at),
		idleExpiresAt: toDate(row.idle_expires_at),
		absoluteExpiresAt: toDate(row.absolute_expires_at),
		factors: toFactors(row.factors),
		ipAddress: row.ip,
		userAgent: row.user_agent,
		isCurrent,
	};
}

function insertStatement(table: string): string {
	return `INSERT INTO ${table}
		(user_id, token_sha256, idle_expires_at, absolute_expires_at, factors, ip, user_agent)
	VALUES ($1, $2, now() + $3::interval, now() + $4::interval, $5::text[], $6::inet, $7)
	RETURNING ${SELECTED_COLUMNS}`;
}

/**
 * S-CACHE-2: one query, joined on the user, filtered on the token hash and both deadlines, and
 * `disabled_at` read in the same statement so a disabled account cannot pass as signed in (L-4).
 */
function resolveStatement(table: string, users: string): string {
	return `SELECT s.id, s.user_id, s.created_at, s.last_used_at, s.idle_expires_at,
		s.absolute_expires_at, array_to_string(s.factors, ',') AS factors, s.ip, s.user_agent,
		u.disabled_at, now() AS observed_at
	FROM ${table} s
	JOIN ${users} u ON u.id = s.user_id
	WHERE s.token_sha256 = $1 AND s.idle_expires_at > now() AND s.absolute_expires_at > now()`;
}

/** The write interval is a condition of the statement, so two concurrent requests cannot both write. */
function extendIdleDeadlineStatement(table: string): string {
	return `UPDATE ${table}
	SET last_used_at = now(), idle_expires_at = now() + $3::interval
	WHERE id = $1 AND user_id = $2
		AND last_used_at <= now() - $4::interval
		AND idle_expires_at > now() AND absolute_expires_at > now()
	RETURNING idle_expires_at`;
}

function deleteByTokenHashStatement(table: string): string {
	return `DELETE FROM ${table} /* no owner predicate: S-OWNER-2, the predicate is the secret itself */
	WHERE token_sha256 = $1 RETURNING id, user_id`;
}

function deleteByIdStatement(table: string): string {
	return `DELETE FROM ${table} /* no owner predicate: S-OWNER-7, 3.15 G hands a plugin a session id and no owner to bind it to */
	WHERE id = $1 RETURNING id, user_id`;
}

function findUserIdStatement(table: string): string {
	return `SELECT user_id FROM ${table} WHERE id = $1`;
}

function deleteOwnedStatement(table: string): string {
	return `DELETE FROM ${table} WHERE id = $1 AND user_id = $2 RETURNING id`;
}

function deleteEveryOwnedStatement(table: string): string {
	return `DELETE FROM ${table} WHERE user_id = $1 RETURNING id`;
}

function deleteEveryOtherOwnedStatement(table: string): string {
	return `DELETE FROM ${table} WHERE user_id = $1 AND id <> $2 RETURNING id`;
}

function listEveryIdOwnedStatement(table: string): string {
	return `SELECT id FROM ${table} WHERE user_id = $1 ORDER BY created_at DESC, id`;
}

function listOwnedStatement(table: string): string {
	return `SELECT ${SELECTED_COLUMNS}
	FROM ${table}
	WHERE user_id = $1 AND idle_expires_at > now() AND absolute_expires_at > now()
	ORDER BY created_at DESC, id`;
}

function insertParameters(insert: SessionInsert): unknown[] {
	return [
		insert.userId,
		insert.tokenHash,
		toInterval(insert.idleTimeoutMs),
		toInterval(insert.absoluteTimeoutMs),
		toFactorArray(insert.factors),
		insert.ipAddress,
		insert.userAgent,
	];
}

export function createSessionRepository(options: SessionRepositoryOptions): SessionRepository {
	const table = qualifiedTableName(options.schema, "session");
	const users = qualifiedTableName(options.schema, "user");
	const insertSql = insertStatement(table);
	const resolveSql = resolveStatement(table, users);
	const extendSql = extendIdleDeadlineStatement(table);
	const deleteByTokenHashSql = deleteByTokenHashStatement(table);
	const deleteByIdSql = deleteByIdStatement(table);
	const findUserIdSql = findUserIdStatement(table);
	const deleteOwnedSql = deleteOwnedStatement(table);
	const deleteEveryOwnedSql = deleteEveryOwnedStatement(table);
	const deleteEveryOtherOwnedSql = deleteEveryOtherOwnedStatement(table);
	const listOwnedSql = listOwnedStatement(table);
	const listEveryIdOwnedSql = listEveryIdOwnedStatement(table);

	async function insertSession(driver: Driver, insert: SessionInsert): Promise<Session> {
		const [row] = await driver.query<SessionRowShape>(insertSql, insertParameters(insert));
		if (row === undefined) {
			throw new TypeError("the insert of a session returned no row");
		}
		return toSession(row, NOT_LISTED);
	}

	async function deleteSessionByTokenHash(
		driver: Driver,
		tokenHash: Uint8Array,
	): Promise<RemovedSession | null> {
		const [row] = await driver.query<{ id: string; user_id: string }>(deleteByTokenHashSql, [
			tokenHash,
		]);
		return row === undefined ? null : { id: row.id, userId: row.user_id };
	}

	return {
		insertSession: (insert) => insertSession(options.driver, insert),

		async findSessionByTokenHash(tokenHash) {
			const [row] = await options.driver.query<OwnedRowShape>(resolveSql, [tokenHash]);
			if (row === undefined) {
				return null;
			}
			return {
				session: toSession(row, NOT_LISTED),
				userId: row.user_id,
				userDisabledAt: toOptionalDate(row.disabled_at),
				observedAt: toDate(row.observed_at),
			};
		},

		async listEverySessionIdOwnedBy({ actor }) {
			const rows = await options.driver.query<{ id: string }>(listEveryIdOwnedSql, [actor]);
			return rows.map((row) => row.id);
		},

		async listSessionsOfUser({ userId }) {
			const rows = await options.driver.query<SessionRowShape>(listOwnedSql, [userId]);
			return rows.map((row) => toSession(row, NOT_LISTED));
		},

		async deleteSessionById({ sessionId }) {
			const [row] = await options.driver.query<{ id: string; user_id: string }>(deleteByIdSql, [
				sessionId,
			]);
			return row === undefined ? null : { id: row.id, userId: row.user_id };
		},

		async findUserIdOfSession({ sessionId }) {
			const [row] = await options.driver.query<{ user_id: string }>(findUserIdSql, [sessionId]);
			return row === undefined ? null : row.user_id;
		},

		async extendIdleDeadline({ sessionId, actor, idleTimeoutMs, writtenNoSoonerThanMs }) {
			const [row] = await options.driver.query<{ idle_expires_at: unknown }>(extendSql, [
				sessionId,
				actor,
				toInterval(idleTimeoutMs),
				toInterval(writtenNoSoonerThanMs),
			]);
			return row === undefined ? null : toDate(row.idle_expires_at);
		},

		deleteSessionByTokenHash: (tokenHash) => deleteSessionByTokenHash(options.driver, tokenHash),

		async listSessionsOwnedBy({ actor, currentSessionId }) {
			const rows = await options.driver.query<SessionRowShape>(listOwnedSql, [actor]);
			return rows.map((row) => toSession(row, row.id === currentSessionId));
		},

		async deleteSessionOwnedBy({ sessionId, actor }) {
			const rows = await options.driver.query(deleteOwnedSql, [sessionId, actor]);
			return rows.length;
		},

		async deleteEverySessionOwnedBy({ actor }) {
			const rows = await options.driver.query(deleteEveryOwnedSql, [actor]);
			return rows.length;
		},

		async deleteEveryOtherSessionOwnedBy({ actor, keptSessionId }) {
			const rows = await options.driver.query(deleteEveryOtherOwnedSql, [actor, keptSessionId]);
			return rows.length;
		},

		// S-FIX-1, E-23: the new row and the removal of the old one are one transaction, never an update.
		replaceSession({ previousTokenHash, insert }) {
			return options.driver.transaction(async (tx) => {
				const removed = await deleteSessionByTokenHash(tx, previousTokenHash);
				// E-239: the removal is what makes this a replacement; without it the caller ends up with two live sessions.
				if (removed === null) {
					throw new PreviousSessionMissingError();
				}
				if (removed.userId !== insert.userId) {
					throw new SessionOwnerMismatchError();
				}
				return insertSession(tx, insert);
			});
		},

		// S-FIX-6: every other session of the user goes, and there is no parameter that keeps one.
		async replaceEverySessionOfUser({ actor, insert }) {
			if (insert.userId !== actor) {
				throw new SessionOwnerMismatchError();
			}
			return options.driver.transaction(async (tx) => {
				await tx.query(deleteEveryOwnedSql, [actor]);
				return insertSession(tx, insert);
			});
		},
	};
}
