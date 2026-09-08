import { ConcealedError, VelveError } from "../../http/error-map.js";

// L-8: a pending state allows five attempts; after that the row is deleted and the caller starts at the password.
export const MAXIMUM_FACTOR_ATTEMPTS_PER_PENDING_STATE = 5;

/**
 * The pending state itself belongs to `auth-core`; a second factor only spends attempts from it.
 * An implementation raises pending_authentication.attempts with an updating statement that returns
 * the new count, rather than a row lock, because pnpm check:lock-order accepts a row lock only on
 * the user table.
 */
export interface PendingFactorAttempt {
	readonly userId: string;
	spendAttempt(): Promise<number | null>;
	discard(): Promise<void>;
}

/**
 * L-8: the fifth wrong code is answered with `too_many_factor_attempts` and takes the state with
 * it, so the 429 the route table lists is the attempt that exhausts the budget rather than one
 * made after the row is already gone.
 */
export async function spendPendingAttemptOn<Result>(
	attempt: PendingFactorAttempt,
	verify: () => Promise<Result>,
): Promise<Result> {
	const spent = await attempt.spendAttempt();
	if (spent === null) {
		throw new ConcealedError("pending_not_found");
	}

	try {
		return await verify();
	} catch (failure) {
		if (spent < MAXIMUM_FACTOR_ATTEMPTS_PER_PENDING_STATE) {
			throw failure;
		}
		await attempt.discard();
		throw new VelveError("too_many_factor_attempts");
	}
}
