import type { FailedAttempt, PendingAuthenticationService, PendingResolution } from "./service.js";
import type { PendingToken } from "./token.js";

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

type Booking = (token: PendingToken) => Promise<BookedAttempt>;

const LENT_BOOKING = Symbol("velve.pendingBooking");

//the service carries its own booking so this module keeps nothing between calls
export function lendBooking(service: PendingAuthenticationService, booking: Booking): void {
	Object.defineProperty(service, LENT_BOOKING, { value: booking });
}

//a factor check reaches the budget only through the service whose keys verify the row (S-INTEG-9)
export function bookAttemptOn(
	service: PendingAuthenticationService,
	token: PendingToken,
): Promise<BookedAttempt> {
	const booking: unknown = Reflect.get(service, LENT_BOOKING);
	if (typeof booking !== "function") {
		throw new TypeError(
			"attempts are booked only on a service createPendingAuthenticationService built",
		);
	}
	return (booking as Booking)(token);
}
