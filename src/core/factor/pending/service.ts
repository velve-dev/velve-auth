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
	type TokenBindingRefusal,
	type TokenBindingRefusalReport,
	type TokenBindingVerdict,
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
	/** spends one attempt of the budget before the caller evaluates a submitted factor */
	bookAttempt(token: PendingToken): Promise<BookedAttempt>;
	cancel(input: { readonly token: PendingToken }): Promise<void>;
}

/** an attempt already counted against the budget, or why none could be */
export type BookedAttempt =
	| { readonly outcome: "missing" }
	| { readonly outcome: "exhausted" }
	| {
			readonly outcome: "booked";
			readonly resolution: PendingResolution;
			/** reports a wrong factor, which removes the row when this was the last attempt */
			failed(): Promise<FailedAttempt>;
	  };

interface CheckedPendingRow extends StoredTokenMac {
	readonly userId: string;
	readonly factorNames: readonly string[];
	readonly attempts: number;
}

function attemptsRemainingAfter(attempts: number): number {
	return Math.max(MAXIMUM_PENDING_ATTEMPTS - attempts, 0);
}

//a writer who resets the attempt counter must be refused like a forged row (S-INTEG-9)
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

	function bindingOf(tokenHash: Uint8Array, candidate: PendingCandidate<unknown>): TokenBinding {
		return pendingBinding(
			candidate.userId,
			tokenHash,
			candidate.storedFactorNames ?? [],
			candidate.attempts,
		);
	}

	async function verdictOf(
		tokenHash: Uint8Array,
		candidate: PendingCandidate<unknown>,
	): Promise<TokenBindingVerdict> {
		return candidate.storedFactorNames === null
			? "mismatch"
			: checkTokenBinding(options.keys, bindingOf(tokenHash, candidate), candidate);
	}

	function reportRefusal(userId: string, verdict: TokenBindingRefusal["verdict"]): void {
		reportRefusedTokenRow(options.reportTokenBindingRefusal, {
			userId,
			occasion: "factor_check",
			verdict,
		});
	}

	//a row the library did not write is answered as no row before anything in it is read (S-INTEG-9)
	async function verified<Decoded>(
		tokenHash: Uint8Array,
		candidate: PendingCandidate<Decoded> | null,
	): Promise<{ readonly binding: TokenBinding; readonly decoded: Decoded } | null> {
		if (candidate === null) {
			return null;
		}
		const verdict = await verdictOf(tokenHash, candidate);
		if (verdict !== "valid") {
			reportRefusal(candidate.userId, verdict);
			return null;
		}
		return { binding: bindingOf(tokenHash, candidate), decoded: candidate.decode() };
	}

	function checkedRow(
		candidate: PendingCandidate<unknown>,
		mac: StoredTokenMac,
	): CheckedPendingRow {
		return {
			userId: candidate.userId,
			factorNames: candidate.storedFactorNames ?? [],
			attempts: candidate.attempts,
			tokenMac: mac.tokenMac,
			tokenMacKeyVersion: mac.tokenMacKeyVersion,
		};
	}

	//a booking must be pinned to the row this check passed (E-3140)
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
		return {
			row: checkedRow(candidate, reboundStored ? rebound : candidate),
			found: checked.decoded,
		};
	}

	//a missed booking must tell a concurrent attempt from a writer (E-3140)
	async function afterMissedBooking(
		tokenHash: Uint8Array,
		pinned: CheckedPendingRow,
	): Promise<CheckedPendingRow | "missing"> {
		const reread = await repository.findPendingAuthenticationByTokenHash(tokenHash);
		if (reread === null) {
			return "missing";
		}
		const verdict = await verdictOf(tokenHash, reread);
		const advanced =
			reread.attempts > pinned.attempts ||
			(reread.attempts === pinned.attempts &&
				reread.tokenMacKeyVersion > pinned.tokenMacKeyVersion);
		if (verdict !== "valid" || !advanced) {
			reportRefusal(reread.userId, verdict === "valid" ? "mismatch" : verdict);
			return "missing";
		}
		return checkedRow(reread, reread);
	}

	async function exhaust(tokenHash: Uint8Array): Promise<{ readonly outcome: "exhausted" }> {
		await repository.deletePendingAuthenticationByTokenHash(tokenHash);
		return { outcome: "exhausted" };
	}

	async function bookedOver(tokenHash: Uint8Array, row: CheckedPendingRow): Promise<boolean> {
		const next = await bindToken(
			options.keys,
			pendingBinding(row.userId, tokenHash, row.factorNames, row.attempts + 1),
		);
		return repository.bookAttempt({ tokenHash, checked: row, next });
	}

	function bookingOf(
		tokenHash: Uint8Array,
		resolution: PendingResolution,
		attempts: number,
	): BookedAttempt {
		return {
			outcome: "booked",
			resolution,
			failed: async () =>
				attempts >= MAXIMUM_PENDING_ATTEMPTS
					? exhaust(tokenHash)
					: { outcome: "attempts_remain", attemptsRemaining: attemptsRemainingAfter(attempts) },
		};
	}

	//the retries must stay within the budget that every concurrent booking raises (E-3140)
	async function bookFrom(
		tokenHash: Uint8Array,
		resolution: PendingResolution,
		checked: CheckedPendingRow,
	): Promise<BookedAttempt> {
		let row: CheckedPendingRow | "missing" = checked;
		for (let tries = 0; tries <= MAXIMUM_PENDING_ATTEMPTS && row !== "missing"; tries += 1) {
			//the attempt that spent the budget is still evaluated and removes the row itself
			if (row.attempts >= MAXIMUM_PENDING_ATTEMPTS) {
				return { outcome: "exhausted" };
			}
			if (await bookedOver(tokenHash, row)) {
				return bookingOf(tokenHash, resolution, row.attempts + 1);
			}
			row = await afterMissedBooking(tokenHash, row);
		}
		return { outcome: row === "missing" ? "missing" : "exhausted" };
	}

	//no factor is evaluated before its attempt is counted (E-3140)
	async function book(token: PendingToken): Promise<BookedAttempt> {
		const tokenHash = hashPendingToken(token);
		const checked = await checkedRowOf(tokenHash);
		const resolution = checked === null ? null : resolutionOf(checked.found);
		if (checked === null || resolution === null) {
			return { outcome: "missing" };
		}
		return bookFrom(tokenHash, resolution, checked.row);
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

		bookAttempt: book,

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

		async cancel({ token }) {
			await repository.deletePendingAuthenticationByTokenHash(hashPendingToken(token));
		},
	};
}
