import type { Driver } from "../../db/driver.js";
import { qualifiedTableName } from "../../db/identifier.js";
import type { AuthenticationFactor } from "../../http/caller.js";

const AUTHENTICATION_FACTORS: readonly AuthenticationFactor[] = [
	"password",
	"totp",
	"webauthn",
	"recovery",
	"oauth",
];

export type SecondFactor = "totp" | "webauthn" | "recovery";

export interface PendingAuthenticationInsert {
	readonly userId: string;
	readonly tokenHash: Uint8Array;
	readonly factorsCompleted: readonly AuthenticationFactor[];
	readonly lifetimeInSeconds: number;
}

export interface StoredPendingAuthentication {
	readonly userId: string;
	readonly factorsCompleted: readonly AuthenticationFactor[];
	/** Read from the account's own rows, so no caller decides which factors it may be offered. */
	readonly availableFactors: readonly SecondFactor[];
	readonly attempts: number;
	readonly createdAt: Date;
	readonly expiresAt: Date;
}

export interface PendingAuthenticationWithOwner extends StoredPendingAuthentication {
	readonly userDisabledAt: Date | null;
	/** The database's clock at the moment it answered, so no caller compares its own clock with the row. */
	readonly observedAt: Date;
}

export interface RemovedPendingAuthentication {
	readonly userId: string;
	readonly factorsCompleted: readonly AuthenticationFactor[];
}

export interface CountedAttempt {
	readonly attempts: number;
	readonly exhausted: boolean;
}

export interface PendingAuthenticationRepositoryOptions {
	readonly driver: Driver;
	readonly schema: string;
}

/**
 * Not one method takes an `actor`, and E-242 is the reason: every row here is addressed through
 * `token_sha256`, and whoever presents the token has already proved more than `user_id = $2` could
 * check. `insertPendingAuthentication` precedes any session there could be an actor from.
 */
export interface PendingAuthenticationRepository {
	insertPendingAuthentication(
		input: PendingAuthenticationInsert,
	): Promise<StoredPendingAuthentication>;
	findPendingAuthenticationByTokenHash(
		tokenHash: Uint8Array,
	): Promise<PendingAuthenticationWithOwner | null>;
	countFailedAttempt(input: {
		readonly tokenHash: Uint8Array;
		readonly maximumAttempts: number;
	}): Promise<CountedAttempt | null>;
	deletePendingAuthenticationByTokenHash(
		tokenHash: Uint8Array,
	): Promise<RemovedPendingAuthentication | null>;
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

interface OwnedPendingRowShape extends InsertedPendingRowShape {
	readonly disabled_at: unknown;
	readonly observed_at: unknown;
}

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
			throw new TypeError("velve.pending_authentication.factors_completed holds an unknown factor");
		}
	}
	return names.filter(isAuthenticationFactor);
}

/** The literal is built from a closed set, so no value from a request can reach it. */
function toFactorArray(factors: readonly AuthenticationFactor[]): string {
	for (const factor of factors) {
		if (!isAuthenticationFactor(factor)) {
			throw new TypeError(`velve.pending_authentication.factors_completed cannot hold "${factor}"`);
		}
	}
	return `{${[...new Set(factors)].join(",")}}`;
}

function toInterval(seconds: number): string {
	return `${Math.round(seconds)} seconds`;
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

/** The enrolments are read in the statement that writes the row, so the caller cannot name a factor the account does not have (3.6, 3.15 C.1). */
function insertStatement(
	table: string,
	totp: string,
	webauthn: string,
	recovery: string,
): string {
	return `WITH inserted AS (
		INSERT INTO ${table} (token_sha256, user_id, factors_completed, expires_at)
		VALUES ($1, $2, $3::text[], now() + $4::interval)
		RETURNING user_id, factors_completed, attempts, created_at, expires_at
	)
	SELECT i.user_id, array_to_string(i.factors_completed, ',') AS factors_completed,
		i.attempts, i.created_at, i.expires_at,
		${enrolmentColumns(totp, webauthn, recovery, "i.user_id")}
	FROM inserted i`;
}

function enrolmentColumns(
	totp: string,
	webauthn: string,
	recovery: string,
	owner: string,
): string {
	return `EXISTS (SELECT 1 FROM ${totp} t WHERE t.user_id = ${owner} AND t.confirmed_at IS NOT NULL) AS has_totp,
		EXISTS (SELECT 1 FROM ${webauthn} w WHERE w.user_id = ${owner}) AS has_webauthn,
		EXISTS (SELECT 1 FROM ${recovery} r WHERE r.user_id = ${owner}) AS has_recovery`;
}

/**
 * One query, the way S-CACHE-2 answers the same question for a session: the deadline is a
 * predicate rather than a comparison the caller makes, `disabled_at` travels with the row, and the
 * factors still open are counted here so that no second round trip decides what the caller may try.
 */
function resolveStatement(
	table: string,
	users: string,
	totp: string,
	webauthn: string,
	recovery: string,
): string {
	return `SELECT p.user_id, array_to_string(p.factors_completed, ',') AS factors_completed,
		p.attempts, p.created_at, p.expires_at, u.disabled_at, now() AS observed_at,
		${enrolmentColumns(totp, webauthn, recovery, "p.user_id")}
	FROM ${table} p
	JOIN ${users} u ON u.id = p.user_id
	WHERE p.token_sha256 = $1 AND p.expires_at > now()`;
}

function countAttemptStatement(table: string): string {
	return `UPDATE ${table} /* no owner predicate: S-OWNER-2, E-242, the predicate is the secret itself */
	SET attempts = attempts + 1
	WHERE token_sha256 = $1 AND expires_at > now()
	RETURNING attempts`;
}

function deleteStatement(table: string): string {
	return `DELETE FROM ${table} /* no owner predicate: S-OWNER-2, E-242, the predicate is the secret itself */
	WHERE token_sha256 = $1 AND expires_at > now()
	RETURNING user_id, array_to_string(factors_completed, ',') AS factors_completed`;
}

export function createPendingAuthenticationRepository(
	options: PendingAuthenticationRepositoryOptions,
): PendingAuthenticationRepository {
	const table = qualifiedTableName(options.schema, "pending_authentication");
	const totp = qualifiedTableName(options.schema, "totp_credential");
	const webauthn = qualifiedTableName(options.schema, "webauthn_credential");
	const recovery = qualifiedTableName(options.schema, "recovery_code");
	const insertSql = insertStatement(table, totp, webauthn, recovery);
	const resolveSql = resolveStatement(
		table,
		qualifiedTableName(options.schema, "user"),
		totp,
		webauthn,
		recovery,
	);
	const countAttemptSql = countAttemptStatement(table);
	const deleteSql = deleteStatement(table);

	async function removeByTokenHash(
		driver: Driver,
		tokenHash: Uint8Array,
	): Promise<RemovedPendingAuthentication | null> {
		const [row] = await driver.query<{ user_id: string; factors_completed: string }>(deleteSql, [
			tokenHash,
		]);
		return row === undefined
			? null
			: { userId: row.user_id, factorsCompleted: toFactors(row.factors_completed) };
	}

	return {
		async insertPendingAuthentication({ userId, tokenHash, factorsCompleted, lifetimeInSeconds }) {
			const [row] = await options.driver.query<InsertedPendingRowShape>(insertSql, [
				tokenHash,
				userId,
				toFactorArray(factorsCompleted),
				toInterval(lifetimeInSeconds),
			]);
			if (row === undefined) {
				throw new TypeError("the insert of a pending authentication returned no row");
			}
			return toStored(row);
		},

		async findPendingAuthenticationByTokenHash(tokenHash) {
			const [row] = await options.driver.query<OwnedPendingRowShape>(resolveSql, [tokenHash]);
			if (row === undefined) {
				return null;
			}
			return {
				...toStored(row),
				userDisabledAt: toOptionalDate(row.disabled_at),
				observedAt: toDate(row.observed_at),
			};
		},

		/** L-8: the count and the removal that follows it are one transaction, so a fifth failure cannot leave the row behind. */
		countFailedAttempt({ tokenHash, maximumAttempts }) {
			return options.driver.transaction(async (tx) => {
				const [row] = await tx.query<{ attempts: number }>(countAttemptSql, [tokenHash]);
				if (row === undefined) {
					return null;
				}
				const exhausted = row.attempts >= maximumAttempts;
				if (exhausted) {
					await removeByTokenHash(tx, tokenHash);
				}
				return { attempts: row.attempts, exhausted };
			});
		},

		deletePendingAuthenticationByTokenHash: (tokenHash) =>
			removeByTokenHash(options.driver, tokenHash),
	};
}
