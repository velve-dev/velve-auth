export type AuthenticationFactor = "password" | "totp" | "webauthn" | "recovery" | "oauth";

/** Architecture 3.15 C. */
export interface Session {
	readonly id: string;
	readonly userId: string;
	readonly createdAt: Date;
	readonly lastUsedAt: Date;
	readonly idleExpiresAt: Date;
	readonly absoluteExpiresAt: Date;
	readonly factors: readonly AuthenticationFactor[];
	readonly ipAddress: string | null;
	readonly userAgent: string | null;
	readonly isCurrent: boolean;
}

/** Architecture 3.15 C. */
export interface PendingAuthentication {
	readonly factorsCompleted: readonly AuthenticationFactor[];
	readonly availableFactors: readonly ("totp" | "webauthn" | "recovery")[];
	readonly attemptsRemaining: number;
	readonly expiresAt: Date;
}

/**
 * E-405 and E-472: a `caller: "pending"` route is authorised by the intermediate state and has to
 * act on the account it belongs to, which the presentation above deliberately withholds.
 */
export interface ResolvedPendingAuthentication {
	readonly userId: string;
	readonly pending: PendingAuthentication;
	/** The database's clock at the moment it answered. */
	readonly observedAt: Date;
}

export interface CallerResolver {
	resolveSession(sessionToken: string): Promise<Session>;
	resolvePending(pendingToken: string): Promise<ResolvedPendingAuthentication>;
}
