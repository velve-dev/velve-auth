import { ConcealedError, VelveError } from "../../http/error-map.js";
import { bookAttemptOn } from "./booking.js";
import type { PendingAuthenticationService, PendingResolution } from "./service.js";
import type { PendingToken } from "./token.js";

//the attempt limit is shared by every factor a pending state can be spent on (E-471)
export async function verifyUnderPendingAttemptLimit<Result>(
	pending: PendingAuthenticationService,
	token: PendingToken,
	verify: (resolution: PendingResolution) => Promise<Result>,
): Promise<Result> {
	const booked = await bookAttemptOn(pending, token);
	if (booked.outcome === "missing") {
		throw new ConcealedError("pending_not_found");
	}
	if (booked.outcome === "exhausted") {
		throw new VelveError("too_many_factor_attempts");
	}

	try {
		return await verify(booked.resolution);
	} catch (failure) {
		const attempt = await booked.failed();
		if (attempt.outcome === "exhausted") {
			throw new VelveError("too_many_factor_attempts");
		}
		throw failure;
	}
}
