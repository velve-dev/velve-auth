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

const bookingOfService = new WeakMap<PendingAuthenticationService, Booking>();

export function lendBooking(service: PendingAuthenticationService, booking: Booking): void {
	bookingOfService.set(service, booking);
}

//a factor check reaches the budget only through the service whose keys verify the row (S-INTEG-9)
export function bookAttemptOn(
	service: PendingAuthenticationService,
	token: PendingToken,
): Promise<BookedAttempt> {
	const booking = bookingOfService.get(service);
	if (booking === undefined) {
		throw new TypeError(
			"attempts are booked only on a service createPendingAuthenticationService built",
		);
	}
	return booking(token);
}
