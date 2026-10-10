import {
	type AccountEnvelopes,
	EnvelopeChangedSinceReadError,
	type OpenTransaction,
	rebindEnvelopesOfAccount,
} from "../auth/account-envelopes.js";
import { unboundReadingOf } from "../auth/security-state.js";
import type { Actor } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import type { IssueAuthorisation } from "../db/repositories/session.js";
import type { SecondFactor } from "../factor/pending/repository.js";
import type { Clock } from "../http/environment.js";
import { ConcealedError, type ConcealedReason } from "../http/error-map.js";
import { encodeBase64Url } from "../keys/base64url.js";
import { KeyError, type KeyErrorCode } from "../keys/errors.js";
import type { KeyProvider } from "../keys/provider.js";
import type { PasswordCredentialRow } from "../password/credential.js";
import type { PasswordScheme } from "../password/scheme.js";
import type { TokenBindingRefusalReport } from "../token/binding.js";
import {
	createSecurityStateAlarms,
	type SecurityStateAlarmCallback,
	type SecurityStateAlarmLog,
	type SecurityStateAlarmOccasion,
	type SecurityStateAlarms,
} from "./alarm.js";
import {
	type AnchorReading,
	compareWithAnchors,
	consultAnchors,
	recordSealWithAnchors,
	type SecurityStateAnchorPort,
} from "./anchor.js";
import type { LimitsConfig } from "./limits.js";
import {
	checkSecurityState,
	readSecurityState,
	type SealingMode,
	type SecurityStateRead,
	securityStateOfDocument,
} from "./read.js";
import { verifySeal } from "./seal.js";
import {
	runSealingTransaction,
	type SealingChange,
	SealingRefusedError,
	type SealWritten,
	sealUnderAccountLock,
} from "./sealing.js";

/** everything the request path needs to check and seal an account's security state */
export interface SecurityStateRuntime {
	readonly driver: Driver;
	readonly schema: string;
	readonly keys: KeyProvider;
	readonly sealing: SealingMode;
	readonly limits: LimitsConfig;
	readonly anchors: readonly SecurityStateAnchorPort[];
	readonly alarms: SecurityStateAlarms;
	/** where the token and envelope branches report a refused row */
	readonly reportTokenBindingRefusal: TokenBindingRefusalReport;
}

export function createSecurityStateRuntime(input: {
	readonly driver: Driver;
	readonly schema: string;
	readonly keys: KeyProvider;
	readonly sealing: SealingMode;
	readonly limits: LimitsConfig;
	readonly anchors: readonly SecurityStateAnchorPort[];
	readonly alarm: SecurityStateAlarmCallback | undefined;
	readonly log: SecurityStateAlarmLog;
	readonly clock: Clock;
}): SecurityStateRuntime {
	const alarms = createSecurityStateAlarms({
		callback: input.alarm,
		log: input.log,
		clock: input.clock,
	});
	return {
		driver: input.driver,
		schema: input.schema,
		keys: input.keys,
		sealing: input.sealing,
		limits: input.limits,
		anchors: input.anchors,
		alarms,
		//listing an account's sessions is a check of a session row like its resolution (E-3381)
		reportTokenBindingRefusal: (refusal) =>
			alarms.raise({
				userId: refusal.userId,
				occasion: refusal.occasion === "session_list" ? "session_resolve" : refusal.occasion,
				reason: refusal.reason,
			}),
	};
}

/** the stored envelopes of a verified read, in the shape the envelope rewrite takes */
export function envelopesOf(read: SecurityStateRead): AccountEnvelopes {
	return {
		password:
			read.password === null
				? null
				: { keyVersion: read.password.keyVersion, ciphertext: read.password.phc },
		totpSecret:
			read.totp === null
				? null
				: { keyVersion: read.totp.keyVersion, ciphertext: read.totp.secretEnc },
		identities: read.identities.map((identity) => ({
			identityId: identity.id,
			accessTokenEnc: identity.accessTokenEnc,
			refreshTokenEnc: identity.refreshTokenEnc,
			idTokenEnc: identity.idTokenEnc,
			tokenKeyVersion: identity.tokenKeyVersion,
		})),
	};
}

/** the verified read with the ciphertexts an envelope rewrite stored put in place of the old ones */
export function readWithEnvelopes(
	read: SecurityStateRead,
	envelopes: AccountEnvelopes,
): SecurityStateRead {
	return {
		...read,
		password:
			read.password === null || envelopes.password === null
				? read.password
				: {
						...read.password,
						phc: envelopes.password.ciphertext,
						keyVersion: envelopes.password.keyVersion,
					},
		totp:
			read.totp === null || envelopes.totpSecret === null
				? read.totp
				: {
						...read.totp,
						secretEnc: envelopes.totpSecret.ciphertext,
						keyVersion: envelopes.totpSecret.keyVersion,
					},
		identities: read.identities.map((identity) => {
			const rewritten = envelopes.identities.find((stored) => stored.identityId === identity.id);
			if (rewritten === undefined) {
				return identity;
			}
			const { identityId: _rewrittenRow, ...tokens } = rewritten;
			return { ...identity, ...tokens };
		}),
	};
}

//an unsealed account is converted from the ciphertexts of the one verified read (E-3300)
function convertingUnsealed(runtime: SecurityStateRuntime, actor: Actor) {
	return async (tx: Driver, read: SecurityStateRead): Promise<SecurityStateRead> => {
		const rewrite = await rebindEnvelopesOfAccount({
			//the guarded driver is the sealing transaction the account lock was taken in (E-3293)
			driver: tx as OpenTransaction,
			schema: runtime.schema,
			keys: runtime.keys,
			actor,
			sealing: runtime.sealing,
			read: { ...envelopesOf(read), sealRow: "absent" },
		});
		return readWithEnvelopes(read, rewrite.envelopes);
	};
}

export function recordSealLater(
	runtime: SecurityStateRuntime,
	sealed: SealWritten<unknown>,
	occasion: SecurityStateAlarmOccasion,
): void {
	if (sealed.leftUnsealed) {
		return;
	}
	void recordSealWithAnchors(
		runtime.anchors,
		{ userId: sealed.userId, version: sealed.version, digest: encodeBase64Url(sealed.digest) },
		() => runtime.alarms.raise({ userId: sealed.userId, occasion, reason: "anchor_unavailable" }),
	);
}

const BINDING_FAILURES: ReadonlySet<KeyErrorCode> = new Set([
	"authentication_failed",
	"envelope_unbound",
	"envelope_malformed",
	"ciphertext_malformed",
]);

//an envelope that fails under its own binding was copied, moved or replaced past the seal (S-INTEG-1)
export function reportEnvelopeRefusal(
	runtime: SecurityStateRuntime,
	userId: string | null,
	occasion: SecurityStateAlarmOccasion,
	failure: unknown,
): void {
	if (failure instanceof KeyError && BINDING_FAILURES.has(failure.code)) {
		runtime.alarms.raise({ userId, occasion, reason: "envelope_binding_mismatch" });
	}
}

function refusedAndReported(
	runtime: SecurityStateRuntime,
	userId: string,
	occasion: SecurityStateAlarmOccasion,
	refusal: ConcealedReason,
	error: unknown,
	accountMissing: (() => Error) | undefined,
): never {
	if (
		error instanceof SealingRefusedError &&
		error.reason === "account_missing" &&
		accountMissing !== undefined
	) {
		throw accountMissing();
	}
	if (error instanceof SealingRefusedError) {
		if (error.reason !== "account_missing" && error.reason !== "version_exhausted") {
			runtime.alarms.raise({ userId, occasion, reason: error.reason });
		}
		throw new ConcealedError(refusal);
	}
	if (error instanceof KeyError && BINDING_FAILURES.has(error.code)) {
		reportEnvelopeRefusal(runtime, userId, occasion, error);
		throw new ConcealedError(refusal);
	}
	//a ciphertext swapped between the verified read and its rewrite is a broken state (E-3300)
	if (error instanceof EnvelopeChangedSinceReadError) {
		runtime.alarms.raise({ userId, occasion, reason: "seal_mismatch" });
		throw new ConcealedError(refusal);
	}
	throw error;
}

/** the account a change is for, as the proof of ownership its path holds or as the id it named without one */
export type ChangedAccount = Actor | { readonly unproven: string };

/** the version and epoch a session issued under a change's new seal is bound to */
export function issueAuthorisationOf(sealed: SealWritten<unknown>): IssueAuthorisation {
	return sealed.leftUnsealed
		? "unsealed"
		: { version: sealed.version, sessionEpoch: sealed.sessionEpoch };
}

//a change checks the seal under the account lock, writes, reseals and only then tells the anchor (S-INTEG-3)
export async function sealChange<T>(
	runtime: SecurityStateRuntime,
	account: ChangedAccount,
	change: SealingChange<T>,
	options: {
		readonly driver?: Driver;
		readonly occasion?: SecurityStateAlarmOccasion;
		/** what a broken state is answered as, the ordinary failure of the path that changes */
		readonly refusal?: ConcealedReason;
		/** the failure a path answers an account that does not exist with, where it has its own */
		readonly accountMissing?: () => Error;
		/** what the anchors answered, asked by a path that takes the account lock before the change does */
		readonly anchorReading?: AnchorReading;
	} = {},
): Promise<SealWritten<T>> {
	const occasion = options.occasion ?? "change";
	const refusal = options.refusal ?? "broken_state_on_change";
	const userId = typeof account === "string" ? account : account.unproven;
	const anchorReading = options.anchorReading ?? (await consultAnchors(runtime.anchors, userId));
	const context =
		typeof account === "string"
			? {
					schema: runtime.schema,
					keys: runtime.keys,
					sealing: runtime.sealing,
					convertUnsealed: convertingUnsealed(runtime, account),
				}
			: {
					schema: runtime.schema,
					keys: runtime.keys,
					sealing: runtime.sealing,
					leaveUnsealed: true,
				};
	let sealed: SealWritten<T>;
	try {
		sealed =
			options.driver === undefined
				? await runSealingTransaction(runtime.driver, (tx) =>
						sealUnderAccountLock(tx, userId, context, anchorReading, change),
					)
				: await sealUnderAccountLock(options.driver, userId, context, anchorReading, change);
	} catch (error) {
		refusedAndReported(runtime, userId, occasion, refusal, error, options.accountMissing);
	}
	recordSealLater(runtime, sealed, occasion);
	return sealed;
}

/** what a check of an account found, with the read a path may evaluate when it is usable */
export type AccountCheck =
	| {
			readonly kind: "usable";
			readonly read: SecurityStateRead;
			readonly authorisedBy: IssueAuthorisation;
	  }
	| { readonly kind: "broken" }
	| { readonly kind: "missing" };

function brokenVerdictOf(
	verdict: Awaited<ReturnType<typeof checkSecurityState>>["verdict"],
	anchorVerdict: ReturnType<typeof compareWithAnchors>,
) {
	if (verdict !== "valid" && verdict !== "unsealed") {
		return verdict;
	}
	return anchorVerdict === "version_below_anchor" ||
		anchorVerdict === "anchor_mismatch" ||
		anchorVerdict === "anchor_unavailable"
		? anchorVerdict
		: null;
}

async function checkedRead(
	runtime: SecurityStateRuntime,
	read: SecurityStateRead,
	anchorReading: AnchorReading,
	occasion: SecurityStateAlarmOccasion,
	reportBroken: boolean,
): Promise<AccountCheck> {
	const { verdict } = await checkSecurityState(runtime.keys, read, runtime.sealing);
	const anchorVerdict = compareWithAnchors(read.seal, anchorReading);
	const broken = brokenVerdictOf(verdict, anchorVerdict);
	if (broken !== null) {
		if (reportBroken) {
			runtime.alarms.raise({ userId: read.userId, occasion, reason: broken });
		}
		return { kind: "broken" };
	}
	if (read.seal === null) {
		return { kind: "usable", read, authorisedBy: "unsealed" };
	}
	//only a seal this check verified is recorded again with an anchor that is behind (E-3380)
	if (anchorVerdict === "ahead_of_anchor") {
		void recordSealWithAnchors(
			runtime.anchors,
			{
				userId: read.userId,
				version: read.seal.version,
				digest: encodeBase64Url(read.seal.digest),
			},
			() => runtime.alarms.raise({ userId: read.userId, occasion, reason: "anchor_unavailable" }),
		);
	}
	return {
		kind: "usable",
		read,
		authorisedBy: { version: read.seal.version, sessionEpoch: read.seal.sessionEpoch },
	};
}

//what a path evaluates must come from the read the check verified (S-INTEG-4)
export async function checkAccount(
	runtime: SecurityStateRuntime,
	userId: string,
	occasion: SecurityStateAlarmOccasion,
	options: {
		readonly driver?: Driver;
		/** what the anchors answered, asked by a path before it took the account lock */
		readonly anchorReading?: AnchorReading;
	} = {},
): Promise<AccountCheck> {
	const anchorReading = options.anchorReading ?? (await consultAnchors(runtime.anchors, userId));
	const read = await readSecurityState(options.driver ?? runtime.driver, runtime.schema, userId);
	if (read === null) {
		return { kind: "missing" };
	}
	return checkedRead(runtime, read, anchorReading, occasion, true);
}

/** what a session resolution found in the state document its one statement read */
type SessionStateVerdict = "usable" | "broken" | "read_again";

//a resolution learns its account from its one statement and asks the anchor after it (E-3353)
export function sessionStateCheckOf(runtime: SecurityStateRuntime) {
	return async (
		userId: string,
		document: string | null,
		attempt: "first" | "second",
	): Promise<SessionStateVerdict> => {
		const read = securityStateOfDocument(document);
		if (read === null) {
			return "broken";
		}
		const anchorReading = await consultAnchors(runtime.anchors, userId);
		const behindTheAnchor =
			attempt === "first" &&
			compareWithAnchors(read.seal, anchorReading) === "version_below_anchor";
		if (behindTheAnchor) {
			return "read_again";
		}
		const check = await checkedRead(runtime, read, anchorReading, "session_resolve", true);
		return check.kind === "usable" ? "usable" : "broken";
	};
}

const STAND_IN_CONTEXT = "velve-auth/stand-in-account/v1";
const utf8 = new TextEncoder();

//an unknown account is asked about under the same id each time so a store with a cache answers alike (E-3352)
async function standInUserIdFor(keys: KeyProvider, identifier: string): Promise<string> {
	const { key } = await keys.current("token-pepper");
	const mac = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, utf8.encode(`${STAND_IN_CONTEXT}\u0000${identifier}`)),
	);
	const hex = Array.from(mac.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const STAND_IN_DIGEST = new Uint8Array(32);

//a password sign-in for an unknown account does the work of a known one and discards it (S-INTEG-5)
export async function checkAccountOrStandIn(
	runtime: SecurityStateRuntime,
	userId: string | null,
	identifier: string,
): Promise<AccountCheck> {
	if (userId !== null) {
		return checkAccount(runtime, userId, "sign_in");
	}
	const standIn = await standInUserIdFor(runtime.keys, identifier);
	await consultAnchors(runtime.anchors, standIn);
	await readSecurityState(runtime.driver, runtime.schema, standIn);
	const { version } = await runtime.keys.current("state-mac");
	await verifySeal(
		runtime.keys,
		{
			userId: standIn,
			version: 1,
			sessionEpoch: 1,
			email: identifier,
			emailVerified: false,
			disabled: false,
			password: null,
			passwordResetRequired: false,
			totp: null,
			passkeys: [],
			identities: [],
			recoveryCodes: [],
		},
		{ keyVersion: version, digest: STAND_IN_DIGEST },
	);
	return { kind: "missing" };
}

/** the password credential a verified read holds, in the shape the password check evaluates */
export function passwordCredentialOf(
	runtime: SecurityStateRuntime,
	read: SecurityStateRead,
): PasswordCredentialRow | null {
	return read.password === null
		? null
		: {
				userId: read.userId,
				phc: read.password.phc,
				keyVersion: read.password.keyVersion,
				scheme: read.password.scheme as PasswordScheme,
				unbound: unboundReadingOf(runtime.sealing, read.seal === null ? "absent" : "present"),
			};
}

/** the second factors a verified read holds, which a sign-in offers and its pending row must still find */
export function secondFactorsOf(read: SecurityStateRead): readonly SecondFactor[] {
	return [
		...(read.totp?.confirmed === true ? (["totp"] as const) : []),
		...(read.passkeys.length > 0 ? (["webauthn"] as const) : []),
		...(read.recoveryCodes.length > 0 ? (["recovery"] as const) : []),
	];
}

/** the session epoch a pending authentication created after this check binds */
export function sessionEpochOf(check: Extract<AccountCheck, { kind: "usable" }>): number {
	return check.authorisedBy === "unsealed" ? 1 : check.authorisedBy.sessionEpoch;
}

/** whether the seal verifies under the lock an issue holds after its conditional insert missed */
export function sealVerifiesUnderLock(runtime: SecurityStateRuntime) {
	return async (tx: Driver, userId: string): Promise<boolean> => {
		const read = await readSecurityState(tx, runtime.schema, userId);
		return (
			read !== null &&
			(await checkSecurityState(runtime.keys, read, runtime.sealing)).verdict === "valid"
		);
	};
}
