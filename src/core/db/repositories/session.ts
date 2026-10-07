import type { AuthenticationFactor, Session } from "../../http/caller.js";
import { ConcealedError } from "../../http/error-map.js";
import type { KeyProvider } from "../../keys/provider.js";
import { isLibrarySessionRow } from "../../session/binding.js";
import type { StoredTokenMac, TokenBindingRefusalReport } from "../../token/binding.js";
import type { Actor } from "../actor.js";
import type { Driver } from "../driver.js";
import { qualifiedTableName } from "../identifier.js";
import { lockAccountRow } from "../lock.js";

/** whether every account must have a seal row, or one without is still served while it is sealed */
export type SecurityStateSealing = "required" | "migrating";

//an unsealed account is at the first epoch in "migrating" and at none in "required" (E-3142)
const FIRST_SESSION_EPOCH = 1;

function epochOf(storedEpoch: string, sealing: SecurityStateSealing): string {
	return sealing === "migrating" ? `COALESCE(${storedEpoch}, ${FIRST_SESSION_EPOCH})` : storedEpoch;
}

function epochOfAccount(states: string, sealing: SecurityStateSealing): string {
	return epochOf(`(SELECT session_epoch FROM ${states} WHERE user_id = $1)`, sealing);
}

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
	/** takes the token MAC over the session epoch the inserting statement's transaction reads */
	bindUnderEpoch(sessionEpoch: number): Promise<StoredTokenMac>;
}

export interface SessionWithOwner {
	readonly session: Session;
	readonly userId: string;
	readonly userDisabledAt: Date | null;
	//callers use the db clock and never compare their own clock with the row (E-238)
	readonly observedAt: Date;
}

/** a row found by its token hash whose MAC is still to be checked before anything in it is used */
export interface SessionCandidate extends StoredTokenMac {
	readonly sessionId: string;
	readonly userId: string;
	/** the factor names exactly as stored, or null where the column holds something that is no name */
	readonly storedFactorNames: readonly string[] | null;
	/** the account's current session epoch, or null for an account that has none to be checked against */
	readonly sessionEpoch: number | null;
	decode(): SessionWithOwner;
}

export interface RemovedSession {
	readonly id: string;
	readonly userId: string;
}

interface SessionRepositoryOptions {
	readonly driver: Driver;
	readonly schema: string;
	//a repository that lists rows must hold the key that checks them (S-INTEG-9)
	readonly keys: KeyProvider;
	//a caller that names no mode gets the one that refuses an account without a seal row (S-INTEG-4)
	readonly sealing?: SecurityStateSealing;
	readonly reportTokenBindingRefusal?: TokenBindingRefusalReport;
}

export interface SessionRepository {
	/** the same repository, keys and mode over another driver */
	boundTo(driver: Driver): SessionRepository;
	insertSession(input: SessionInsert): Promise<Session>;
	findSessionByTokenHash(tokenHash: Uint8Array): Promise<SessionCandidate | null>;
	//a concurrent rebinding must not be overwritten (S-KEY-5)
	rebindSessionTokenMac(input: {
		readonly actor: Actor;
		readonly sessionId: string;
		readonly previous: StoredTokenMac;
		readonly next: StoredTokenMac;
	}): Promise<void>;
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
	//reading needs no proof of ownership so this takes a plain user id
	listSessionsOfUser(input: { readonly userId: string }): Promise<Session[]>;
	//deadlines are ignored so a hook is told exactly the rows a revocation removes (E-765)
	listEverySessionIdOwnedBy(input: { readonly actor: Actor }): Promise<string[]>;
	//the owner read before the announcement stands in the predicate so only the announced row goes (S-OWNER-2)
	deleteSessionById(input: {
		readonly sessionId: string;
		readonly ownerReadBefore: string;
	}): Promise<number>;
	//the owner is read before the row goes so the revoke hook can still refuse (E-640)
	findUserIdOfSession(input: { readonly sessionId: string }): Promise<string | null>;
	deleteSessionOwnedBy(input: {
		readonly sessionId: string;
		readonly actor: Actor;
	}): Promise<number>;
	deleteEverySessionOwnedBy(input: { readonly actor: Actor }): Promise<number>;
	deleteEverySessionOwnedByReturningIds(input: { readonly actor: Actor }): Promise<string[]>;
	deleteEveryOtherSessionOwnedBy(input: {
		readonly actor: Actor;
		readonly keptSessionId: string;
	}): Promise<number>;
	replaceSession(input: {
		readonly previousTokenHash: Uint8Array;
		readonly insert: SessionInsert;
	}): Promise<Session>;
	//the predicate is the presented secret so its row goes whoever owns it (E-2120)
	replacePresentedSession(input: {
		readonly presentedTokenHash: Uint8Array | null;
		readonly insert: SessionInsert;
	}): Promise<Session>;
	replaceEverySessionOfUser(input: {
		readonly actor: Actor;
		readonly insert: SessionInsert;
	}): Promise<Session>;
	//only a live row of an enabled account can authorise its own replacement (E-971)
	replaceSessionOwnedBy(input: {
		readonly actor: Actor;
		readonly previousSessionId: string;
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

interface ListedRowShape extends SessionRowShape {
	readonly token_sha256: Uint8Array;
	readonly factor_names: string;
	readonly token_mac: Uint8Array;
	readonly token_mac_key_version: number;
	readonly session_epoch: string | null;
}

interface OwnedRowShape extends Omit<SessionRowShape, "factors"> {
	readonly factor_names: string;
	readonly session_epoch: string | null;
	readonly token_mac: Uint8Array;
	readonly token_mac_key_version: number;
	readonly disabled_at: unknown;
	readonly observed_at: unknown;
}

const SELECTED_COLUMNS = `id, user_id, created_at, last_used_at, idle_expires_at,
	absolute_expires_at, array_to_string(factors, ',') AS factors, ip, user_agent`;

//an invalid date is still a date so an out of range deadline must be caught here (E-1584)
function toDate(value: unknown): Date {
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return value;
	}
	throw new TypeError("the driver must decode timestamptz into a Date this runtime can hold");
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

//a comma inside a factor name must not split it in two (S-INTEG-9)
function storedNamesOf(json: string): readonly string[] | null {
	const names: unknown = JSON.parse(json);
	return Array.isArray(names) && names.every((name) => typeof name === "string") ? names : null;
}

//the array literal is built from a closed set so no request value can reach it
function toFactorArray(factors: readonly AuthenticationFactor[]): string {
	for (const factor of factors) {
		if (!isAuthenticationFactor(factor)) {
			throw new TypeError(`velve.session.factors cannot hold "${factor}"`);
		}
	}
	return `{${[...new Set(factors)].join(",")}}`;
}

//deadlines use make interval as postgresql 14 overflows the interval literal (E-1571)
function secondsOf(milliseconds: number): number {
	return Math.round(milliseconds) / 1000;
}

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

//a session must be written only while the account is at the epoch its mac binds (S-INTEG-9)
function insertStatement(table: string, states: string, sealing: SecurityStateSealing): string {
	return `INSERT INTO ${table}
		(user_id, token_sha256, idle_expires_at, absolute_expires_at, factors, ip, user_agent,
			token_mac, token_mac_key_version)
	SELECT $1, $2, now() + make_interval(secs => $3::double precision),
		now() + make_interval(secs => $4::double precision), $5::text[], $6::inet, $7, $8, $9
	WHERE ${epochOfAccount(states, sealing)} = $10::bigint
	RETURNING ${SELECTED_COLUMNS}`;
}

//one joined query reads disabled at so a disabled account cannot pass as signed in (S-CACHE-2)
function resolveStatement(
	table: string,
	users: string,
	states: string,
	sealing: SecurityStateSealing,
): string {
	return `SELECT s.id, s.user_id, s.created_at, s.last_used_at, s.idle_expires_at,
		s.absolute_expires_at, array_to_json(s.factors)::text AS factor_names, s.ip, s.user_agent,
		s.token_mac, s.token_mac_key_version, u.disabled_at, now() AS observed_at,
		${epochOf("st.session_epoch", sealing)}::text AS session_epoch
	FROM ${table} s
	JOIN ${users} u ON u.id = s.user_id
	LEFT JOIN ${states} st ON st.user_id = s.user_id
	WHERE s.token_sha256 = $1 AND s.idle_expires_at > now() AND s.absolute_expires_at > now()`;
}

//the write interval sits in the statement so two concurrent requests cannot both write
function extendIdleDeadlineStatement(table: string): string {
	return `UPDATE ${table}
	SET last_used_at = now(), idle_expires_at = now() + make_interval(secs => $3::double precision)
	WHERE id = $1 AND user_id = $2
		AND last_used_at <= now() - make_interval(secs => $4::double precision)
		AND idle_expires_at > now() AND absolute_expires_at > now()
	RETURNING idle_expires_at`;
}

function rebindStatement(table: string): string {
	return `UPDATE ${table} SET token_mac = $3, token_mac_key_version = $4
	WHERE id = $1 AND user_id = $6 AND token_mac = $2 AND token_mac_key_version = $5`;
}

function deleteByTokenHashStatement(table: string): string {
	return `DELETE FROM ${table} /* no owner predicate: S-OWNER-2, the predicate is the secret itself */
	WHERE token_sha256 = $1 RETURNING id, user_id`;
}

function findUserIdStatement(table: string): string {
	return `SELECT user_id FROM ${table} WHERE id = $1`;
}

function deleteOwnedStatement(table: string): string {
	return `DELETE FROM ${table} WHERE id = $1 AND user_id = $2 RETURNING id`;
}

//a replacement removes only a row that still authorises something (E-976)
function deleteLiveOwnedStatement(table: string, users: string): string {
	return `DELETE FROM ${table} s
	USING ${users} u
	WHERE s.id = $1 AND s.user_id = $2 AND u.id = s.user_id
		AND u.disabled_at IS NULL
		AND s.idle_expires_at > now() AND s.absolute_expires_at > now()
	RETURNING s.id`;
}

function currentEpochStatement(states: string, sealing: SecurityStateSealing): string {
	return `SELECT ${epochOfAccount(states, sealing)}::text AS session_epoch`;
}

//a bigint arrives as text and must be an exact epoch before it is used
function toEpoch(value: string | null): number | null {
	if (value === null) {
		return null;
	}
	const epoch = Number(value);
	if (!Number.isSafeInteger(epoch) || epoch < FIRST_SESSION_EPOCH) {
		throw new TypeError("velve.security_state.session_epoch holds no epoch this library writes");
	}
	return epoch;
}

function deleteEveryOwnedStatement(table: string): string {
	return `DELETE FROM ${table} WHERE user_id = $1 RETURNING id`;
}

function deleteEveryOtherOwnedStatement(table: string): string {
	return `DELETE FROM ${table} WHERE user_id = $1 AND id <> $2 RETURNING id`;
}

//a listed row must be checkable before it is shown (S-INTEG-9)
function listedColumns(sealing: SecurityStateSealing): string {
	return `s.id, s.user_id, s.created_at, s.last_used_at, s.idle_expires_at,
	s.absolute_expires_at, array_to_string(s.factors, ',') AS factors, s.ip, s.user_agent,
	s.token_sha256, array_to_json(s.factors)::text AS factor_names, s.token_mac,
	s.token_mac_key_version, ${epochOf("st.session_epoch", sealing)}::text AS session_epoch`;
}

function listEveryIdOwnedStatement(
	table: string,
	states: string,
	sealing: SecurityStateSealing,
): string {
	return `SELECT ${listedColumns(sealing)}
	FROM ${table} s
	LEFT JOIN ${states} st ON st.user_id = s.user_id
	WHERE s.user_id = $1
	ORDER BY s.created_at DESC, s.id`;
}

function listOwnedStatement(table: string, states: string, sealing: SecurityStateSealing): string {
	return `SELECT ${listedColumns(sealing)}
	FROM ${table} s
	LEFT JOIN ${states} st ON st.user_id = s.user_id
	WHERE s.user_id = $1 AND s.idle_expires_at > now() AND s.absolute_expires_at > now()
	ORDER BY s.created_at DESC, s.id`;
}

function insertParameters(insert: SessionInsert): unknown[] {
	return [
		insert.userId,
		insert.tokenHash,
		secondsOf(insert.idleTimeoutMs),
		secondsOf(insert.absoluteTimeoutMs),
		toFactorArray(insert.factors),
		insert.ipAddress,
		insert.userAgent,
	];
}

function candidateOf(row: OwnedRowShape): SessionCandidate {
	const storedFactorNames = storedNamesOf(row.factor_names);
	return {
		sessionId: row.id,
		userId: row.user_id,
		storedFactorNames,
		sessionEpoch: toEpoch(row.session_epoch),
		tokenMac: row.token_mac,
		tokenMacKeyVersion: row.token_mac_key_version,
		decode: () => ({
			session: toSession({ ...row, factors: (storedFactorNames ?? []).join(",") }, NOT_LISTED),
			userId: row.user_id,
			userDisabledAt: toOptionalDate(row.disabled_at),
			observedAt: toDate(row.observed_at),
		}),
	};
}

export function createSessionRepository(options: SessionRepositoryOptions): SessionRepository {
	const table = qualifiedTableName(options.schema, "session");
	const users = qualifiedTableName(options.schema, "user");
	const states = qualifiedTableName(options.schema, "security_state");
	const sealing = options.sealing ?? "required";
	const insertSql = insertStatement(table, states, sealing);
	const resolveSql = resolveStatement(table, users, states, sealing);
	const currentEpochSql = currentEpochStatement(states, sealing);
	const extendSql = extendIdleDeadlineStatement(table);
	const rebindSql = rebindStatement(table);
	const deleteByTokenHashSql = deleteByTokenHashStatement(table);
	const findUserIdSql = findUserIdStatement(table);
	const deleteOwnedSql = deleteOwnedStatement(table);
	const deleteLiveOwnedSql = deleteLiveOwnedStatement(table, users);
	const deleteEveryOwnedSql = deleteEveryOwnedStatement(table);
	const deleteEveryOtherOwnedSql = deleteEveryOtherOwnedStatement(table);
	const listOwnedSql = listOwnedStatement(table, states, sealing);
	const listEveryIdOwnedSql = listEveryIdOwnedStatement(table, states, sealing);

	//a row the library did not write is not listed, announced or shown to a plugin (S-INTEG-9)
	async function libraryRowsOf(userId: string, statement: string): Promise<SessionRowShape[]> {
		const rows = await options.driver.query<ListedRowShape>(statement, [userId]);
		const verdicts = await Promise.all(
			rows.map((row) =>
				isLibrarySessionRow(
					options.keys,
					{
						userId: row.user_id,
						tokenHash: row.token_sha256,
						storedFactorNames: storedNamesOf(row.factor_names),
						sessionEpoch: toEpoch(row.session_epoch),
						tokenMac: row.token_mac,
						tokenMacKeyVersion: row.token_mac_key_version,
					},
					options.reportTokenBindingRefusal,
				),
			),
		);
		return rows.filter((_, index) => verdicts[index] === true);
	}

	async function currentEpochOf(driver: Driver, userId: string): Promise<number | null> {
		const [row] = await driver.query<{ session_epoch: string | null }>(currentEpochSql, [userId]);
		return toEpoch(row?.session_epoch ?? null);
	}

	async function insertUnderCurrentEpoch(
		driver: Driver,
		insert: SessionInsert,
	): Promise<SessionRowShape | undefined> {
		const epoch = await currentEpochOf(driver, insert.userId);
		//an account without an epoch has no seal row in "required" and gets no session (S-INTEG-4)
		if (epoch === null) {
			throw new ConcealedError("session_not_found");
		}
		const mac = await insert.bindUnderEpoch(epoch);
		const [row] = await driver.query<SessionRowShape>(insertSql, [
			...insertParameters(insert),
			mac.tokenMac,
			mac.tokenMacKeyVersion,
			epoch,
		]);
		return row;
	}

	//an issue waits on the lock a mass revocation holds and reads the epoch it leaves (E-3141)
	function issuing<T>(
		driver: Driver,
		userId: string,
		work: (tx: Driver) => Promise<T>,
	): Promise<T> {
		return driver.transaction(async (tx) => {
			await lockAccountRow(tx, options.schema, userId);
			return work(tx);
		});
	}

	//under the account lock the epoch cannot move and the condition is a second guard (E-3141)
	async function insertUnderAccountLock(tx: Driver, insert: SessionInsert): Promise<Session> {
		const row = await insertUnderCurrentEpoch(tx, insert);
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

	async function deleteEverySessionOwnedByReturningIds(actor: Actor): Promise<string[]> {
		const rows = await options.driver.query<{ id: string }>(deleteEveryOwnedSql, [actor]);
		return rows.map((row) => row.id);
	}

	return {
		boundTo: (driver) => createSessionRepository({ ...options, driver }),

		insertSession: (insert) =>
			issuing(options.driver, insert.userId, (tx) => insertUnderAccountLock(tx, insert)),

		async findSessionByTokenHash(tokenHash) {
			const [row] = await options.driver.query<OwnedRowShape>(resolveSql, [tokenHash]);
			return row === undefined ? null : candidateOf(row);
		},

		async rebindSessionTokenMac({ actor, sessionId, previous, next }) {
			await options.driver.query(rebindSql, [
				sessionId,
				previous.tokenMac,
				next.tokenMac,
				next.tokenMacKeyVersion,
				previous.tokenMacKeyVersion,
				actor,
			]);
		},

		async listEverySessionIdOwnedBy({ actor }) {
			return (await libraryRowsOf(actor, listEveryIdOwnedSql)).map((row) => row.id);
		},

		async listSessionsOfUser({ userId }) {
			return (await libraryRowsOf(userId, listOwnedSql)).map((row) => toSession(row, NOT_LISTED));
		},

		async deleteSessionById({ sessionId, ownerReadBefore }) {
			const rows = await options.driver.query(deleteOwnedSql, [sessionId, ownerReadBefore]);
			return rows.length;
		},

		async findUserIdOfSession({ sessionId }) {
			const [row] = await options.driver.query<{ user_id: string }>(findUserIdSql, [sessionId]);
			return row === undefined ? null : row.user_id;
		},

		async extendIdleDeadline({ sessionId, actor, idleTimeoutMs, writtenNoSoonerThanMs }) {
			const [row] = await options.driver.query<{ idle_expires_at: unknown }>(extendSql, [
				sessionId,
				actor,
				secondsOf(idleTimeoutMs),
				secondsOf(writtenNoSoonerThanMs),
			]);
			return row === undefined ? null : toDate(row.idle_expires_at);
		},

		deleteSessionByTokenHash: (tokenHash) => deleteSessionByTokenHash(options.driver, tokenHash),

		async listSessionsOwnedBy({ actor, currentSessionId }) {
			return (await libraryRowsOf(actor, listOwnedSql)).map((row) =>
				toSession(row, row.id === currentSessionId),
			);
		},

		async deleteSessionOwnedBy({ sessionId, actor }) {
			const rows = await options.driver.query(deleteOwnedSql, [sessionId, actor]);
			return rows.length;
		},

		async deleteEverySessionOwnedBy({ actor }) {
			return (await deleteEverySessionOwnedByReturningIds(actor)).length;
		},

		deleteEverySessionOwnedByReturningIds: ({ actor }) =>
			deleteEverySessionOwnedByReturningIds(actor),

		async deleteEveryOtherSessionOwnedBy({ actor, keptSessionId }) {
			const rows = await options.driver.query(deleteEveryOtherOwnedSql, [actor, keptSessionId]);
			return rows.length;
		},

		//the new row and the removal of the old one are one transaction, never an update (S-FIX-1)
		replaceSession({ previousTokenHash, insert }) {
			return issuing(options.driver, insert.userId, async (tx) => {
				const removed = await deleteSessionByTokenHash(tx, previousTokenHash);
				//without the removal the caller would end up with two live sessions (E-239)
				if (removed === null) {
					throw new PreviousSessionMissingError();
				}
				if (removed.userId !== insert.userId) {
					throw new SessionOwnerMismatchError();
				}
				return insertUnderAccountLock(tx, insert);
			});
		},

		//a sign-in removes the presented row in the transaction that inserts its successor (S-FIX-1)
		replacePresentedSession({ presentedTokenHash, insert }) {
			return issuing(options.driver, insert.userId, async (tx) => {
				if (presentedTokenHash !== null) {
					await deleteSessionByTokenHash(tx, presentedTokenHash);
				}
				return insertUnderAccountLock(tx, insert);
			});
		},

		//the named row and the new row are one transaction (S-FIX-1)
		async replaceSessionOwnedBy({ actor, previousSessionId, insert }) {
			if (insert.userId !== actor) {
				throw new SessionOwnerMismatchError();
			}
			return issuing(options.driver, actor, async (tx) => {
				const removed = await tx.query(deleteLiveOwnedSql, [previousSessionId, actor]);
				//the count is checked here as only here can the insert still be undone (E-961)
				if (removed.length === 0) {
					throw new PreviousSessionMissingError();
				}
				return insertUnderAccountLock(tx, insert);
			});
		},

		//every other session of the user goes and no parameter keeps one (S-FIX-6)
		async replaceEverySessionOfUser({ actor, insert }) {
			if (insert.userId !== actor) {
				throw new SessionOwnerMismatchError();
			}
			return issuing(options.driver, actor, async (tx) => {
				await tx.query(deleteEveryOwnedSql, [actor]);
				return insertUnderAccountLock(tx, insert);
			});
		},
	};
}
