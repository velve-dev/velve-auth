declare const actorBrand: unique symbol;
declare const resolvedSessionBrand: unique symbol;

export type Actor = string & { readonly [actorBrand]: "resolved session" };

/** The shape session resolution returns; the brand is asserted there and nowhere else (E-93). */
export type ResolvedSession = { readonly userId: string } & {
	readonly [resolvedSessionBrand]: "produced by session resolution";
};

// S-OWNER-7: only a resolved session mints an actor, so a user id read from a request cannot become one.
export function actorOfResolvedSession(session: ResolvedSession): Actor {
	return session.userId as Actor;
}
