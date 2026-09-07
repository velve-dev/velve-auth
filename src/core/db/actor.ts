declare const actorBrand: unique symbol;

export type Actor = string & { readonly [actorBrand]: "resolved session" };

export interface ResolvedSessionOwner {
	readonly userId: string;
}

export function actorOfResolvedSession(session: ResolvedSessionOwner): Actor {
	return session.userId as Actor;
}
