import type { Actor } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { lockAccountRow } from "../db/lock.js";
import { withReadCommittedTransactions } from "../db/read-committed.js";
import { createTotpRepository } from "../factor/totp/repository.js";
import { VelveError } from "../http/error-map.js";
import {
	type RebindOutcome,
	rebindEnvelope,
	type UnboundEnvelopeReading,
} from "../keys/envelope-binding.js";
import type { KeyProvider } from "../keys/provider.js";
import { createOAuthIdentityRepository } from "../oauth/identity-repository.js";
import { createPasswordCredentialRepository } from "../password/credential.js";
import { MAXIMUM_STORED_MEMORY_KIB } from "../password/limits.js";
import {
	type SealingMode,
	sealRowPresenceOf,
	sealRowPresentFor,
	unboundReadingOf,
} from "./security-state.js";

/** what rewriting one account's envelopes into the bound form touched */
interface AccountEnvelopeRewrite {
	readonly passwordRewritten: boolean;
	readonly totpRewritten: boolean;
	readonly identitiesRewritten: number;
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
}

async function rebindTotpSecretOf(
	input: AccountEnvelopeTransaction,
	unbound: UnboundEnvelopeReading,
): Promise<RebindOutcome> {
	const credentials = createTotpRepository({ driver: input.driver, schema: input.schema });
	const stored = await credentials.findCredential({ actor: input.actor });
	if (stored === null) {
		return "absent";
	}
	const rebound = await rebindEnvelope(
		input.keys,
		{ column: "totp_credential.secret_enc", owner: input.actor, row: input.actor },
		{ keyVersion: stored.keyVersion, ciphertext: stored.secretEnc },
		unbound,
	);
	if (rebound === null) {
		return "current";
	}
	const replaced = await credentials.replaceSecretIfUnchanged({
		actor: input.actor,
		previous: stored.secretEnc,
		secretEnc: rebound.ciphertext,
		keyVersion: rebound.keyVersion,
	});
	return replaced ? "rebound" : "lost";
}

async function rewriteEveryEnvelope(
	input: AccountEnvelopeTransaction,
	unbound: UnboundEnvelopeReading,
): Promise<readonly RebindOutcome[]> {
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
	return [
		await passwords.rebindOwnedBy({ actor: input.actor, unbound }),
		await rebindTotpSecretOf(input, unbound),
		...(await identities.rebindTokensOwnedBy({ actor: input.actor, unbound })),
	];
}

async function sealRowUnderTheLock(input: AccountEnvelopeTransaction): Promise<boolean> {
	const [row] = await input.driver.query<{ sealed: boolean }>(
		`SELECT ${sealRowPresentFor(input.schema, "$1::uuid")} AS sealed`,
		[input.actor],
	);
	return row?.sealed === true;
}

function wasLeftBehind(outcome: RebindOutcome): boolean {
	return outcome !== "current" && outcome !== "absent";
}

//three user-owned tables are written so the account row is locked first even where the caller holds it
export async function rebindEnvelopesOfAccount(
	input: AccountEnvelopeTransaction,
): Promise<AccountEnvelopeRewrite> {
	await lockAccountRow(input.driver, input.schema, input.actor);
	//the reading is decided under the lock so no caller can open the old form of a sealed account (S-INTEG-1)
	const unbound = unboundReadingOf(
		input.sealing,
		sealRowPresenceOf(await sealRowUnderTheLock(input)),
	);
	const rewritten = await rewriteEveryEnvelope(input, unbound);
	//a rewrite that lost its row or left an old envelope behind must not let the caller seal the account (E-3121)
	if (rewritten.includes("lost")) {
		throw new VelveError("internal_error");
	}
	if ((await rewriteEveryEnvelope(input, "refused")).some(wasLeftBehind)) {
		throw new VelveError("internal_error");
	}
	const [password, totp, ...identities] = rewritten;
	return {
		passwordRewritten: password === "rebound",
		totpRewritten: totp === "rebound",
		identitiesRewritten: identities.filter((outcome) => outcome === "rebound").length,
	};
}
