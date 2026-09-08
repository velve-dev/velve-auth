import type { UserId } from "./entity-id.js";

declare const actorBrand: unique symbol;
declare const resolvedSessionBrand: unique symbol;
declare const redeemedOneTimeTokenBrand: unique symbol;
declare const consumedOAuthFlowBrand: unique symbol;

export type Actor = string & { readonly [actorBrand]: "an owner some proof named" };

/** The shape session resolution returns; the brand is asserted there and nowhere else (E-93). */
export type ResolvedSession = { readonly userId: string } & {
	readonly [resolvedSessionBrand]: "produced by session resolution";
};

/**
 * E-234: the provenance a password reset has instead of a session. The brand is asserted where the
 * `DELETE … RETURNING` removed the row and nowhere else, so an account identifier out of a request
 * cannot take its place.
 */
export type RedeemedOneTimeToken = { readonly userId: UserId } & {
	readonly [redeemedOneTimeTokenBrand]: "produced by one-time token consumption";
};

/**
 * E-234, second provenance: a flow row of `velve.oauth_flow` that the callback consumed. No
 * repository asserts this brand yet — the feature that consumes the flow asserts it where it
 * removes the row, exactly as `db/repositories/token.ts` does for the redemption above.
 */
export type ConsumedOAuthFlow = { readonly userId: UserId } & {
	readonly [consumedOAuthFlowBrand]: "produced by oauth flow consumption";
};

// S-OWNER-7: an actor comes from a proof of ownership, so a user id read from a request cannot become one.
export function actorOfResolvedSession(session: ResolvedSession): Actor {
	return session.userId as Actor;
}

// A `UserId` and an `Actor` are two brands over the same string, and neither widens into the other.
export function actorOfRedeemedOneTimeToken(redeemed: RedeemedOneTimeToken): Actor {
	return redeemed.userId as string as Actor;
}

export function actorOfConsumedOAuthFlow(flow: ConsumedOAuthFlow): Actor {
	return flow.userId as string as Actor;
}
