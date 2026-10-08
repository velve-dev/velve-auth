import type { Actor } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { lockAccountRow } from "../db/lock.js";
import { withReadCommittedTransactions } from "../db/read-committed.js";
import { createTotpRepository } from "../factor/totp/repository.js";
import type { PurposeCiphertext } from "../keys/envelope.js";
import {
	type EnvelopeRewrite,
	rebindEnvelope,
	type UnboundEnvelopeReading,
} from "../keys/envelope-binding.js";
import type { KeyProvider } from "../keys/provider.js";
import {
	createOAuthIdentityRepository,
	type StoredProviderTokens,
} from "../oauth/identity-repository.js";
import { createPasswordCredentialRepository } from "../password/credential.js";
import { MAXIMUM_STORED_MEMORY_KIB } from "../password/limits.js";
import { type SealingMode, type SealRowPresence, unboundReadingOf } from "./security-state.js";

/** every envelope of one account that the rewrite converts, each as its bytes and key version */
interface AccountEnvelopes {
	/** `password_credential.phc` and its `key_version`, or null when the account has no row there */
	readonly password: PurposeCiphertext | null;
	/** `totp_credential.secret_enc` and its `key_version`, or null when the account has no row there */
	readonly totpSecret: PurposeCiphertext | null;
	/** the token columns and `token_key_version` of every `identity` row the account owns */
	readonly identities: readonly StoredProviderTokens[];
}

/** the envelopes of one account and whether it had a seal row, all from the one statement after the account lock */
export interface VerifiedEnvelopeRead extends AccountEnvelopes {
	readonly sealRow: SealRowPresence;
}

/** the envelopes of the account as stored once the rewrite is done, and what it changed */
interface AccountEnvelopeRewrite {
	readonly envelopes: AccountEnvelopes;
	readonly passwordRewritten: boolean;
	readonly totpRewritten: boolean;
	readonly identitiesRewritten: number;
}

/** an envelope no longer held the value the verified read returned when the rewrite swapped it */
export class EnvelopeChangedSinceReadError extends Error {
	readonly code = "envelope_changed_since_read";

	constructor() {
		super("an envelope was replaced between the verified read and its rewrite");
		this.name = "EnvelopeChangedSinceReadError";
	}
}

declare const openTransactionBrand: unique symbol;

/** a driver bound to one open transaction, which only inOneTransaction hands out */
export type OpenTransaction = Driver & { readonly [openTransactionBrand]: "one open transaction" };

//the brand is given to the driver a transaction hands its work and to nothing else (E-3129)
export function inOneTransaction<T>(
	driver: Driver,
	work: (transaction: OpenTransaction) => Promise<T>,
): Promise<T> {
	//a transaction this module opens states its isolation like every other the library opens (E-3310)
	return withReadCommittedTransactions(driver).transaction((transaction) =>
		work(transaction as OpenTransaction),
	);
}

/** the open transaction in which one account's envelopes are rewritten under its lock */
interface AccountEnvelopeTransaction {
	readonly driver: OpenTransaction;
	readonly schema: string;
	readonly keys: KeyProvider;
	readonly actor: Actor;
	readonly sealing: SealingMode;
	readonly read: VerifiedEnvelopeRead;
}

//a swap that finds another value than the verified read is a broken state and rolls the change back (S-INTEG-3)
function storedUnlessLost<Stored>(rewrite: EnvelopeRewrite<Stored>): {
	readonly stored: Stored;
	readonly rebound: boolean;
} {
	if (rewrite.outcome === "lost") {
		throw new EnvelopeChangedSinceReadError();
	}
	return { stored: rewrite.stored, rebound: rewrite.outcome === "rebound" };
}

async function rebindTotpSecretOf(
	input: AccountEnvelopeTransaction,
	read: PurposeCiphertext,
	unbound: UnboundEnvelopeReading,
): Promise<EnvelopeRewrite<PurposeCiphertext>> {
	const rebound = await rebindEnvelope(
		input.keys,
		{ column: "totp_credential.secret_enc", owner: input.actor, row: input.actor },
		read,
		unbound,
	);
	if (rebound === null) {
		return { outcome: "current", stored: read };
	}
	const replaced = await createTotpRepository({
		driver: input.driver,
		schema: input.schema,
	}).replaceSecretIfUnchanged({
		actor: input.actor,
		previous: read,
		secretEnc: rebound.ciphertext,
		keyVersion: rebound.keyVersion,
	});
	return replaced ? { outcome: "rebound", stored: rebound } : { outcome: "lost" };
}

function rebindPasswordOf(
	input: AccountEnvelopeTransaction,
	read: PurposeCiphertext,
	unbound: UnboundEnvelopeReading,
): Promise<EnvelopeRewrite<PurposeCiphertext>> {
	return createPasswordCredentialRepository({
		driver: input.driver,
		keys: input.keys,
		schema: input.schema,
		memoryCeilingKiB: MAXIMUM_STORED_MEMORY_KIB,
	}).rebindOwnedBy({ actor: input.actor, read, unbound });
}

//the account row is locked before any of its three envelope tables is written, even where the caller holds the lock already
export async function rebindEnvelopesOfAccount(
	input: AccountEnvelopeTransaction,
): Promise<AccountEnvelopeRewrite> {
	await lockAccountRow(input.driver, input.schema, input.actor);
	const { read } = input;
	//the old form of a sealed account is never opened, whatever the caller asks (E-3121)
	const unbound = unboundReadingOf(input.sealing, read.sealRow);
	const password =
		read.password === null
			? null
			: storedUnlessLost(await rebindPasswordOf(input, read.password, unbound));
	const totpSecret =
		read.totpSecret === null
			? null
			: storedUnlessLost(await rebindTotpSecretOf(input, read.totpSecret, unbound));
	const identities = (
		await createOAuthIdentityRepository({
			driver: input.driver,
			schema: input.schema,
			keys: input.keys,
		}).rebindTokensOwnedBy({ actor: input.actor, read: read.identities, unbound })
	).map((rewrite) => storedUnlessLost(rewrite));
	return {
		envelopes: {
			password: password?.stored ?? null,
			totpSecret: totpSecret?.stored ?? null,
			identities: identities.map(({ stored }) => stored),
		},
		passwordRewritten: password?.rebound === true,
		totpRewritten: totpSecret?.rebound === true,
		identitiesRewritten: identities.filter(({ rebound }) => rebound).length,
	};
}
