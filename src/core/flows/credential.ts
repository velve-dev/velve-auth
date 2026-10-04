import type { Actor } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";
import type { KeyProvider } from "../keys/index.js";
import { createArgon2idHash } from "../password/argon2.js";
import type { ResolvedPasswordConfig } from "../password/config.js";
import { createPasswordCredentialRepository } from "../password/credential.js";
import { storedMemoryCeilingKiB } from "../password/limits.js";
import { acceptNewPassword } from "../password/policy.js";
import { CREATED_SCHEME } from "../password/scheme.js";
import type { KdfSemaphore } from "../password/semaphore.js";

//a password is derived before any transaction opens as the kdf outlasts every statement
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
	readonly password: ResolvedPasswordConfig;
}

interface PasswordToWrite {
	readonly derived: DerivedPassword;
	//the storing session must be written in the same statement as the password (E-626)
	readonly setBySessionId: string | null;
}

function credentialsOf(writer: CredentialWriter) {
	return createPasswordCredentialRepository({
		driver: writer.driver,
		keys: writer.keys,
		schema: writer.schema,
		memoryCeilingKiB: storedMemoryCeilingKiB(writer.password.argon2id.memoryKiB),
	});
}

export async function writePassword(
	writer: CredentialWriter,
	input: { readonly actor: Actor } & PasswordToWrite,
): Promise<void> {
	await credentialsOf(writer).write({
		actor: input.actor,
		phc: input.derived.phc,
		scheme: CREATED_SCHEME,
		setBySessionId: input.setBySessionId,
	});
}

//only a sign-up may call this as its own transaction inserted the account row (E-2428)
export async function writePasswordOfCreatedAccount(
	writer: CredentialWriter,
	input: { readonly userId: string } & PasswordToWrite,
): Promise<void> {
	await credentialsOf(writer).writeForCreatedAccount({
		userId: input.userId,
		phc: input.derived.phc,
		scheme: CREATED_SCHEME,
		setBySessionId: input.setBySessionId,
	});
}

//a credential with no recorded session must count as set in a different session (E-609)
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

	//the credential survives only when both sides name the same session (S-LINK-4)
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
