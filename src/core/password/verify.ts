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
import { acceptNewPassword, acceptSubmittedPassword } from "./policy.js";
import { needsRewrite } from "./rehash.js";
import { CREATED_SCHEME, type PasswordScheme } from "./scheme.js";
import type { KdfSemaphore } from "./semaphore.js";
import { verifyAgainstScheme } from "./verify-switch.js";

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
			readonly rehash?: () => Promise<boolean>;
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
	const sealed = await sealPhc(keys, phc);

	return {
		userId: ABSENT_USER_ID,
		phc: sealed.ciphertext,
		keyVersion: sealed.keyVersion,
		scheme: CREATED_SCHEME,
		openedPhc: phc,
	};
}

//after the length check nothing returns early before the outcome is decided (S-TIM-1)
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

	const opened = await openCredential(environment, source);
	const matched = await environment.semaphore.run(() =>
		verifyAgainstScheme(opened.scheme, accepted, opened.phc),
	);

	const reason = refusalReason({ row, usable, matched, userId: input.userId });
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
		readonly userId: string;
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
		userId: input.userId,
		phc,
		scheme: CREATED_SCHEME,
		setBySessionId: input.setBySessionId,
	});
}

//a rehash that loses the race is harmless as the next sign-in tries again (E-11)
async function rewriteCredential(
	password: Uint8Array<ArrayBuffer>,
	row: PasswordCredentialRow,
	environment: PasswordEnvironment,
): Promise<boolean> {
	//the rehash shares the semaphore so a rehash wave cannot displace sign-ins (S-DOS-6)
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

//a key version that left the ring fails verification instead of throwing (S-TIM-1)
async function openCredential(
	environment: PasswordEnvironment,
	row: PasswordCredentialRow,
): Promise<{ phc: string; scheme: PasswordScheme }> {
	return openPhc(environment.keys, row).then(
		(phc) => ({ phc, scheme: row.scheme }),
		() => ({ phc: environment.dummy.openedPhc, scheme: environment.dummy.scheme }),
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
