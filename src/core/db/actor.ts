declare const actorBrand: unique symbol;
declare const resolvedSessionBrand: unique symbol;

export type Actor = string & { readonly [actorBrand]: "resolved session" };

// The shape session resolution must return; E-70 records why the parameter below does not demand it yet.
export type ResolvedSession = { readonly userId: string } & {
	readonly [resolvedSessionBrand]: "produced by session resolution";
};

export function actorOfResolvedSession(session: { readonly userId: string }): Actor {
	return session.userId as Actor;
}
