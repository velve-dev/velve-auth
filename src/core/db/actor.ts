import type { UserId } from "./entity-id.js";

declare const actorBrand: unique symbol;
declare const resolvedSessionBrand: unique symbol;
declare const redeemedOneTimeTokenBrand: unique symbol;
declare const consumedOAuthFlowBrand: unique symbol;
declare const consumedRecoveryCodeBrand: unique symbol;

export type Actor = string & { readonly [actorBrand]: "an owner some proof named" };

/** the session a lookup resolved, whose brand only session resolution asserts */
export type ResolvedSession = { readonly userId: string } & {
	readonly [resolvedSessionBrand]: "produced by session resolution";
};

/** the account a consumed reset token named, which an account id from a request cannot replace */
export type RedeemedOneTimeToken = { readonly userId: UserId } & {
	readonly [redeemedOneTimeTokenBrand]: "produced by one-time token consumption";
};

/** the account an OAuth flow row named, once the callback has consumed that row */
export type ConsumedOAuthFlow = { readonly userId: UserId } & {
	readonly [consumedOAuthFlowBrand]: "produced by oauth flow consumption";
};

//an actor comes only from a proof of ownership, never from a user id in a request (S-OWNER-7)
export function actorOfResolvedSession(session: ResolvedSession): Actor {
	return session.userId as Actor;
}

//a user id and an actor are separate brands and neither widens into the other
export function actorOfRedeemedOneTimeToken(redeemed: RedeemedOneTimeToken): Actor {
	return redeemed.userId as string as Actor;
}

export function actorOfConsumedOAuthFlow(flow: ConsumedOAuthFlow): Actor {
	return flow.userId as string as Actor;
}

//in a reset without session only the removal of the code proves the account is the caller's (E-612)
export type ConsumedRecoveryCode = { readonly userId: UserId } & {
	readonly [consumedRecoveryCodeBrand]: "produced by recovery code consumption";
};

export function actorOfConsumedRecoveryCode(consumed: ConsumedRecoveryCode): Actor {
	return consumed.userId as string as Actor;
}
