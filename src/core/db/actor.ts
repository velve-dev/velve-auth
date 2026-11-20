import type { UserId } from "./entity-id.js";

declare const actorBrand: unique symbol;
declare const resolvedSessionBrand: unique symbol;
declare const redeemedOneTimeTokenBrand: unique symbol;
declare const consumedOAuthFlowBrand: unique symbol;
declare const consumedRecoveryCodeBrand: unique symbol;
declare const consumedPendingResetBrand: unique symbol;
declare const consumedRecoveryChallengeBrand: unique symbol;
declare const duePasskeyRecoveryBrand: unique symbol;

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

//a mailed reset held back for a second factor proves its account only once its pending row is removed (E-3632)
export type ConsumedPendingReset = { readonly userId: UserId } & {
	readonly [consumedPendingResetBrand]: "produced by pending password reset consumption";
};

export function actorOfConsumedPendingReset(consumed: ConsumedPendingReset): Actor {
	return consumed.userId as string as Actor;
}

//a maintenance call has no route and runs on the application's own authorisation decision (E-3176)
export function actorOfMaintenance(userId: string): Actor {
	return userId as Actor;
}

//the recovery switch has no route and runs on the application's own authorisation decision (E-3733)
export function actorOfRecoverySwitch(userId: string): Actor {
	return userId as Actor;
}

//the authenticator allowlist has no route and runs on the application's own authorisation decision (E-3849)
export function actorOfAuthenticatorAllowlist(userId: string): Actor {
	return userId as Actor;
}

//a recovery registration learns its account only from the challenge its start bound to it (E-3765)
export type ConsumedRecoveryChallenge = { readonly userId: UserId } & {
	readonly [consumedRecoveryChallengeBrand]: "produced by recovery challenge consumption";
};

export function actorOfConsumedRecoveryChallenge(consumed: ConsumedRecoveryChallenge): Actor {
	return consumed.userId as string as Actor;
}

//a recovery whose waiting period has ended is activated for the account its own row names (E-3768)
export type DuePasskeyRecovery = { readonly userId: UserId } & {
	readonly [duePasskeyRecoveryBrand]: "produced by the lookup of a due passkey recovery";
};

export function actorOfDuePasskeyRecovery(due: DuePasskeyRecovery): Actor {
	return due.userId as string as Actor;
}
