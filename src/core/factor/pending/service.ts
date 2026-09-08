import type { Driver } from "../../db/driver.js";
import type { AuthenticationFactor, PendingAuthentication } from "../../http/caller.js";
import { ConcealedError } from "../../http/error-map.js";
import {
	createPendingAuthenticationRepository,
	type PendingAuthenticationRepository,
	type SecondFactor,
} from "./repository.js";
import { createPendingToken, hashPendingToken, type PendingToken } from "./token.js";

/** 3.6 and S-COOKIE-3: the same five minutes the `__Host-velve_pending` cookie is given. */
export const PENDING_LIFETIME_IN_SECONDS = 300;

/** L-8: five tries, then the row goes and the attempt starts again at the password. */
export const MAXIMUM_PENDING_ATTEMPTS = 5;

/**
 * S-CACHE-4 and 3.6: the four routes that read `__Host-velve_pending`. The names are fixed here
 * rather than in each factor module so that the count is one list a test can read, and so that a
 * fifth route cannot be added without changing the list that says there are four.
 */
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

/**
 * S-FIX-4: what resolution yields is deliberately not a `ResolvedSession` and mints no `Actor`, so
 * the intermediate state has no path into a repository method that reaches rows through an owner.
 */
export interface PendingResolution {
	readonly userId: string;
	readonly pending: PendingAuthentication;
	/** The database's clock at the moment it answered. */
	readonly observedAt: Date;
}

export interface ConsumedPendingAuthentication {
	readonly userId: string;
	readonly factorsCompleted: readonly AuthenticationFactor[];
}

export type FailedAttempt =
	| { readonly outcome: "attempts_remain"; readonly attemptsRemaining: number }
	| { readonly outcome: "exhausted" };

export interface PendingAuthenticationServiceOptions {
	readonly driver: Driver;
	readonly schema?: string;
}

export interface PendingAuthenticationService {
	begin(input: {
		readonly userId: string;
		readonly factorsCompleted: readonly AuthenticationFactor[];
		readonly availableFactors: readonly SecondFactor[];
	}): Promise<IssuedPendingAuthentication>;
	resolve(token: PendingToken): Promise<PendingResolution | null>;
	consume(token: PendingToken): Promise<ConsumedPendingAuthentication>;
	registerFailedAttempt(token: PendingToken): Promise<FailedAttempt>;
	cancel(input: { readonly token: PendingToken }): Promise<void>;
}

function attemptsRemainingAfter(attempts: number): number {
	return Math.max(MAXIMUM_PENDING_ATTEMPTS - attempts, 0);
}

export function createPendingAuthenticationService(
	options: PendingAuthenticationServiceOptions,
): PendingAuthenticationService {
	const repository: PendingAuthenticationRepository = createPendingAuthenticationRepository({
		driver: options.driver,
		schema: options.schema ?? "velve",
	});

	return {
		async begin({ userId, factorsCompleted, availableFactors }) {
			const token = createPendingToken();
			const stored = await repository.insertPendingAuthentication({
				userId,
				tokenHash: hashPendingToken(token),
				factorsCompleted,
				lifetimeInSeconds: PENDING_LIFETIME_IN_SECONDS,
			});
			return {
				token,
				pending: {
					factorsCompleted: stored.factorsCompleted,
					availableFactors,
					attemptsRemaining: attemptsRemainingAfter(stored.attempts),
					expiresAt: stored.expiresAt,
				},
			};
		},

		/**
		 * A disabled account answers as an unknown state rather than as `account_disabled`: L-4 puts
		 * that code on the resolution of an existing session, and this is a sign-in still in progress.
		 */
		async resolve(token) {
			const found = await repository.findPendingAuthenticationByTokenHash(hashPendingToken(token));
			if (found === null || found.userDisabledAt !== null) {
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

		// S-RACE-1: the removal is the check, so two requests carrying the same token cannot both pass.
		async consume(token) {
			const removed = await repository.deletePendingAuthenticationByTokenHash(
				hashPendingToken(token),
			);
			if (removed === null) {
				throw new ConcealedError("pending_consumed");
			}
			return removed;
		},

		async registerFailedAttempt(token) {
			const counted = await repository.countFailedAttempt({
				tokenHash: hashPendingToken(token),
				maximumAttempts: MAXIMUM_PENDING_ATTEMPTS,
			});
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
