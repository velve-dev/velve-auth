import type { Actor, DuePasskeyRecovery } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { toEntityId } from "../db/entity-id.js";
import { assertSchemaName, qualifiedTableName } from "../db/identifier.js";
import type { RegisteredWebAuthnCredential } from "../factor/webauthn/service.js";

/** when a held back passkey becomes usable, as the database clock set it */
export interface HeldPasskey {
	readonly activatesAt: Date;
	/** the same instant in whole microseconds since the Unix epoch, which the seal covers */
	readonly activatesAtMicros: number;
}

/** the passkey a recovery moved into the account's credentials, as the seal covers it */
export interface MovedPasskey {
	readonly id: string;
	readonly credentialId: Uint8Array<ArrayBuffer>;
	readonly publicKey: Uint8Array<ArrayBuffer>;
	readonly signCount: number;
}

interface PasskeyRecoveryRepository {
	holdNewPasskey(input: {
		readonly actor: Actor;
		readonly credential: RegisteredWebAuthnCredential;
		readonly label: string;
		readonly waitingPeriodInSeconds: number;
	}): Promise<HeldPasskey | null>;
	withdrawHeldPasskey(input: { readonly actor: Actor }): Promise<number>;
	heldPasskeyOf(input: { readonly actor: Actor }): Promise<HeldPasskey | null>;
	moveHeldPasskeyIntoCredentials(input: { readonly actor: Actor }): Promise<MovedPasskey | null>;
	removeEverySignInMethod(input: { readonly actor: Actor }): Promise<void>;
	//a sign-in presents a credential before anything proves whose it is (E-3768)
	findDueRecoveryOfCredential(input: {
		readonly credentialId: Uint8Array<ArrayBuffer>;
	}): Promise<DuePasskeyRecovery | null>;
}

const UNIQUE_VIOLATION = "23505";

//drivers name the sql state either code or sql state so both are read
function isUniqueViolation(cause: unknown): boolean {
	if (typeof cause !== "object" || cause === null) {
		return false;
	}
	const fields = cause as { readonly code?: unknown; readonly sqlState?: unknown };
	return fields.code === UNIQUE_VIOLATION || fields.sqlState === UNIQUE_VIOLATION;
}

function readBytes(value: unknown): Uint8Array<ArrayBuffer> {
	if (value instanceof Uint8Array) {
		return Uint8Array.from(value);
	}
	throw new TypeError("the driver did not hand back a bytea column as bytes");
}

function readDate(value: unknown): Date {
	if (value instanceof Date) {
		return value;
	}
	throw new TypeError("the driver did not hand back a timestamptz column as a date");
}

//a count of microseconds must be exact before a seal covers it (S-INTEG-12)
function readMicros(value: unknown): number {
	const micros = typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isSafeInteger(micros)) {
		throw new TypeError("the activation time is no exact count of microseconds");
	}
	return micros;
}

interface HeldRow {
	readonly activates_at: unknown;
	readonly activates_at_us: unknown;
}

interface MovedRow {
	readonly id: string;
	readonly credential_id: unknown;
	readonly public_key: unknown;
	readonly sign_count: unknown;
}

function heldOf(row: HeldRow): HeldPasskey {
	return {
		activatesAt: readDate(row.activates_at),
		activatesAtMicros: readMicros(row.activates_at_us),
	};
}

const MICROS_OF_ACTIVATION = `trunc(extract(epoch FROM activates_at) * 1000000)::text`;

export function createPasskeyRecoveryRepository(options: {
	readonly driver: Driver;
	readonly schema: string;
}): PasskeyRecoveryRepository {
	const schema = assertSchemaName(options.schema);
	const table = qualifiedTableName(schema, "passkey_recovery");
	const credentials = qualifiedTableName(schema, "webauthn_credential");

	//a credential id another account already signs in with is never held for this one (E-3767)
	const holdStatement = `INSERT INTO ${table}
	(user_id, credential_id, public_key, sign_count, transports, aaguid,
	 backup_eligible, backup_state, user_verified_at_registration, label, activates_at)
SELECT $1::uuid, $2::bytea, $3::bytea, $4::bigint,
	ARRAY(SELECT jsonb_array_elements_text($5::jsonb)), $6::uuid,
	$7::boolean, $8::boolean, $9::boolean, $10::text,
	now() + make_interval(secs => $11::double precision)
WHERE NOT EXISTS (SELECT 1 FROM ${credentials} taken WHERE taken.credential_id = $2::bytea)
RETURNING activates_at, ${MICROS_OF_ACTIVATION} AS activates_at_us`;

	const withdrawStatement = `DELETE FROM ${table} WHERE user_id = $1 RETURNING 1 AS withdrawn`;

	const heldStatement = `SELECT activates_at, ${MICROS_OF_ACTIVATION} AS activates_at_us
FROM ${table} WHERE user_id = $1`;

	//the held row leaves and the credential row arrives in one statement so neither can exist alone (E-3768)
	const moveStatement = `WITH held AS (
	DELETE FROM ${table} WHERE user_id = $1
	RETURNING user_id, credential_id, public_key, sign_count, transports, aaguid,
		backup_eligible, backup_state, user_verified_at_registration, label
)
INSERT INTO ${credentials}
	(user_id, credential_id, public_key, sign_count, transports, aaguid,
	 backup_eligible, backup_state, user_verified_at_registration, label)
SELECT user_id, credential_id, public_key, sign_count, transports, aaguid,
	backup_eligible, backup_state, user_verified_at_registration, label
FROM held
RETURNING id::text AS id, credential_id, public_key, sign_count::text AS sign_count`;

	//every way in the account had leaves with the activation and each table is named where it is reached (E-3769)
	const removalStatements = [
		`DELETE FROM ${qualifiedTableName(schema, "password_credential")} WHERE user_id = $1`,
		`DELETE FROM ${qualifiedTableName(schema, "password_reset_required")} WHERE user_id = $1`,
		`DELETE FROM ${qualifiedTableName(schema, "totp_used_step")} WHERE user_id = $1`,
		`DELETE FROM ${qualifiedTableName(schema, "totp_credential")} WHERE user_id = $1`,
		`DELETE FROM ${credentials} WHERE user_id = $1`,
		`DELETE FROM ${qualifiedTableName(schema, "recovery_code")} WHERE user_id = $1`,
		`DELETE FROM ${qualifiedTableName(schema, "identity")} WHERE user_id = $1`,
	];

	const dueStatement = `SELECT user_id::text AS user_id FROM ${table}
WHERE credential_id = $1 AND activates_at <= now()`;

	return {
		async holdNewPasskey({ actor, credential, label, waitingPeriodInSeconds }) {
			const rows = await options.driver
				.query<HeldRow>(holdStatement, [
					actor,
					credential.credentialId,
					credential.publicKey,
					credential.signCount,
					JSON.stringify(credential.transports),
					credential.aaguid,
					credential.isBackupEligible,
					credential.isCurrentlyBackedUp,
					credential.wasUserVerifiedAtRegistration,
					label,
					waitingPeriodInSeconds,
				])
				.catch((cause: unknown) => {
					if (isUniqueViolation(cause)) {
						return [];
					}
					throw cause;
				});
			const [row] = rows;
			return row === undefined
				? null
				: {
						activatesAt: readDate(row.activates_at),
						activatesAtMicros: readMicros(row.activates_at_us),
					};
		},

		async withdrawHeldPasskey({ actor }) {
			return (await options.driver.query(withdrawStatement, [actor])).length;
		},

		async heldPasskeyOf({ actor }) {
			const [row] = await options.driver.query<HeldRow>(heldStatement, [actor]);
			return row === undefined ? null : heldOf(row);
		},

		async moveHeldPasskeyIntoCredentials({ actor }) {
			const [row] = await options.driver.query<MovedRow>(moveStatement, [actor]);
			return row === undefined
				? null
				: {
						id: row.id,
						credentialId: readBytes(row.credential_id),
						publicKey: readBytes(row.public_key),
						signCount: Number(row.sign_count),
					};
		},

		async removeEverySignInMethod({ actor }) {
			for (const statement of removalStatements) {
				await options.driver.query(statement, [actor]);
			}
		},

		async findDueRecoveryOfCredential({ credentialId }) {
			const [row] = await options.driver.query<{ user_id: string }>(dueStatement, [credentialId]);
			return row === undefined
				? null
				: ({ userId: toEntityId<"user">(row.user_id) } as DuePasskeyRecovery);
		},
	};
}
