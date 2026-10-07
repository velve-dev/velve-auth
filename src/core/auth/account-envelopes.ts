import type { Actor } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { lockAccountRow } from "../db/lock.js";
import { createTotpRepository } from "../factor/totp/repository.js";
import { rebindEnvelope, type UnboundEnvelopeReading } from "../keys/envelope-binding.js";
import type { KeyProvider } from "../keys/provider.js";
import { createOAuthIdentityRepository } from "../oauth/identity-repository.js";
import { createPasswordCredentialRepository } from "../password/credential.js";
import { MAXIMUM_STORED_MEMORY_KIB } from "../password/limits.js";

/** what rewriting one account's envelopes into the bound form touched */
interface AccountEnvelopeRewrite {
	readonly passwordRewritten: boolean;
	readonly totpRewritten: boolean;
	readonly identitiesRewritten: number;
}

/** the open transaction in which one account's envelopes are rewritten under its lock */
interface AccountEnvelopeTransaction {
	readonly driver: Driver;
	readonly schema: string;
	readonly keys: KeyProvider;
	readonly actor: Actor;
	readonly unbound: UnboundEnvelopeReading;
}

async function rebindTotpSecretOf(input: AccountEnvelopeTransaction): Promise<boolean> {
	const credentials = createTotpRepository({ driver: input.driver, schema: input.schema });
	const stored = await credentials.findCredential({ actor: input.actor });
	if (stored === null) {
		return false;
	}
	const rebound = await rebindEnvelope(
		input.keys,
		{ column: "totp_credential.secret_enc", owner: input.actor, row: input.actor },
		{ keyVersion: stored.keyVersion, ciphertext: stored.secretEnc },
		input.unbound,
	);
	return rebound === null
		? false
		: credentials.replaceSecretIfUnchanged({
				actor: input.actor,
				previous: stored.secretEnc,
				secretEnc: rebound.ciphertext,
				keyVersion: rebound.keyVersion,
			});
}

//three user-owned tables are written so the account row is locked first even where the caller holds it
export async function rebindEnvelopesOfAccount(
	input: AccountEnvelopeTransaction,
): Promise<AccountEnvelopeRewrite> {
	await lockAccountRow(input.driver, input.schema, input.actor);
	const passwords = createPasswordCredentialRepository({
		driver: input.driver,
		keys: input.keys,
		schema: input.schema,
		memoryCeilingKiB: MAXIMUM_STORED_MEMORY_KIB,
	});
	const identities = createOAuthIdentityRepository({
		driver: input.driver,
		schema: input.schema,
		keys: input.keys,
	});
	return {
		passwordRewritten: await passwords.rebindOwnedBy({
			actor: input.actor,
			unbound: input.unbound,
		}),
		totpRewritten: await rebindTotpSecretOf(input),
		identitiesRewritten: await identities.rebindTokensOwnedBy({
			actor: input.actor,
			unbound: input.unbound,
		}),
	};
}
