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
	type StoredTokenMac,
	type TokenBinding,
	type TokenBindingRefusalReport,
} from "../../token/binding.js";
import {
	createPendingAuthenticationRepository,
	type PendingAuthenticationRepository,
	type PendingAuthenticationWithOwner,
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
	/** resolves the state and counts a failure against exactly the row this resolve checked */
	resolveForAttempt(token: PendingToken): Promise<ResolvedForAttempt | null>;
	registerFailedAttempt(token: PendingToken): Promise<FailedAttempt>;
	cancel(input: { readonly token: PendingToken }): Promise<void>;
}

/** a resolved pending state together with the one failed attempt that may be counted against it */
export interface ResolvedForAttempt {
	readonly resolution: PendingResolution;
	registerFailedAttempt(): Promise<FailedAttempt>;
}

interface CheckedPendingRow extends StoredTokenMac {
	readonly userId: string;
	readonly factorNames: readonly string[];
	readonly attempts: number;
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

	//a row changed since its check is counted as no row and reported (E-3139)
	async function countAgainst(
		tokenHash: Uint8Array,
		row: CheckedPendingRow,
	): Promise<FailedAttempt> {
		const next = await bindToken(
			options.keys,
			pendingBinding(row.userId, tokenHash, row.factorNames, row.attempts + 1),
		);
		const counted = await repository.countFailedAttempt({
			tokenHash,
			checked: row,
			next,
			maximumAttempts: MAXIMUM_PENDING_ATTEMPTS,
		});
		if (counted === null) {
			reportRefusedTokenRow(options.reportTokenBindingRefusal, {
				userId: row.userId,
				occasion: "factor_check",
				verdict: "mismatch",
			});
		}
		if (counted === null || counted.exhausted) {
			return { outcome: "exhausted" };
		}
		return {
			outcome: "attempts_remain",
			attemptsRemaining: attemptsRemainingAfter(counted.attempts),
		};
	}

	//the row a later count is pinned to is the one this check passed, rebound where it was stale
	async function checkedRowOf(tokenHash: Uint8Array): Promise<{
		readonly row: CheckedPendingRow;
		readonly found: PendingAuthenticationWithOwner;
	} | null> {
		const candidate = await repository.findPendingAuthenticationByTokenHash(tokenHash);
		const checked = await verified(tokenHash, candidate);
		if (checked === null || candidate === null) {
			return null;
		}
		const rebound = await reboundTokenMacIfStale(options.keys, checked.binding, candidate);
		const reboundStored =
			rebound !== null &&
			(await repository.rebindPendingTokenMac({
				tokenHash,
				userId: candidate.userId,
				previous: candidate,
				next: rebound,
			}));
		const mac = reboundStored ? rebound : candidate;
		return {
			row: {
				userId: candidate.userId,
				factorNames: candidate.storedFactorNames ?? [],
				attempts: candidate.attempts,
				tokenMac: mac.tokenMac,
				tokenMacKeyVersion: mac.tokenMacKeyVersion,
			},
			found: checked.decoded,
		};
	}

	//a disabled account answers as an unknown pending state, not with the disabled code
	function resolutionOf(found: PendingAuthenticationWithOwner): PendingResolution | null {
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

		async resolve(token) {
			const checked = await checkedRowOf(hashPendingToken(token));
			return checked === null ? null : resolutionOf(checked.found);
		},

		async resolveForAttempt(token) {
			const tokenHash = hashPendingToken(token);
			const checked = await checkedRowOf(tokenHash);
			const resolution = checked === null ? null : resolutionOf(checked.found);
			if (checked === null || resolution === null) {
				return null;
			}
			return { resolution, registerFailedAttempt: () => countAgainst(tokenHash, checked.row) };
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
			const tokenHash = hashPendingToken(token);
			const checked = await checkedRowOf(tokenHash);
			return checked === null ? { outcome: "exhausted" } : countAgainst(tokenHash, checked.row);
		},

		async cancel({ token }) {
			await repository.deletePendingAuthenticationByTokenHash(hashPendingToken(token));
		},
	};
}
