import type { Actor } from "../db/actor.js";
import type { ConcealedReason } from "../http/error-map.js";
import type { KeyProvider } from "../keys/index.js";
import { randomBytes } from "../token/random.js";
import { createArgon2idHash } from "./argon2.js";
import { encodeStandardBase64 } from "./base64.js";
import type { ResolvedPasswordConfig } from "./config.js";
import {
	openPhc,
	PASSWORD_ENC_PURPOSE,
	type PasswordCredentialRepository,
	type PasswordCredentialRow,
	sealPhc,
} from "./credential.js";
import { MAXIMUM_CONFIGURABLE_MEMORY_KIB } from "./limits.js";
import { acceptNewPassword, acceptSubmittedPassword } from "./policy.js";
import { needsRewrite } from "./rehash.js";
import { CREATED_SCHEME, type PasswordScheme } from "./scheme.js";
import type { KdfSemaphore } from "./semaphore.js";
import { credentialReachesDerivation, verifyAgainstScheme } from "./verify-switch.js";

//an absent user is looked up under this id so both paths issue the same query (E-174)
export const ABSENT_USER_ID = "00000000-0000-0000-0000-000000000000";

//the absent user path verifies a real Argon2id dummy with the configured parameters (S-TIM-2)
export interface DummyCredential extends PasswordCredentialRow {
	//held open so a failed decryption still costs exactly one attempt (E-179)
	readonly openedPhc: string;
}

export interface PasswordEnvironment {
	readonly config: ResolvedPasswordConfig;
	readonly semaphore: KdfSemaphore;
	readonly keys: KeyProvider;
	readonly credentials: PasswordCredentialRepository;
	readonly dummy: DummyCredential;
}

export type PasswordCheck =
	| {
			readonly outcome: "verified";
			readonly userId: string;
			//the caller runs the rehash after answering so it never lengthens the sign-in (S-TIM-5)
			readonly rehash?: () => Promise<SealedRehash | null>;
	  }
	| { readonly outcome: "refused"; readonly reason: ConcealedReason }
	//a length refusal depends on the input alone and on nothing else (S-DOS-2)
	| { readonly outcome: "unacceptable" };

export async function createDummyCredential(
	keys: KeyProvider,
	config: ResolvedPasswordConfig,
): Promise<DummyCredential> {
	const phc = await createArgon2idHash(
		new TextEncoder().encode(encodeStandardBase64(randomBytes(32))),
		config.argon2id,
	);
	const sealed = await sealPhc(keys, ABSENT_USER_ID, phc);

	return {
		userId: ABSENT_USER_ID,
		phc: sealed.ciphertext,
		keyVersion: sealed.keyVersion,
		scheme: CREATED_SCHEME,
		unbound: "refused",
		openedPhc: phc,
	};
}

//after the length check nothing returns early before the outcome is decided (S-TIM-1)
export async function checkPassword(
	input: {
		readonly userId: string | null;
		readonly plaintext: string;
		readonly checked?: PasswordCredentialRow | null;
		readonly onEnvelopeRefused?: (failure: unknown) => void;
	},
	environment: PasswordEnvironment,
): Promise<PasswordCheck> {
	const accepted = acceptSubmittedPassword(input.plaintext, environment.config);
	if (accepted === null) {
		return { outcome: "unacceptable" };
	}

	//what the sign-in evaluates must come from the read the seal check verified (S-INTEG-4)
	const row =
		input.checked === undefined
			? await environment.credentials.findByUserId(input.userId ?? ABSENT_USER_ID)
			: input.checked;
	const usable = row !== null && isAcceptedScheme(row.scheme, environment.config) ? row : null;
	const source = usable ?? environment.dummy;

	const opened = await openCredential(
		environment,
		source,
		usable === null ? undefined : input.onEnvelopeRefused,
	);
	//a hash written under an earlier higher configuration still verifies and is rehashed down (E-2621)
	const memoryCeilingKiB = MAXIMUM_CONFIGURABLE_MEMORY_KIB;
	//a credential refused before deriving is checked as the dummy so its refusal costs the same (S-TIM-2)
	const derivable = credentialReachesDerivation(opened.scheme, opened.phc, memoryCeilingKiB);
	const verified = derivable ? opened : openedDummy(environment);
	const matched = await environment.semaphore.run(() =>
		verifyAgainstScheme(verified.scheme, accepted, verified.phc, memoryCeilingKiB),
	);

	const reason = refusalReason({
		row,
		usable,
		matched: derivable && matched,
		userId: input.userId,
	});
	if (reason !== null) {
		return { outcome: "refused", reason };
	}

	const current = await environment.keys.current(PASSWORD_ENC_PURPOSE);
	if (!needsRewrite(source, opened.phc, current.version, environment.config)) {
		return { outcome: "verified", userId: source.userId };
	}

	return {
		outcome: "verified",
		userId: source.userId,
		rehash: () => rewriteCredential(accepted.bytes, source, environment),
	};
}

export async function setPassword(
	input: {
		readonly actor: Actor;
		readonly plaintext: string;
		//the session may be null where the caller has none but is never left out (E-626)
		readonly setBySessionId: string | null;
	},
	environment: PasswordEnvironment,
): Promise<void> {
	const accepted = await acceptNewPassword(input.plaintext, environment.config);

	const phc = await environment.semaphore.run(() =>
		createArgon2idHash(accepted.bytes, environment.config.argon2id),
	);

	await environment.credentials.write({
		actor: input.actor,
		phc,
		scheme: CREATED_SCHEME,
		setBySessionId: input.setBySessionId,
	});
}

//a rehash hands its hash to the caller who writes it under the account lock (E-3385)
export interface SealedRehash {
	readonly previous: Uint8Array<ArrayBuffer>;
	readonly phc: string;
}

//a rehash that loses the race is harmless as the next sign-in tries again (E-11)
async function rewriteCredential(
	password: Uint8Array<ArrayBuffer>,
	row: PasswordCredentialRow,
	environment: PasswordEnvironment,
): Promise<SealedRehash | null> {
	//the rehash shares the semaphore so a rehash wave cannot displace sign-ins (S-DOS-6)
	const phc = await environment.semaphore.run(() =>
		createArgon2idHash(password, environment.config.argon2id),
	);
	return { previous: row.phc, phc };
}

interface OpenedCredential {
	readonly phc: string;
	readonly scheme: PasswordScheme;
}

function openedDummy(environment: PasswordEnvironment): OpenedCredential {
	return { phc: environment.dummy.openedPhc, scheme: environment.dummy.scheme };
}

//a key version that left the ring fails verification instead of throwing (S-TIM-1)
async function openCredential(
	environment: PasswordEnvironment,
	row: PasswordCredentialRow,
	onRefused: ((failure: unknown) => void) | undefined,
): Promise<OpenedCredential> {
	return openPhc(environment.keys, row).then(
		(phc) => ({ phc, scheme: row.scheme }),
		(failure: unknown) => {
			onRefused?.(failure);
			return openedDummy(environment);
		},
	);
}

function isAcceptedScheme(scheme: PasswordScheme, config: ResolvedPasswordConfig): boolean {
	return scheme === CREATED_SCHEME || config.acceptLegacy.has(scheme);
}

function refusalReason(state: {
	readonly row: PasswordCredentialRow | null;
	readonly usable: PasswordCredentialRow | null;
	readonly matched: boolean;
	readonly userId: string | null;
}): ConcealedReason | null {
	if (state.row === null) {
		return state.userId === null ? "user_not_found" : "no_password_credential";
	}
	if (state.usable === null) {
		return "legacy_scheme_rejected";
	}
	return state.matched ? null : "password_mismatch";
}
