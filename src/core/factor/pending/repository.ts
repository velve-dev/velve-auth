import type { Driver } from "../../db/driver.js";
import { qualifiedTableName } from "../../db/identifier.js";
import type { AuthenticationFactor } from "../../http/caller.js";
import type { StoredTokenMac } from "../../token/binding.js";

const AUTHENTICATION_FACTORS: readonly AuthenticationFactor[] = [
	"password",
	"totp",
	"webauthn",
	"recovery",
	"oauth",
];

export type SecondFactor = "totp" | "webauthn" | "recovery";

export interface PendingAuthenticationInsert extends StoredTokenMac {
	readonly userId: string;
	readonly tokenHash: Uint8Array;
	readonly factorsCompleted: readonly AuthenticationFactor[];
	readonly lifetimeInSeconds: number;
	readonly sessionEpoch: number;
	readonly attemptGeneration: number;
}

export interface StoredPendingAuthentication {
	readonly userId: string;
	readonly factorsCompleted: readonly AuthenticationFactor[];
	//factors come from the account's own rows so no caller decides what it is offered (E-735)
	readonly availableFactors: readonly SecondFactor[];
	readonly attempts: number;
	readonly createdAt: Date;
	readonly expiresAt: Date;
}

export interface PendingAuthenticationWithOwner extends StoredPendingAuthentication {
	readonly userDisabledAt: Date | null;
	//callers use the db clock and never compare their own clock with the row
	readonly observedAt: Date;
}

export interface RemovedPendingAuthentication {
	readonly userId: string;
	readonly factorsCompleted: readonly AuthenticationFactor[];
}

/** a row whose MAC is still to be checked, with the completed factors exactly as stored */
export interface PendingCandidate<Decoded> extends StoredTokenMac {
	readonly userId: string;
	readonly attempts: number;
	/** null where the column holds something that is no factor name */
	readonly storedFactorNames: readonly string[] | null;
	/** the epoch stored with the row, which its MAC binds */
	readonly sessionEpoch: number;
	/** the account's epoch now, read in the statement that read the row; 1 for an account without a seal row */
	readonly currentEpoch: number;
	/** the attempt generation stored with the row, which its MAC binds */
	readonly attemptGeneration: number;
	/** the account's attempt generation now, or null for an account without a seal row */
	readonly currentAttemptGeneration: number | null;
	/** the token hash of the pending row whose booking moved the account's attempt generation last */
	readonly attemptLast: Uint8Array | null;
	decode(): Decoded;
}

/** what a new pending row binds of its account's state */
export interface PendingAccountState {
	readonly sessionEpoch: number;
	/** null for an account without a seal row, whose rows bind the first generation */
	readonly attemptGeneration: number | null;
}

export interface PendingAuthenticationRepositoryOptions {
	readonly driver: Driver;
	readonly schema: string;
}

//every row is addressed by its token hash so no method needs an actor (E-242)
export interface PendingAuthenticationRepository {
	insertPendingAuthentication(
		input: PendingAuthenticationInsert,
	): Promise<StoredPendingAuthentication>;
	//the epoch and generation a new row binds are the account's own, which its token is about to prove (E-3484)
	accountStateOf(input: { readonly userId: string }): Promise<PendingAccountState>;
	findPendingAuthenticationByTokenHash(
		tokenHash: Uint8Array,
	): Promise<PendingCandidate<PendingAuthenticationWithOwner> | null>;
	//an attempt must be booked only over the counter and mac that were checked (S-INTEG-9)
	bookAttempt(input: {
		readonly tokenHash: Uint8Array;
		readonly checked: StoredTokenMac & { readonly attempts: number };
		readonly next: StoredTokenMac & { readonly attemptGeneration: number };
	}): Promise<boolean>;
	deletePendingAuthenticationByTokenHash(
		tokenHash: Uint8Array,
	): Promise<PendingCandidate<RemovedPendingAuthentication> | null>;
}

interface PendingRowShape {
	readonly user_id: string;
	readonly factors_completed: string;
	readonly attempts: number;
	readonly created_at: unknown;
	readonly expires_at: unknown;
}

interface EnrolmentColumns {
	readonly has_totp: boolean;
	readonly has_webauthn: boolean;
	readonly has_recovery: boolean;
}

interface InsertedPendingRowShape extends PendingRowShape, EnrolmentColumns {}

interface MacColumns {
	readonly token_mac: Uint8Array;
	readonly token_mac_key_version: number;
	readonly session_epoch: string;
	readonly current_epoch: string;
	readonly attempt_generation: string;
	readonly current_attempt_generation: string | null;
	readonly attempt_last: Uint8Array | null;
}

interface OwnedPendingRowShape
	extends Omit<InsertedPendingRowShape, "factors_completed">,
		MacColumns {
	readonly factor_names: string;
	readonly disabled_at: unknown;
	readonly observed_at: unknown;
}

interface RemovedPendingRowShape extends MacColumns {
	readonly user_id: string;
	readonly factor_names: string;
	readonly attempts: number;
}

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
			throw new TypeError("velve.pending_authentication.factors_completed holds an unknown factor");
		}
	}
	return names.filter(isAuthenticationFactor);
}

//a comma inside a factor name must not split it in two (S-INTEG-9)
function storedNamesOf(json: string): readonly string[] | null {
	const names: unknown = JSON.parse(json);
	return Array.isArray(names) && names.every((name) => typeof name === "string") ? names : null;
}

function candidateOf<Decoded>(
	row: RemovedPendingRowShape,
	decode: (factorsCompleted: string) => Decoded,
): PendingCandidate<Decoded> {
	const storedFactorNames = storedNamesOf(row.factor_names);
	return {
		userId: row.user_id,
		attempts: row.attempts,
		storedFactorNames,
		sessionEpoch: Number(row.session_epoch),
		currentEpoch: Number(row.current_epoch),
		attemptGeneration: Number(row.attempt_generation),
		currentAttemptGeneration:
			row.current_attempt_generation === null ? null : Number(row.current_attempt_generation),
		attemptLast: row.attempt_last,
		tokenMac: row.token_mac,
		tokenMacKeyVersion: row.token_mac_key_version,
		decode: () => decode((storedFactorNames ?? []).join(",")),
	};
}

//the array literal is built from a closed set so no request value can reach it
function toFactorArray(factors: readonly AuthenticationFactor[]): string {
	for (const factor of factors) {
		if (!isAuthenticationFactor(factor)) {
			throw new TypeError(`velve.pending_authentication.factors_completed cannot hold "${factor}"`);
		}
	}
	return `{${[...new Set(factors)].join(",")}}`;
}

function availableFactorsOf(row: EnrolmentColumns): readonly SecondFactor[] {
	const available: SecondFactor[] = [];
	if (row.has_totp) {
		available.push("totp");
	}
	if (row.has_webauthn) {
		available.push("webauthn");
	}
	if (row.has_recovery) {
		available.push("recovery");
	}
	return available;
}

function toStored(row: InsertedPendingRowShape): StoredPendingAuthentication {
	return {
		userId: row.user_id,
		factorsCompleted: toFactors(row.factors_completed),
		availableFactors: availableFactorsOf(row),
		attempts: row.attempts,
		createdAt: toDate(row.created_at),
		expiresAt: toDate(row.expires_at),
	};
}

//enrolments are read in the writing statement so a caller cannot name a missing factor (E-735)
function insertStatement(table: string, totp: string, webauthn: string, recovery: string): string {
	return `WITH inserted AS (
		INSERT INTO ${table}
			(token_sha256, user_id, factors_completed, expires_at, token_mac, token_mac_key_version,
			session_epoch, attempt_generation)
		VALUES ($1, $2, $3::text[], now() + make_interval(secs => $4::double precision), $5, $6,
			$7::bigint, $8::bigint)
		RETURNING user_id, factors_completed, attempts, created_at, expires_at
	)
	SELECT i.user_id, array_to_string(i.factors_completed, ',') AS factors_completed,
		i.attempts, i.created_at, i.expires_at,
		${enrolmentColumns(totp, webauthn, recovery, "i.user_id")}
	FROM inserted i`;
}

//an account without a seal row is at the first epoch for a pending row in either mode (E-3484)
function epochColumns(stored: string, states: string, owner: string): string {
	return `${stored}::text AS session_epoch,
		COALESCE((SELECT st.session_epoch FROM ${states} st WHERE st.user_id = ${owner}), 1)::text
			AS current_epoch`;
}

//the generation a booking moves is read with the row to tell a row written back from a live one (E-3519)
function generationColumns(row: string, states: string): string {
	return `${row}.attempt_generation::text AS attempt_generation,
		(SELECT st.attempt_generation::text FROM ${states} st WHERE st.user_id = ${row}.user_id)
			AS current_attempt_generation,
		(SELECT st.attempt_last FROM ${states} st WHERE st.user_id = ${row}.user_id) AS attempt_last`;
}

function enrolmentColumns(totp: string, webauthn: string, recovery: string, owner: string): string {
	return `EXISTS (SELECT 1 FROM ${totp} t WHERE t.user_id = ${owner} AND t.confirmed_at IS NOT NULL) AS has_totp,
		EXISTS (SELECT 1 FROM ${webauthn} w WHERE w.user_id = ${owner}) AS has_webauthn,
		EXISTS (SELECT 1 FROM ${recovery} r WHERE r.user_id = ${owner}) AS has_recovery`;
}

//one query decides deadline, disabled flag and open factors so no second trip decides them
function resolveStatement(
	table: string,
	users: string,
	totp: string,
	webauthn: string,
	recovery: string,
	states: string,
): string {
	return `SELECT p.user_id, array_to_json(p.factors_completed)::text AS factor_names,
		p.attempts, p.created_at, p.expires_at, p.token_mac, p.token_mac_key_version,
		${epochColumns("p.session_epoch", states, "p.user_id")},
		${generationColumns("p", states)},
		u.disabled_at, now() AS observed_at,
		${enrolmentColumns(totp, webauthn, recovery, "p.user_id")}
	FROM ${table} p
	JOIN ${users} u ON u.id = p.user_id
	WHERE p.token_sha256 = $1 AND p.expires_at > now()`;
}

function countAttemptStatement(table: string): string {
	return `UPDATE ${table} /* no owner predicate: S-OWNER-2, E-242, the predicate is the secret itself */
	SET attempts = $3, token_mac = $4, token_mac_key_version = $5, attempt_generation = $6
	WHERE token_sha256 = $1 AND token_mac = $2 AND attempts = $3 - 1 AND expires_at > now()
	RETURNING attempts`;
}

function deleteStatement(table: string, states: string): string {
	return `DELETE FROM ${table} /* no owner predicate: S-OWNER-2, E-242, the predicate is the secret itself */
	WHERE token_sha256 = $1 AND expires_at > now()
	RETURNING user_id, array_to_json(factors_completed)::text AS factor_names, attempts,
		token_mac, token_mac_key_version,
		${epochColumns(`${table}.session_epoch`, states, `${table}.user_id`)},
		${generationColumns(table, states)}`;
}

function accountStateStatement(states: string): string {
	return `SELECT COALESCE((SELECT session_epoch FROM ${states} WHERE user_id = $1), 1)::text
		AS session_epoch,
		(SELECT attempt_generation FROM ${states} WHERE user_id = $1)::text AS attempt_generation`;
}

export function createPendingAuthenticationRepository(
	options: PendingAuthenticationRepositoryOptions,
): PendingAuthenticationRepository {
	const table = qualifiedTableName(options.schema, "pending_authentication");
	const totp = qualifiedTableName(options.schema, "totp_credential");
	const webauthn = qualifiedTableName(options.schema, "webauthn_credential");
	const recovery = qualifiedTableName(options.schema, "recovery_code");
	const insertSql = insertStatement(table, totp, webauthn, recovery);
	const states = qualifiedTableName(options.schema, "security_state");
	const resolveSql = resolveStatement(
		table,
		qualifiedTableName(options.schema, "user"),
		totp,
		webauthn,
		recovery,
		states,
	);
	const countAttemptSql = countAttemptStatement(table);
	const deleteSql = deleteStatement(table, states);
	const accountStateSql = accountStateStatement(states);

	async function removeByTokenHash(
		driver: Driver,
		tokenHash: Uint8Array,
	): Promise<PendingCandidate<RemovedPendingAuthentication> | null> {
		const [row] = await driver.query<RemovedPendingRowShape>(deleteSql, [tokenHash]);
		return row === undefined
			? null
			: candidateOf(row, (factorsCompleted) => ({
					userId: row.user_id,
					factorsCompleted: toFactors(factorsCompleted),
				}));
	}

	return {
		async insertPendingAuthentication(insert) {
			const [row] = await options.driver.query<InsertedPendingRowShape>(insertSql, [
				insert.tokenHash,
				insert.userId,
				toFactorArray(insert.factorsCompleted),
				insert.lifetimeInSeconds,
				insert.tokenMac,
				insert.tokenMacKeyVersion,
				insert.sessionEpoch,
				insert.attemptGeneration,
			]);
			if (row === undefined) {
				throw new TypeError("the insert of a pending authentication returned no row");
			}
			return toStored(row);
		},

		async accountStateOf({ userId }) {
			const [row] = await options.driver.query<{
				session_epoch: string;
				attempt_generation: string | null;
			}>(accountStateSql, [userId]);
			return {
				sessionEpoch: Number(row?.session_epoch),
				attemptGeneration:
					row?.attempt_generation === null || row?.attempt_generation === undefined
						? null
						: Number(row.attempt_generation),
			};
		},

		async findPendingAuthenticationByTokenHash(tokenHash) {
			const [row] = await options.driver.query<OwnedPendingRowShape>(resolveSql, [tokenHash]);
			return row === undefined
				? null
				: candidateOf(row, (factorsCompleted) => ({
						...toStored({ ...row, factors_completed: factorsCompleted }),
						userDisabledAt: toOptionalDate(row.disabled_at),
						observedAt: toDate(row.observed_at),
					}));
		},

		async bookAttempt({ tokenHash, checked, next }) {
			const rows = await options.driver.query(countAttemptSql, [
				tokenHash,
				checked.tokenMac,
				checked.attempts + 1,
				next.tokenMac,
				next.tokenMacKeyVersion,
				next.attemptGeneration,
			]);
			return rows.length === 1;
		},

		deletePendingAuthenticationByTokenHash: (tokenHash) =>
			removeByTokenHash(options.driver, tokenHash),
	};
}
