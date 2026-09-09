import type { Actor } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";
import type { KeyProvider } from "../keys/index.js";
import { createArgon2idHash } from "../password/argon2.js";
import type { ResolvedPasswordConfig } from "../password/config.js";
import { createPasswordCredentialRepository } from "../password/credential.js";
import { acceptNewPassword } from "../password/policy.js";
import { CREATED_SCHEME } from "../password/scheme.js";
import type { KdfSemaphore } from "../password/semaphore.js";

/**
 * A password the caller may store: the length policy and the `validate` hook of L-7 have run and
 * Argon2id has produced the string. It is derived before any transaction opens, because a KDF call
 * is two orders of magnitude longer than the statements around it.
 */
export interface DerivedPassword {
	readonly phc: string;
}

export async function derivePassword(
	plaintext: string,
	config: ResolvedPasswordConfig,
	semaphore: KdfSemaphore,
): Promise<DerivedPassword> {
	const accepted = await acceptNewPassword(plaintext, config);
	return { phc: await semaphore.run(() => createArgon2idHash(accepted.bytes, config.argon2id)) };
}

interface CredentialWriter {
	readonly driver: Driver;
	readonly keys: KeyProvider;
	readonly schema: string;
}

/**
 * L-12: the session that stores the password is written with it, in the same statement, so there is
 * no window in which a credential exists without its provenance and no second call to forget
 * (E-626). The repository requires the field; this passes on what the caller has just issued.
 */
export async function writePassword(
	writer: CredentialWriter,
	input: {
		readonly userId: string;
		readonly derived: DerivedPassword;
		readonly setBySessionId: string | null;
	},
): Promise<void> {
	await createPasswordCredentialRepository({
		driver: writer.driver,
		keys: writer.keys,
		schema: writer.schema,
	}).write({
		userId: input.userId,
		phc: input.derived.phc,
		scheme: CREATED_SCHEME,
		setBySessionId: input.setBySessionId,
	});
}

/**
 * The statement S-LINK-4 turns on. `password_credential.set_by_session_id` is the column L-12 needs
 * and 3.2 does not have; every flow that stores a password names the session it was stored in, and
 * a credential whose provenance was never recorded is NULL, which is read as a different session
 * (E-595, E-609).
 */
interface PasswordProvenance {
	deleteUnlessSetInSession(input: {
		readonly actor: Actor;
		readonly sessionId: string | null;
	}): Promise<boolean>;
}

export function createPasswordProvenance(options: {
	readonly driver: Driver;
	readonly schema: string;
}): PasswordProvenance {
	const table = qualifiedTableName(options.schema, "password_credential");

	/* S-LINK-4: the credential survives only when a session is named on both sides and the two are
	   the same. A confirming request without a session and a credential whose provenance was never
	   recorded are both unknown, and unknown is a different session (L-12). */
	const deleteStatement = `DELETE FROM ${table}
WHERE user_id = $1
  AND ($2::uuid IS NULL OR set_by_session_id IS DISTINCT FROM $2::uuid)
RETURNING user_id`;

	return {
		async deleteUnlessSetInSession({ actor, sessionId }) {
			const removed = await options.driver.query(deleteStatement, [actor, sessionId]);
			return removed.length === 1;
		},
	};
}
