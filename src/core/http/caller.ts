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

export interface CallerResolver {
	resolveSession(sessionToken: string): Promise<Session>;
	resolvePending(pendingToken: string): Promise<PendingAuthentication>;
}
