import type { AuthenticationFactor, Session } from "../../http/caller.js";
import { ConcealedError, type ConcealedReason } from "../../http/error-map.js";
import type { KeyProvider } from "../../keys/provider.js";
import { securityStateDocumentOf } from "../../security-state/read.js";
import { librarySessionBinding, type SessionIssue } from "../../session/binding.js";
import {
	bindToken,
	decodedOrNull,
	reportBrokenState,
	reportRefusedTokenRow,
	type StoredTokenMac,
	type TokenBinding,
	type TokenBindingOccasion,
	type TokenBindingRefusalReport,
} from "../../token/binding.js";
import { randomUuid } from "../../token/random.js";
import type { Actor } from "../actor.js";
import type { Driver } from "../driver.js";
import { qualifiedTableName } from "../identifier.js";
import { lockAccountRow } from "../lock.js";

/** whether every account must have a seal row, or one without is still served while it is sealed */
export type SecurityStateSealing = "required" | "migrating";

//an unsealed account is at the first epoch in "migrating" and at none in "required" (E-3142)
const FIRST_SESSION_EPOCH = 1;

export function epochOf(storedEpoch: string, sealing: SecurityStateSealing): string {
	return sealing === "migrating" ? `COALESCE(${storedEpoch}, ${FIRST_SESSION_EPOCH})` : storedEpoch;
}

//an unsealed account is at the first generation wherever it is at the first epoch (E-3520)
export function generationOf(storedGeneration: string, sealing: SecurityStateSealing): string {
	return epochOf(storedGeneration, sealing);
}

/** the session generation a single revocation moves the account from and to */
export interface GenerationStep {
	readonly from: number;
	readonly to: number;
}

/** runs a single revocation under the account lock and moves the session generation where the seal verifies, or hands it null */
export type RevocationSeal = <T>(
	userId: string,
	revoke: (tx: Driver, step: GenerationStep | null) => Promise<T>,
) => Promise<T>;

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

class NothingRevoked extends Error {
	constructor() {
		super("the revocation found no row to remove");
		this.name = "NothingRevoked";
	}
}

/** how an issue that writes no row is reported and answered, which the path it completes decides */
export interface MissedIssue {
	readonly occasion: "sign_in" | "change";
	readonly reason: ConcealedReason;
}

/** the components version and epoch of the seal row the check that authorised an issue read, or `"unsealed"` where it read none */
export type IssueAuthorisation =
	| { readonly componentsVersion: number; readonly sessionEpoch: number }
	| "unsealed";

/** tells whether the seal verifies under the account lock after an issue wrote no row */
export type SealVerification = (tx: Driver, userId: string) => Promise<boolean>;

export interface SessionInsert {
	readonly userId: string;
	readonly missed: MissedIssue;
	readonly authorisedBy: IssueAuthorisation;
	readonly tokenHash: Uint8Array;
	readonly factors: readonly AuthenticationFactor[];
	readonly ipAddress: string | null;
	readonly userAgent: string | null;
	readonly idleTimeoutMs: number;
	readonly absoluteTimeoutMs: number;
	/** the row id drawn before the issue, where a credential sealed in the same change names it */
	readonly sessionId?: string;
	/** takes the token MAC over the session epoch and creation time the inserting transaction reads */
	bindUnder(issue: SessionIssue): Promise<StoredTokenMac>;
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
	/** null where the stored creation time is no exact count of microseconds the library could have bound */
	readonly createdAtMicros: number | null;
	/** the account's current session generation, or null for an account that has none */
	readonly sessionGeneration: number | null;
	/** null where a stored deadline is no finite count of microseconds the library could have bound */
	readonly idleExpiresAtMicros: string | null;
	readonly absoluteExpiresAtMicros: string | null;
	/** null where a column the MAC does not bind holds a value no date of this runtime can carry */
	decode(): SessionWithOwner | null;
	/** the account's security-state document the same statement read */
	readonly securityState: string | null;
}

/** the account a session row names, and whether the row passed the MAC check */
export interface SessionOwner {
	readonly userId: string;
	readonly libraryRow: boolean;
}

interface LockedState {
	readonly version: number | null;
	readonly sessionEpoch: number | null;
	readonly sessionGeneration: number | null;
	readonly createdAtMicros: number;
	readonly idleExpiresAtMicros: string;
	readonly absoluteExpiresAtMicros: string;
}

//an issue inserts while the seal row still holds what its check read, or while there is none (E-3485)
type IssueCondition =
	| { readonly sealed: true; readonly componentsVersion: number; readonly sessionEpoch: number }
	| { readonly sealed: false }
	| { readonly unwritable: true };

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
	//a missed issue under a seal that verifies was a legitimate change and raises no alarm (E-3485)
	readonly sealVerifiesAfterMissedIssue?: SealVerification;
	//a session revoked on its own moves the generation every other session is rebound to (E-3520)
	readonly revocationSeal?: RevocationSeal;
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
	}): Promise<boolean>;
	//every live session but the excluded ones follows the generation a change under the lock moves (E-3520)
	rebindToGeneration(input: {
		readonly actor: Actor;
		readonly step: GenerationStep;
		readonly excluding: readonly string[];
	}): Promise<void>;
	//a later idle deadline is written only with a MAC over it and over the row it checked first (E-3520)
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
	findOwnerOfSession(input: { readonly sessionId: string }): Promise<SessionOwner | null>;
	deleteSessionOwnedBy(input: {
		readonly sessionId: string;
		readonly actor: Actor;
	}): Promise<number>;
	deleteEverySessionOwnedBy(input: { readonly actor: Actor }): Promise<number>;
	deleteEverySessionOwnedByReturningIds(input: { readonly actor: Actor }): Promise<string[]>;
	deleteEveryOtherSessionOwnedBy(input: {
		readonly actor: Actor;
		readonly keptSessionId: string;
		/** the epoch the mass revocation draws, which the kept row is bound under */
		readonly keptUnderEpoch?: number;
	}): Promise<number>;
	//the predicate is the presented secret so its row goes whoever owns it (E-2120)
	replacePresentedSession(input: {
		readonly presentedTokenHash: Uint8Array | null;
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

interface DeadlineColumns {
	readonly idle_expires_at_us: string | null;
	readonly absolute_expires_at_us: string | null;
	readonly session_generation: string | null;
}

interface VerifiedRowShape extends DeadlineColumns {
	readonly id: string;
	readonly user_id: string;
	readonly created_at_us: string | null;
	readonly token_sha256: Uint8Array;
	readonly factor_names: string;
	readonly token_mac: Uint8Array;
	readonly token_mac_key_version: number;
	readonly session_epoch: string | null;
}

interface ListedRowShape extends SessionRowShape, VerifiedRowShape {}

interface OwnedRowShape extends Omit<SessionRowShape, "factors">, DeadlineColumns {
	readonly created_at_us: string | null;
	readonly factor_names: string;
	readonly session_epoch: string | null;
	readonly token_mac: Uint8Array;
	readonly token_mac_key_version: number;
	readonly disabled_at: unknown;
	readonly observed_at: unknown;
	readonly security_state?: string | null;
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

//a deadline is computed by the same expression in the statement the mac reads it from and the one that writes it (E-3520)
const PLUS_SECONDS = (parameter: string) =>
	`now() + make_interval(secs => ${parameter}::double precision)`;

const NOT_LISTED = false;

const GENERATION_REBIND_ATTEMPTS = 3;

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

//the creation time is the transaction's own so it equals the one the mac was taken over (S-INTEG-9)
const INSERTED_VALUES = `$1, $2, ${PLUS_SECONDS("$3")},
		${PLUS_SECONDS("$4")}, $5::text[], $6::inet, $7, $8, $9, now(),
		$10::uuid`;

//the id is drawn before the insert as the mac binds it (S-INTEG-9)
const INSERTED_COLUMNS = `(user_id, token_sha256, idle_expires_at, absolute_expires_at, factors, ip,
		user_agent, token_mac, token_mac_key_version, created_at, id)`;

//a creation time no bigint holds must read as none and not fail the statement (S-INTEG-9)
export function microsOf(timestamp: string): string {
	return `CASE WHEN isfinite(${timestamp}) THEN trunc(extract(epoch FROM ${timestamp}) * 1000000)::text END`;
}

//a session must be written only while the account is at the epoch its mac binds (S-INTEG-9)
function sealedInsertStatement(table: string, states: string): string {
	return `INSERT INTO ${table} ${INSERTED_COLUMNS}
	SELECT ${INSERTED_VALUES}
	FROM ${states} WHERE user_id = $1 AND session_epoch = $11::bigint
		AND components_version = $12::bigint
	RETURNING ${SELECTED_COLUMNS}`;
}

//an account read without a seal row is issued at the first epoch only while it still has none (E-3142)
function unsealedInsertStatement(table: string, states: string): string {
	return `INSERT INTO ${table} ${INSERTED_COLUMNS}
	SELECT ${INSERTED_VALUES}
	WHERE NOT EXISTS (SELECT 1 FROM ${states} WHERE user_id = $1)
	RETURNING ${SELECTED_COLUMNS}`;
}

//one joined query reads disabled at so a disabled account cannot pass as signed in (S-CACHE-2)
//the session row, the epoch, the seal and every component come from one statement (E-3299)
function resolveStatement(
	schema: string,
	table: string,
	users: string,
	states: string,
	sealing: SecurityStateSealing,
): string {
	return `SELECT s.id, s.user_id, s.created_at, s.last_used_at, s.idle_expires_at,
		s.absolute_expires_at, array_to_json(s.factors)::text AS factor_names, s.ip, s.user_agent,
		s.token_mac, s.token_mac_key_version, u.disabled_at, now() AS observed_at,
		${microsOf("s.created_at")} AS created_at_us,
		${deadlineColumns(generationOf("st.session_generation", sealing))},
		${epochOf("st.session_epoch", sealing)}::text AS session_epoch,
		${securityStateDocumentOf(schema, "s.user_id")} AS security_state
	FROM ${table} s
	JOIN ${users} u ON u.id = s.user_id
	LEFT JOIN ${states} st ON st.user_id = s.user_id
	WHERE s.token_sha256 = $1 AND s.idle_expires_at > now() AND s.absolute_expires_at > now()`;
}

//the deadlines and the generation a mac binds are read beside the row (E-3520)
function deadlineColumns(generation: string): string {
	return `${microsOf("s.idle_expires_at")} AS idle_expires_at_us,
		${microsOf("s.absolute_expires_at")} AS absolute_expires_at_us,
		${generation}::text AS session_generation`;
}

//the write interval sits in the statement so two concurrent requests cannot both write
function extendIdleDeadlineStatement(table: string): string {
	return `UPDATE ${table}
	SET last_used_at = now(), idle_expires_at = now() + make_interval(secs => $3::double precision),
		token_mac = $6, token_mac_key_version = $7
	WHERE id = $1 AND user_id = $2 AND token_mac = $5
		AND last_used_at <= now() - make_interval(secs => $4::double precision)
		AND idle_expires_at > now() AND absolute_expires_at > now()
	RETURNING idle_expires_at`;
}

function rebindStatement(table: string): string {
	return `UPDATE ${table} SET token_mac = $3, token_mac_key_version = $4
	WHERE id = $1 AND user_id = $6 AND token_mac = $2 AND token_mac_key_version = $5
	RETURNING id`;
}

function ownerByTokenHashStatement(table: string): string {
	return `SELECT user_id FROM ${table} WHERE token_sha256 = $1`;
}

function deleteOwnedByTokenHashStatement(table: string): string {
	return `DELETE FROM ${table} WHERE token_sha256 = $1 AND user_id = $2 RETURNING id, user_id`;
}

function liveOwnedStatement(table: string, states: string, sealing: SecurityStateSealing): string {
	return `SELECT ${verifiedColumns(states, sealing)} FROM ${table} s
	WHERE s.user_id = $1 AND s.idle_expires_at > now() AND s.absolute_expires_at > now()`;
}

//the row an extension rebinds and the now its deadline starts from come from one statement
function extendedRowStatement(
	table: string,
	states: string,
	sealing: SecurityStateSealing,
): string {
	return `SELECT ${verifiedColumns(states, sealing)},
	${microsOf(PLUS_SECONDS("$3"))} AS extended_us
	FROM ${table} s WHERE s.id = $1 AND s.user_id = $2`;
}

function deleteByTokenHashStatement(table: string): string {
	return `DELETE FROM ${table} /* no owner predicate: S-OWNER-2, the predicate is the secret itself */
	WHERE token_sha256 = $1 RETURNING id, user_id`;
}

function findOwnerStatement(table: string, states: string, sealing: SecurityStateSealing): string {
	return `SELECT ${verifiedColumns(states, sealing)} FROM ${table} s WHERE s.id = $1`;
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

function issuingStateStatement(states: string): string {
	return `SELECT (SELECT session_epoch::text FROM ${states} WHERE user_id = $1) AS session_epoch,
		(SELECT version::text FROM ${states} WHERE user_id = $1) AS version,
		(SELECT session_generation::text FROM ${states} WHERE user_id = $1) AS session_generation,
		${microsOf(PLUS_SECONDS("$2"))} AS idle_expires_at_us,
		${microsOf(PLUS_SECONDS("$3"))} AS absolute_expires_at_us,
		${microsOf("now()")} AS created_at_us`;
}

const DECIMAL_DIGITS = /^-?(0|[1-9][0-9]*)$/;

//a deadline past the year 2255 is no exact javascript number and is bound as its decimal digits (E-3520)
function decimalMicrosFrom(value: string | null): string | null {
	return value !== null && DECIMAL_DIGITS.test(value) ? value : null;
}

//a count of microseconds must be exact before a mac binds it (S-INTEG-9)
function microsFrom(value: string | null): number | null {
	const micros = value === null ? Number.NaN : Number(value);
	return Number.isSafeInteger(micros) ? micros : null;
}

//an epoch must be an exact integer before a mac binds it (S-INTEG-9)
function epochFrom(value: string): number {
	return storedCountFrom(
		value,
		"velve.security_state.session_epoch holds no epoch this library writes",
	);
}

//a version is compared as the exact integer the seal row stores (E-3485)
function versionFrom(value: string): number {
	return storedCountFrom(
		value,
		"velve.security_state.version holds no version this library writes",
	);
}

function storedCountFrom(value: string, refusal: string): number {
	const count = Number(value);
	if (!Number.isSafeInteger(count) || count < 1) {
		throw new TypeError(refusal);
	}
	return count;
}

//only a newer key version over the same token can be a rebinding and the loop ends at the newest in the ring
function isRebindingOf(read: VerifiedRowShape, reread: VerifiedRowShape): boolean {
	const before = new Uint8Array(read.token_sha256);
	const after = new Uint8Array(reread.token_sha256);
	return (
		reread.token_mac_key_version > read.token_mac_key_version &&
		before.length === after.length &&
		before.every((byte, index) => byte === after[index])
	);
}

function toEpoch(value: string | null): number | null {
	return value === null ? null : epochFrom(value);
}

function deleteEveryOwnedStatement(
	table: string,
	states: string,
	sealing: SecurityStateSealing,
): string {
	return `DELETE FROM ${table} s WHERE s.user_id = $1 RETURNING ${verifiedColumns(states, sealing)}`;
}

function deleteEveryOtherOwnedStatement(
	table: string,
	states: string,
	sealing: SecurityStateSealing,
): string {
	return `DELETE FROM ${table} s WHERE s.user_id = $1 AND s.id <> $2
	RETURNING ${verifiedColumns(states, sealing)}`;
}

function keptRowStatement(table: string, states: string, sealing: SecurityStateSealing): string {
	return `SELECT ${verifiedColumns(states, sealing)} FROM ${table} s WHERE s.id = $1 AND s.user_id = $2`;
}

//a kept session is rebound only where it still holds the mac read under the lock (S-INTEG-9)
function keptRebindStatement(table: string): string {
	return `UPDATE ${table} SET token_mac = $4, token_mac_key_version = $5
	WHERE id = $1 AND user_id = $2 AND token_mac = $3
	RETURNING id`;
}

//a row that is counted or announced must be checkable first (S-INTEG-9)
function verifiedColumns(states: string, sealing: SecurityStateSealing): string {
	return `s.id, s.user_id, ${microsOf("s.created_at")} AS created_at_us, s.token_sha256,
	array_to_json(s.factors)::text AS factor_names,
	s.token_mac, s.token_mac_key_version,
	${deadlineColumns(generationOf(`(SELECT session_generation FROM ${states} WHERE user_id = s.user_id)`, sealing))},
	${epochOf(`(SELECT session_epoch FROM ${states} WHERE user_id = s.user_id)`, sealing)}::text AS session_epoch`;
}

//a listed row must be checkable before it is shown (S-INTEG-9)
function listedColumns(sealing: SecurityStateSealing): string {
	return `s.id, s.user_id, s.created_at, s.last_used_at, s.idle_expires_at,
	s.absolute_expires_at, array_to_string(s.factors, ',') AS factors, s.ip, s.user_agent,
	s.token_sha256, array_to_json(s.factors)::text AS factor_names, s.token_mac,
	s.token_mac_key_version, ${epochOf("st.session_epoch", sealing)}::text AS session_epoch,
	${deadlineColumns(generationOf("st.session_generation", sealing))},
	${microsOf("s.created_at")} AS created_at_us`;
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

function deadlinesOf(row: DeadlineColumns): {
	readonly sessionGeneration: number | null;
	readonly idleExpiresAtMicros: string | null;
	readonly absoluteExpiresAtMicros: string | null;
} {
	return {
		sessionGeneration: toEpoch(row.session_generation),
		idleExpiresAtMicros: decimalMicrosFrom(row.idle_expires_at_us),
		absoluteExpiresAtMicros: decimalMicrosFrom(row.absolute_expires_at_us),
	};
}

function candidateOf(row: OwnedRowShape): SessionCandidate {
	const storedFactorNames = storedNamesOf(row.factor_names);
	return {
		sessionId: row.id,
		userId: row.user_id,
		storedFactorNames,
		sessionEpoch: toEpoch(row.session_epoch),
		createdAtMicros: microsFrom(row.created_at_us),
		...deadlinesOf(row),
		tokenMac: row.token_mac,
		tokenMacKeyVersion: row.token_mac_key_version,
		securityState: row.security_state ?? null,
		decode: () =>
			decodedOrNull(() => ({
				session: toSession({ ...row, factors: (storedFactorNames ?? []).join(",") }, NOT_LISTED),
				userId: row.user_id,
				userDisabledAt: toOptionalDate(row.disabled_at),
				observedAt: toDate(row.observed_at),
			})),
	};
}

export function createSessionRepository(options: SessionRepositoryOptions): SessionRepository {
	const table = qualifiedTableName(options.schema, "session");
	const users = qualifiedTableName(options.schema, "user");
	const states = qualifiedTableName(options.schema, "security_state");
	const sealing = options.sealing ?? "required";
	const sealedInsertSql = sealedInsertStatement(table, states);
	const unsealedInsertSql = unsealedInsertStatement(table, states);
	const resolveSql = resolveStatement(options.schema, table, users, states, sealing);
	const issuingStateSql = issuingStateStatement(states);
	const extendSql = extendIdleDeadlineStatement(table);
	const rebindSql = rebindStatement(table);
	const deleteByTokenHashSql = deleteByTokenHashStatement(table);
	const findOwnerSql = findOwnerStatement(table, states, sealing);
	const deleteOwnedSql = deleteOwnedStatement(table);
	const deleteLiveOwnedSql = deleteLiveOwnedStatement(table, users);
	const deleteEveryOwnedSql = deleteEveryOwnedStatement(table, states, sealing);
	const deleteEveryOtherOwnedSql = deleteEveryOtherOwnedStatement(table, states, sealing);
	const keptRowSql = keptRowStatement(table, states, sealing);
	const keptRebindSql = keptRebindStatement(table);
	const listOwnedSql = listOwnedStatement(table, states, sealing);
	const listEveryIdOwnedSql = listEveryIdOwnedStatement(table, states, sealing);
	const ownerByTokenHashSql = ownerByTokenHashStatement(table);
	const deleteOwnedByTokenHashSql = deleteOwnedByTokenHashStatement(table);
	const liveOwnedSql = liveOwnedStatement(table, states, sealing);
	const extendedRowSql = extendedRowStatement(table, states, sealing);

	function libraryBindingOf(
		row: VerifiedRowShape,
		occasion: TokenBindingOccasion,
	): Promise<TokenBinding | null> {
		return librarySessionBinding(
			options.keys,
			{
				sessionId: row.id,
				userId: row.user_id,
				tokenHash: row.token_sha256,
				storedFactorNames: storedNamesOf(row.factor_names),
				sessionEpoch: toEpoch(row.session_epoch),
				createdAtMicros: microsFrom(row.created_at_us),
				...deadlinesOf(row),
				tokenMac: row.token_mac,
				tokenMacKeyVersion: row.token_mac_key_version,
			},
			{ report: options.reportTokenBindingRefusal, occasion },
		);
	}

	async function libraryRowsAmong<T extends VerifiedRowShape>(
		rows: readonly T[],
		occasion: TokenBindingOccasion,
	): Promise<T[]> {
		const bindings = await Promise.all(rows.map((row) => libraryBindingOf(row, occasion)));
		return rows.filter((_, index) => bindings[index] !== null);
	}

	//a row the library did not write is not listed, announced or shown to a plugin (S-INTEG-9)
	async function libraryRowsOf(
		userId: string,
		statement: string,
		occasion: TokenBindingOccasion,
	): Promise<SessionRowShape[]> {
		return libraryRowsAmong(
			await options.driver.query<ListedRowShape>(statement, [userId]),
			occasion,
		);
	}

	//a library row whose unbound columns no longer decode is reported and left out (S-INTEG-9)
	async function librarySessionsOf(
		userId: string,
		statement: string,
		currentSessionId: string | null,
	): Promise<Session[]> {
		const sessions: Session[] = [];
		for (const row of await libraryRowsOf(userId, statement, "session_list")) {
			const session = decodedOrNull(() => toSession(row, row.id === currentSessionId));
			if (session === null) {
				reportRefusedTokenRow(options.reportTokenBindingRefusal, {
					userId: row.user_id,
					occasion: "session_list",
					verdict: "mismatch",
				});
			} else {
				sessions.push(session);
			}
		}
		return sessions;
	}

	async function lockedStateOf(driver: Driver, insert: SessionInsert): Promise<LockedState> {
		const [row] = await driver.query<{
			session_epoch: string | null;
			version: string | null;
			session_generation: string | null;
			created_at_us: string | null;
			idle_expires_at_us: string | null;
			absolute_expires_at_us: string | null;
		}>(issuingStateSql, [
			insert.userId,
			secondsOf(insert.idleTimeoutMs),
			secondsOf(insert.absoluteTimeoutMs),
		]);
		if (row === undefined) {
			throw new TypeError("the read of the issuing state returned no row");
		}
		const createdAtMicros = microsFrom(row.created_at_us);
		const idleExpiresAtMicros = decimalMicrosFrom(row.idle_expires_at_us);
		const absoluteExpiresAtMicros = decimalMicrosFrom(row.absolute_expires_at_us);
		if (
			createdAtMicros === null ||
			idleExpiresAtMicros === null ||
			absoluteExpiresAtMicros === null
		) {
			throw new TypeError("the database clock lies outside what this library binds");
		}
		return {
			version: row.version === null ? null : versionFrom(row.version),
			sessionEpoch: row.session_epoch === null ? null : epochFrom(row.session_epoch),
			sessionGeneration: row.session_generation === null ? null : epochFrom(row.session_generation),
			createdAtMicros,
			idleExpiresAtMicros,
			absoluteExpiresAtMicros,
		};
	}

	function conditionWithoutASeal(): IssueCondition {
		return sealing === "migrating" ? { sealed: false } : { unwritable: true };
	}

	//an issue stands on the version and epoch its authorising check read and never on the lock's own read (E-3403)
	function conditionOf(authorisedBy: IssueAuthorisation): IssueCondition {
		return authorisedBy === "unsealed"
			? conditionWithoutASeal()
			: { sealed: true, ...authorisedBy };
	}

	async function insertUnderCurrentEpoch(
		driver: Driver,
		insert: SessionInsert,
	): Promise<SessionRowShape | undefined> {
		const locked = await lockedStateOf(driver, insert);
		const condition = conditionOf(insert.authorisedBy);
		if ("unwritable" in condition) {
			throw new ConcealedError(insert.missed.reason);
		}
		const issue = {
			sessionId: insert.sessionId ?? randomUuid(),
			sessionEpoch: condition.sealed ? condition.sessionEpoch : FIRST_SESSION_EPOCH,
			createdAtMicros: locked.createdAtMicros,
			sessionGeneration: locked.sessionGeneration ?? FIRST_SESSION_EPOCH,
			idleExpiresAtMicros: locked.idleExpiresAtMicros,
			absoluteExpiresAtMicros: locked.absoluteExpiresAtMicros,
		};
		const mac = await insert.bindUnder(issue);
		const parameters = [
			...insertParameters(insert),
			mac.tokenMac,
			mac.tokenMacKeyVersion,
			issue.sessionId,
		];
		const [row] = condition.sealed
			? await driver.query<SessionRowShape>(sealedInsertSql, [
					...parameters,
					condition.sessionEpoch,
					condition.componentsVersion,
				])
			: await driver.query<SessionRowShape>(unsealedInsertSql, parameters);
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

	//a writer who moved the epoch past the lock leaves a broken state that is not retried (E-3256)
	async function insertUnderAccountLock(
		tx: Driver,
		insert: SessionInsert,
		sealVerifiedUnderTheLock = false,
	): Promise<Session> {
		const row = await insertUnderCurrentEpoch(tx, insert);
		if (row === undefined) {
			//a miss under a seal that verifies was a legitimate change and raises no alarm (E-3485)
			if (
				sealVerifiedUnderTheLock ||
				(await options.sealVerifiesAfterMissedIssue?.(tx, insert.userId))
			) {
				throw new ConcealedError(insert.missed.reason);
			}
			reportBrokenState(options.reportTokenBindingRefusal, {
				userId: insert.userId,
				occasion: insert.missed.occasion,
				reason: "seal_mismatch",
			});
			throw new ConcealedError(insert.missed.reason);
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

	//the one session a mass revocation keeps is bound under the epoch it draws (S-INTEG-9)
	function boundUnderEpoch(
		binding: TokenBinding,
		keptUnderEpoch: number | undefined,
	): TokenBinding {
		return keptUnderEpoch === undefined || !("sessionEpoch" in binding.content)
			? binding
			: { ...binding, content: { ...binding.content, sessionEpoch: keptUnderEpoch } };
	}

	//a kept row a resolution rebound under a newer version since the read is swapped again without an alarm (E-3276)
	async function keptAfterRebinding(
		tx: Driver,
		kept: VerifiedRowShape,
		keptUnderEpoch: number | undefined,
	): Promise<boolean> {
		let row = kept;
		for (;;) {
			const binding = await libraryBindingOf(row, "change");
			if (binding === null) {
				return false;
			}
			const next = await bindToken(options.keys, boundUnderEpoch(binding, keptUnderEpoch));
			const rebound = await tx.query(keptRebindSql, [
				row.id,
				row.user_id,
				row.token_mac,
				next.tokenMac,
				next.tokenMacKeyVersion,
			]);
			if (rebound.length === 1) {
				return true;
			}
			const [reread] = await tx.query<VerifiedRowShape>(keptRowSql, [row.id, row.user_id]);
			if (reread === undefined) {
				return false;
			}
			if (!isRebindingOf(row, reread)) {
				reportRefusedTokenRow(options.reportTokenBindingRefusal, {
					userId: row.user_id,
					occasion: "change",
					verdict: "mismatch",
				});
				return false;
			}
			row = reread;
		}
	}

	//a row a refresh or a resolution rewrote since the read is read again and followed while it still verifies (E-3520)
	async function followedToGeneration(
		tx: Driver,
		first: VerifiedRowShape,
		step: GenerationStep,
	): Promise<void> {
		let row: VerifiedRowShape | undefined = first;
		for (let attempt = 0; row !== undefined && attempt < GENERATION_REBIND_ATTEMPTS; attempt += 1) {
			const binding = await libraryBindingOf(
				{ ...row, session_generation: String(step.from) },
				"change",
			);
			if (binding === null || !("sessionGeneration" in binding.content)) {
				return;
			}
			const next = await bindToken(options.keys, {
				...binding,
				content: { ...binding.content, sessionGeneration: step.to },
			});
			const rebound = await tx.query(keptRebindSql, [
				row.id,
				row.user_id,
				row.token_mac,
				next.tokenMac,
				next.tokenMacKeyVersion,
			]);
			if (rebound.length === 1) {
				return;
			}
			[row] = await tx.query<VerifiedRowShape>(keptRowSql, [row.id, row.user_id]);
		}
	}

	async function rebindToGeneration(
		tx: Driver,
		userId: string,
		step: GenerationStep,
		excluding: readonly string[],
	): Promise<void> {
		for (const row of await tx.query<VerifiedRowShape>(liveOwnedSql, [userId])) {
			if (!excluding.includes(row.id)) {
				await followedToGeneration(tx, row, step);
			}
		}
	}

	//a revocation without a seal behind it still runs under the lock a mass revocation takes
	const revocationSeal: RevocationSeal =
		options.revocationSeal ??
		((userId, revoke) => issuing(options.driver, userId, (tx) => revoke(tx, null)));

	//a single revocation leaves every other session on a generation the revoked row does not bind (E-3520)
	async function revokedUnderGeneration(
		userId: string,
		remove: (tx: Driver) => Promise<readonly string[]>,
	): Promise<readonly string[]> {
		try {
			return await revocationSeal(userId, async (tx, step) => {
				const removed = await remove(tx);
				//a revocation that removed nothing rolls back and moves no generation
				if (removed.length === 0) {
					throw new NothingRevoked();
				}
				if (step !== null) {
					await rebindToGeneration(tx, userId, step, removed);
				}
				return removed;
			});
		} catch (error) {
			if (error instanceof NothingRevoked) {
				return [];
			}
			throw error;
		}
	}

	async function ownerOfTokenHash(tokenHash: Uint8Array): Promise<string | null> {
		const [row] = await options.driver.query<{ user_id: string }>(ownerByTokenHashSql, [tokenHash]);
		return row?.user_id ?? null;
	}

	async function deletedIds(tx: Driver, sql: string, parameters: unknown[]): Promise<string[]> {
		return (await tx.query<{ id: string }>(sql, parameters)).map((row) => row.id);
	}

	//a forged row goes with the others and is neither counted nor returned (S-INTEG-9)
	async function deleteEverySessionOwnedByReturningIds(actor: Actor): Promise<string[]> {
		const rows = await options.driver.query<VerifiedRowShape>(deleteEveryOwnedSql, [actor]);
		return (await libraryRowsAmong(rows, "change")).map((row) => row.id);
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
			const rows = await options.driver.query(rebindSql, [
				sessionId,
				previous.tokenMac,
				next.tokenMac,
				next.tokenMacKeyVersion,
				previous.tokenMacKeyVersion,
				actor,
			]);
			return rows.length === 1;
		},

		rebindToGeneration: ({ actor, step, excluding }) =>
			rebindToGeneration(options.driver, actor, step, excluding),

		async listEverySessionIdOwnedBy({ actor }) {
			return (await libraryRowsOf(actor, listEveryIdOwnedSql, "change")).map((row) => row.id);
		},

		listSessionsOfUser: ({ userId }) => librarySessionsOf(userId, listOwnedSql, null),

		async deleteSessionById({ sessionId, ownerReadBefore }) {
			const removed = await revokedUnderGeneration(ownerReadBefore, (tx) =>
				deletedIds(tx, deleteOwnedSql, [sessionId, ownerReadBefore]),
			);
			return removed.length;
		},

		async findOwnerOfSession({ sessionId }) {
			const [row] = await options.driver.query<VerifiedRowShape>(findOwnerSql, [sessionId]);
			return row === undefined
				? null
				: { userId: row.user_id, libraryRow: (await libraryBindingOf(row, "change")) !== null };
		},

		extendIdleDeadline({ sessionId, actor, idleTimeoutMs, writtenNoSoonerThanMs }) {
			//the deadline written must be the one the mac binds
			return options.driver.transaction(async (tx) => {
				const [stored] = await tx.query<VerifiedRowShape & { extended_us: string | null }>(
					extendedRowSql,
					[sessionId, actor, secondsOf(idleTimeoutMs)],
				);
				const extendedMicros = decimalMicrosFrom(stored?.extended_us ?? null);
				const checked =
					stored === undefined ? null : await libraryBindingOf(stored, "session_resolve");
				if (
					extendedMicros === null ||
					stored === undefined ||
					checked === null ||
					!("idleExpiresAtMicros" in checked.content)
				) {
					return null;
				}
				const next = await bindToken(options.keys, {
					...checked,
					content: {
						...checked.content,
						idleExpiresAtMicros: extendedMicros,
					},
				});
				const [row] = await tx.query<{ idle_expires_at: unknown }>(extendSql, [
					sessionId,
					actor,
					secondsOf(idleTimeoutMs),
					secondsOf(writtenNoSoonerThanMs),
					stored.token_mac,
					next.tokenMac,
					next.tokenMacKeyVersion,
				]);
				return row === undefined ? null : toDate(row.idle_expires_at);
			});
		},

		async deleteSessionByTokenHash(tokenHash) {
			const owner = await ownerOfTokenHash(tokenHash);
			if (owner === null) {
				return null;
			}
			const [removed] = await revokedUnderGeneration(owner, (tx) =>
				deletedIds(tx, deleteOwnedByTokenHashSql, [tokenHash, owner]),
			);
			return removed === undefined ? null : { id: removed, userId: owner };
		},

		listSessionsOwnedBy: ({ actor, currentSessionId }) =>
			librarySessionsOf(actor, listOwnedSql, currentSessionId),

		async deleteSessionOwnedBy({ sessionId, actor }) {
			const removed = await revokedUnderGeneration(actor, (tx) =>
				deletedIds(tx, deleteOwnedSql, [sessionId, actor]),
			);
			return removed.length;
		},

		async deleteEverySessionOwnedBy({ actor }) {
			return (await deleteEverySessionOwnedByReturningIds(actor)).length;
		},

		deleteEverySessionOwnedByReturningIds: ({ actor }) =>
			deleteEverySessionOwnedByReturningIds(actor),

		//the kept row is checked and rebound under the lock or it goes with the others (E-3260)
		deleteEveryOtherSessionOwnedBy({ actor, keptSessionId, keptUnderEpoch }) {
			return issuing(options.driver, actor, async (tx) => {
				const [kept] = await tx.query<VerifiedRowShape>(keptRowSql, [keptSessionId, actor]);
				const removed = await tx.query<VerifiedRowShape>(deleteEveryOtherOwnedSql, [
					actor,
					keptSessionId,
				]);
				if (kept !== undefined && !(await keptAfterRebinding(tx, kept, keptUnderEpoch))) {
					await tx.query(deleteOwnedSql, [keptSessionId, actor]);
				}
				return (await libraryRowsAmong(removed, "change")).length;
			});
		},

		//a sign-in removes the presented row in the transaction that inserts its successor (S-FIX-1)
		async replacePresentedSession({ presentedTokenHash, insert }) {
			const owner = presentedTokenHash === null ? null : await ownerOfTokenHash(presentedTokenHash);
			//a presented row of the same account is revoked on its own and moves the generation (E-3521)
			if (presentedTokenHash !== null && owner === insert.userId) {
				return revocationSeal(insert.userId, async (tx, step) => {
					const removed = await deletedIds(tx, deleteOwnedByTokenHashSql, [
						presentedTokenHash,
						insert.userId,
					]);
					const session = await insertUnderAccountLock(tx, insert, step !== null);
					if (step !== null) {
						await rebindToGeneration(tx, insert.userId, step, removed);
					}
					return session;
				});
			}
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
			return revocationSeal(actor, async (tx, step) => {
				const removed = await deletedIds(tx, deleteLiveOwnedSql, [previousSessionId, actor]);
				//the count is checked here as only here can the insert still be undone (E-961)
				if (removed.length === 0) {
					throw new PreviousSessionMissingError();
				}
				const session = await insertUnderAccountLock(tx, insert, step !== null);
				if (step !== null) {
					await rebindToGeneration(tx, actor, step, removed);
				}
				return session;
			});
		},
	};
}
