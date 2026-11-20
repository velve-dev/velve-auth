import type { Actor, DuePasskeyRecovery } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { toEntityId } from "../db/entity-id.js";
import { assertSchemaName, qualifiedTableName } from "../db/identifier.js";
import {
	isUniqueViolation,
	readBytes,
	readDate,
} from "../factor/webauthn/credential-repository.js";
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
	/** the AAGUID the moved passkey's verified attestation names, or null where none verified */
	readonly attestedAaguid: string | null;
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
	forgetEveryAttestation(input: { readonly actor: Actor }): Promise<void>;
	removeEverySignInMethod(input: { readonly actor: Actor }): Promise<void>;
	//a sign-in presents a credential before anything proves whose it is (E-3768)
	findDueRecoveryOfCredential(input: {
		readonly credentialId: Uint8Array<ArrayBuffer>;
	}): Promise<DuePasskeyRecovery | null>;
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
	readonly attested_aaguid: string | null;
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
	 backup_eligible, backup_state, user_verified_at_registration, label, activates_at,
	 attestation_verified)
SELECT $1::uuid, $2::bytea, $3::bytea, $4::bigint,
	ARRAY(SELECT jsonb_array_elements_text($5::jsonb)), $6::uuid,
	$7::boolean, $8::boolean, $9::boolean, $10::text,
	now() + make_interval(secs => $11::double precision), $12::boolean
WHERE NOT EXISTS (SELECT 1 FROM ${credentials} taken WHERE taken.credential_id = $2::bytea)
RETURNING activates_at, ${MICROS_OF_ACTIVATION} AS activates_at_us`;

	const withdrawStatement = `DELETE FROM ${table} WHERE user_id = $1 RETURNING 1 AS withdrawn`;

	//an infinite time is no date the driver hands back (E-3779)
	const heldStatement = `SELECT activates_at, ${MICROS_OF_ACTIVATION} AS activates_at_us
FROM ${table} WHERE user_id = $1 AND isfinite(activates_at)`;

	//the held row leaves and the credential row arrives in one statement so neither can exist alone (E-3768)
	const moveStatement = `WITH held AS (
	DELETE FROM ${table} WHERE user_id = $1
	RETURNING user_id, credential_id, public_key, sign_count, transports, aaguid,
		backup_eligible, backup_state, user_verified_at_registration, label, attestation_verified
)
INSERT INTO ${credentials}
	(user_id, credential_id, public_key, sign_count, transports, aaguid,
	 backup_eligible, backup_state, user_verified_at_registration, label, attestation_verified)
SELECT user_id, credential_id, public_key, sign_count, transports, aaguid,
	backup_eligible, backup_state, user_verified_at_registration, label, attestation_verified
FROM held
RETURNING id::text AS id, credential_id, public_key, sign_count::text AS sign_count,
	CASE WHEN attestation_verified THEN aaguid::text END AS attested_aaguid`;

	//an attestation nothing can verify again is dropped rather than carried into a seal unconfirmed (E-3851)
	const forgetAttestationStatements = [
		`UPDATE ${credentials} SET attestation_verified = false WHERE user_id = $1 AND attestation_verified`,
		`UPDATE ${table} SET attestation_verified = false WHERE user_id = $1 AND attestation_verified`,
	];

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
					credential.attestationVerified,
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
						attestedAaguid: row.attested_aaguid,
					};
		},

		async forgetEveryAttestation({ actor }) {
			for (const statement of forgetAttestationStatements) {
				await options.driver.query(statement, [actor]);
			}
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
