import { ConcealedError, VelveError } from "../../http/error-map.js";
import type { PendingAuthenticationService, PendingResolution } from "./service.js";
import type { PendingToken } from "./token.js";

//the attempt limit is shared by every factor a pending state can be spent on (E-471)
export async function verifyUnderPendingAttemptLimit<Result>(
	pending: PendingAuthenticationService,
	token: PendingToken,
	verify: (resolution: PendingResolution) => Promise<Result>,
): Promise<Result> {
	const resolved = await pending.resolveForAttempt(token);
	if (resolved === null) {
		throw new ConcealedError("pending_not_found");
	}

	try {
		return await verify(resolved.resolution);
	} catch (failure) {
		//the failure counts against the row the resolve checked and no row written since (E-3139)
		const attempt = await resolved.registerFailedAttempt();
		if (attempt.outcome === "exhausted") {
			throw new VelveError("too_many_factor_attempts");
		}
		throw failure;
	}
}
