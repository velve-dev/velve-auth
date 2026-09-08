import type { ConcealedReason } from "../http/error-map.js";
import { type KeyProvider, randomBytes } from "../keys/index.js";
import { createArgon2idHash } from "./argon2.js";
import { encodeStandardBase64 } from "./base64.js";
import type { ResolvedPasswordConfig } from "./config.js";
import {
	openPhc,
	type PasswordCredentialRepository,
	type PasswordCredentialRow,
	sealPhc,
} from "./credential.js";
import { acceptNewPassword, acceptSubmittedPassword } from "./policy.js";
import { needsRewrite } from "./rehash.js";
import { CREATED_SCHEME, type PasswordScheme } from "./scheme.js";
import type { KdfSemaphore } from "./semaphore.js";
import { verifyAgainstScheme } from "./verify-switch.js";

/**
 * No user has this identifier, and every request whose identifier resolved to nobody looks it up,
 * so the absent-user path issues the same query as the present-user path (S-TIM-1, E-174).
 */
export const ABSENT_USER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * The credential the switch reads when no user was resolved. It is a real Argon2id hash with the
 * configured parameters, sealed like any other, so the absent-user path performs the same
 * decryption and calls the same verifier — not the creation function (S-TIM-2).
 */
export type DummyCredential = PasswordCredentialRow;

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
			/**
			 * Present when the credential is behind the current policy or the current key version.
			 * The caller runs it **after** it has sent its answer, so the rehash never lengthens the
			 * measured sign-in (S-TIM-5, 3.3 step 6).
			 */
			readonly rehash?: () => Promise<boolean>;
	  }
	| { readonly outcome: "refused"; readonly reason: ConcealedReason }
	/** The length policy refused; this depends on the input alone and on nothing else (S-DOS-2). */
	| { readonly outcome: "unacceptable" };

export async function createDummyCredential(
	keys: KeyProvider,
	config: ResolvedPasswordConfig,
): Promise<DummyCredential> {
	const phc = await createArgon2idHash(
		new TextEncoder().encode(encodeStandardBase64(randomBytes(32))),
		config.argon2id,
	);
	const sealed = await sealPhc(keys, phc);

	return {
		userId: ABSENT_USER_ID,
		phc: sealed.ciphertext,
		keyVersion: sealed.keyVersion,
		scheme: CREATED_SCHEME,
	};
}

/**
 * Steps 1 to 5 of the sequence in 3.3. After the length check — which depends on the input alone —
 * there is no `return` until the outcome is decided: one credential query, one decryption, one
 * verifier call with identical parameters, and the failure accumulated in a local variable
 * (S-TIM-1, L-1).
 */
export async function checkPassword(
	input: { readonly userId: string | null; readonly plaintext: string },
	environment: PasswordEnvironment,
): Promise<PasswordCheck> {
	const accepted = acceptSubmittedPassword(input.plaintext, environment.config);
	if (accepted === null) {
		return { outcome: "unacceptable" };
	}

	const row = await environment.credentials.findByUserId(input.userId ?? ABSENT_USER_ID);
	const usable = row !== null && isAcceptedScheme(row.scheme, environment.config) ? row : null;
	const source = usable ?? environment.dummy;

	const phc = await openPhc(environment.keys, source);
	const matched = await environment.semaphore.run(() =>
		verifyAgainstScheme(source.scheme, accepted, phc),
	);

	const reason = refusalReason({ row, usable, matched, userId: input.userId });
	if (reason !== null) {
		return { outcome: "refused", reason };
	}

	const current = await environment.keys.current("password-enc");
	if (!needsRewrite(source, phc, current.version, environment.config)) {
		return { outcome: "verified", userId: source.userId };
	}

	return {
		outcome: "verified",
		userId: source.userId,
		rehash: () => rewriteCredential(accepted.bytes, source, environment),
	};
}

/** The setting and changing path: the `validate` hook runs, then Argon2id under the semaphore. */
export async function setPassword(
	input: { readonly userId: string; readonly plaintext: string },
	environment: PasswordEnvironment,
): Promise<void> {
	const accepted = await acceptNewPassword(input.plaintext, environment.config);

	const phc = await environment.semaphore.run(() =>
		createArgon2idHash(accepted.bytes, environment.config.argon2id),
	);

	await environment.credentials.write({ userId: input.userId, phc, scheme: CREATED_SCHEME });
}

// 3.3 step 6: silent, without user interaction, and harmless when it loses the race — the next
// sign-in tries again (E-11).
async function rewriteCredential(
	password: Uint8Array<ArrayBuffer>,
	row: PasswordCredentialRow,
	environment: PasswordEnvironment,
): Promise<boolean> {
	// S-DOS-6: the same semaphore as the check, so a rehash wave cannot displace live sign-ins.
	const phc = await environment.semaphore.run(() =>
		createArgon2idHash(password, environment.config.argon2id),
	);

	return environment.credentials.replaceIfUnchanged({
		userId: row.userId,
		previous: row.phc,
		phc,
		scheme: CREATED_SCHEME,
	});
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
