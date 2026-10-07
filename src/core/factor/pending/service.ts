import type { Driver } from "../../db/driver.js";
import type {
	AuthenticationFactor,
	PendingAuthentication,
	ResolvedPendingAuthentication,
} from "../../http/caller.js";
import { ConcealedError } from "../../http/error-map.js";
import type { KeyProvider } from "../../keys/provider.js";
import {
	bindToken,
	checkTokenBinding,
	reboundTokenMacIfStale,
	reportRefusedTokenRow,
	type TokenBinding,
	type TokenBindingRefusalReport,
} from "../../token/binding.js";
import {
	type CountedAttempt,
	createPendingAuthenticationRepository,
	type PendingAuthenticationRepository,
	type PendingCandidate,
} from "./repository.js";
import { createPendingToken, hashPendingToken, type PendingToken } from "./token.js";

//the pending state lives exactly as long as its cookie (S-COOKIE-3)
export const PENDING_LIFETIME_IN_SECONDS = 300;

//the five attempts are counted per pending flow and not per factor (E-471)
export const MAXIMUM_PENDING_ATTEMPTS = 5;

//the routes reading the pending cookie are one list so a fifth cannot slip in (S-CACHE-4)
export const PENDING_CALLER_ROUTES = [
	"factor.totp.verify",
	"factor.webauthn.authenticate.start",
	"factor.webauthn.authenticate.finish",
	"factor.recovery.verify",
] as const;

export type PendingCallerRoute = (typeof PENDING_CALLER_ROUTES)[number];

export interface IssuedPendingAuthentication {
	readonly token: PendingToken;
	readonly pending: PendingAuthentication;
}

/** the resolved intermediate state, which is not a session and mints no `Actor` */
export type PendingResolution = ResolvedPendingAuthentication;

export interface ConsumedPendingAuthentication {
	readonly userId: string;
	readonly factorsCompleted: readonly AuthenticationFactor[];
}

export type FailedAttempt =
	| { readonly outcome: "attempts_remain"; readonly attemptsRemaining: number }
	| { readonly outcome: "exhausted" };

export interface PendingAuthenticationServiceOptions {
	readonly driver: Driver;
	readonly keys: KeyProvider;
	readonly schema?: string;
	readonly reportTokenBindingRefusal?: TokenBindingRefusalReport;
}

export interface PendingAuthenticationService {
	begin(input: {
		readonly userId: string;
		readonly factorsCompleted: readonly AuthenticationFactor[];
	}): Promise<IssuedPendingAuthentication>;
	resolve(token: PendingToken): Promise<PendingResolution | null>;
	consume(token: PendingToken): Promise<ConsumedPendingAuthentication>;
	registerFailedAttempt(token: PendingToken): Promise<FailedAttempt>;
	cancel(input: { readonly token: PendingToken }): Promise<void>;
}

function attemptsRemainingAfter(attempts: number): number {
	return Math.max(MAXIMUM_PENDING_ATTEMPTS - attempts, 0);
}

//the attempt counter is bound so a writer who resets it is refused like a forged row (S-INTEG-9)
function pendingBinding(
	userId: string,
	tokenHash: Uint8Array,
	factorsCompleted: readonly string[],
	attempts: number,
): TokenBinding {
	return {
		purpose: "pending_authentication",
		ownerId: userId,
		tokenSha256: tokenHash,
		content: { factors: factorsCompleted, attempts },
	};
}

const FIRST_ATTEMPT_COUNT = 0;

export function createPendingAuthenticationService(
	options: PendingAuthenticationServiceOptions,
): PendingAuthenticationService {
	const repository: PendingAuthenticationRepository = createPendingAuthenticationRepository({
		driver: options.driver,
		schema: options.schema ?? "velve",
	});

	//a row the library did not write is answered as no row before anything in it is read (S-INTEG-9)
	async function verified<Decoded>(
		tokenHash: Uint8Array,
		candidate: PendingCandidate<Decoded> | null,
	): Promise<{ readonly binding: TokenBinding; readonly decoded: Decoded } | null> {
		if (candidate === null) {
			return null;
		}
		const names = candidate.storedFactorNames;
		const binding = pendingBinding(candidate.userId, tokenHash, names ?? [], candidate.attempts);
		const verdict =
			names === null ? "mismatch" : await checkTokenBinding(options.keys, binding, candidate);
		if (verdict !== "valid") {
			reportRefusedTokenRow(options.reportTokenBindingRefusal, {
				userId: candidate.userId,
				occasion: "factor_check",
				verdict,
			});
			return null;
		}
		return { binding, decoded: candidate.decode() };
	}

	//a concurrent attempt changes the row so the count is retried on the row it left (E-3134)
	async function countVerifiedAttempt(tokenHash: Uint8Array): Promise<CountedAttempt | null> {
		for (;;) {
			const candidate = await repository.findPendingAuthenticationByTokenHash(tokenHash);
			const checked = await verified(tokenHash, candidate);
			if (checked === null || candidate === null) {
				return null;
			}
			const names = candidate.storedFactorNames ?? [];
			const next = await bindToken(
				options.keys,
				pendingBinding(candidate.userId, tokenHash, names, candidate.attempts + 1),
			);
			const counted = await repository.countFailedAttempt({
				tokenHash,
				checked: candidate,
				next,
				maximumAttempts: MAXIMUM_PENDING_ATTEMPTS,
			});
			if (counted !== null) {
				return counted;
			}
		}
	}

	return {
		//the factors on offer are the account's state so the write reads them itself (E-735)
		async begin({ userId, factorsCompleted }) {
			const token = createPendingToken();
			const tokenHash = hashPendingToken(token);
			const storedFactors = factorsCompleted.filter(
				(factor, index) => factorsCompleted.indexOf(factor) === index,
			);
			const stored = await repository.insertPendingAuthentication({
				userId,
				tokenHash,
				factorsCompleted: storedFactors,
				lifetimeInSeconds: PENDING_LIFETIME_IN_SECONDS,
				...(await bindToken(
					options.keys,
					pendingBinding(userId, tokenHash, storedFactors, FIRST_ATTEMPT_COUNT),
				)),
			});
			return {
				token,
				pending: {
					factorsCompleted: stored.factorsCompleted,
					availableFactors: stored.availableFactors,
					attemptsRemaining: attemptsRemainingAfter(stored.attempts),
					expiresAt: stored.expiresAt,
				},
			};
		},

		//a disabled account answers as an unknown pending state, not with the disabled code
		async resolve(token) {
			const tokenHash = hashPendingToken(token);
			const candidate = await repository.findPendingAuthenticationByTokenHash(tokenHash);
			const checked = await verified(tokenHash, candidate);
			if (checked === null || candidate === null) {
				return null;
			}
			const rebound = await reboundTokenMacIfStale(options.keys, checked.binding, candidate);
			if (rebound !== null) {
				await repository.rebindPendingTokenMac({
					tokenHash,
					userId: candidate.userId,
					previous: candidate,
					next: rebound,
				});
			}
			const found = checked.decoded;
			if (found.userDisabledAt !== null) {
				return null;
			}
			return {
				userId: found.userId,
				pending: {
					factorsCompleted: found.factorsCompleted,
					availableFactors: found.availableFactors,
					attemptsRemaining: attemptsRemainingAfter(found.attempts),
					expiresAt: found.expiresAt,
				},
				observedAt: found.observedAt,
			};
		},

		//the removal is the check so two requests with one token cannot both pass
		async consume(token) {
			const tokenHash = hashPendingToken(token);
			const removed = await verified(
				tokenHash,
				await repository.deletePendingAuthenticationByTokenHash(tokenHash),
			);
			if (removed === null) {
				throw new ConcealedError("pending_consumed");
			}
			return removed.decoded;
		},

		async registerFailedAttempt(token) {
			const counted = await countVerifiedAttempt(hashPendingToken(token));
			if (counted === null || counted.exhausted) {
				return { outcome: "exhausted" };
			}
			return {
				outcome: "attempts_remain",
				attemptsRemaining: attemptsRemainingAfter(counted.attempts),
			};
		},

		async cancel({ token }) {
			await repository.deletePendingAuthenticationByTokenHash(hashPendingToken(token));
		},
	};
}
