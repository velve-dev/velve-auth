import type { Driver } from "../../db/driver.js";
import type {
	AuthenticationFactor,
	PendingAuthentication,
	ResolvedPendingAuthentication,
} from "../../http/caller.js";
import { ConcealedError } from "../../http/error-map.js";
import {
	createPendingAuthenticationRepository,
	type PendingAuthenticationRepository,
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
	readonly schema?: string;
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

export function createPendingAuthenticationService(
	options: PendingAuthenticationServiceOptions,
): PendingAuthenticationService {
	const repository: PendingAuthenticationRepository = createPendingAuthenticationRepository({
		driver: options.driver,
		schema: options.schema ?? "velve",
	});

	return {
		//the factors on offer are the account's state so the write reads them itself (E-735)
		async begin({ userId, factorsCompleted }) {
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
					availableFactors: stored.availableFactors,
					attemptsRemaining: attemptsRemainingAfter(stored.attempts),
					expiresAt: stored.expiresAt,
				},
			};
		},

		//a disabled account answers as an unknown pending state, not with the disabled code
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

		//the removal is the check so two requests with one token cannot both pass
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
