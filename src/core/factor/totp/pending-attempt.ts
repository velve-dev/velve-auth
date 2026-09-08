import { ConcealedError, VelveError } from "../../http/error-map.js";
import type { PendingAuthenticationService, PendingResolution } from "../pending/service.js";
import type { PendingToken } from "../pending/token.js";

/**
 * L-8, shared by the two factors a pending state can be spent on. The limit is
 * `MAXIMUM_PENDING_ATTEMPTS` in the pending module and is not restated here; the failure that
 * exhausts it answers `too_many_factor_attempts` and takes the state with it, which is what makes
 * the 429 in the route table reachable — a request made after the row is gone answers
 * `invalid_pending_authentication` instead.
 */
export async function verifyUnderPendingAttemptLimit<Result>(
	pending: PendingAuthenticationService,
	token: PendingToken,
	verify: (resolution: PendingResolution) => Promise<Result>,
): Promise<Result> {
	const resolution = await pending.resolve(token);
	if (resolution === null) {
		throw new ConcealedError("pending_not_found");
	}

	try {
		return await verify(resolution);
	} catch (failure) {
		const attempt = await pending.registerFailedAttempt(token);
		if (attempt.outcome === "exhausted") {
			throw new VelveError("too_many_factor_attempts");
		}
		throw failure;
	}
}
