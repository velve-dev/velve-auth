export type AuthenticationFactor = "password" | "totp" | "webauthn" | "recovery" | "oauth";

/** one signed-in session of an account, as the API presents it */
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

/** a sign-in that has passed its first factor and still awaits a second */
export interface PendingAuthentication {
	readonly factorsCompleted: readonly AuthenticationFactor[];
	readonly availableFactors: readonly ("totp" | "webauthn" | "recovery")[];
	readonly attemptsRemaining: number;
	readonly expiresAt: Date;
}

/** the pending state together with the account it belongs to, which the presentation withholds */
export interface ResolvedPendingAuthentication {
	readonly userId: string;
	readonly pending: PendingAuthentication;
	/** the database's clock at the moment it answered */
	readonly observedAt: Date;
}

export interface CallerResolver {
	resolveSession(sessionToken: string): Promise<Session>;
	resolvePending(pendingToken: string): Promise<ResolvedPendingAuthentication>;
}
