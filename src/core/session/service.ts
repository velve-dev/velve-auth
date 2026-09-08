import { type Actor, actorOfResolvedSession, type ResolvedSession } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { createSessionRepository, type SessionInsert } from "../db/repositories/session.js";
import type { AuthenticationFactor, Session } from "../http/caller.js";
import type { Clock } from "../http/environment.js";
import { VelveError } from "../http/error-map.js";
import { type SessionConfig, type SessionSettings, sessionSettingsOf } from "./config.js";
import { assertSessionIsFresh } from "./freshness.js";
import {
	DEFAULT_SESSION_METADATA_MODE,
	type SessionMetadata,
	type SessionMetadataMode,
	sessionMetadataFor,
} from "./metadata.js";
import { createSessionToken, type SessionToken, sessionTokenHash } from "./token.js";

/**
 * The only value the library accepts as proof that a session was resolved (E-93, S-OWNER-7).
 * It is produced in `resolve` and nowhere else, so an actor cannot be built from a request.
 */
export type SessionResolution = ResolvedSession & {
	readonly session: Session;
	/** The database's clock at the moment it answered, and therefore the only clock freshness is decided by (E-238). */
	readonly observedAt: Date;
};

export interface IssuedSession {
	readonly token: SessionToken;
	readonly session: Session;
}

export interface ObservedRequest {
	readonly ipAddress: string | null;
	readonly userAgent: string | null;
}

export interface SessionServiceOptions {
	readonly driver: Driver;
	readonly schema?: string;
	readonly session?: Partial<SessionConfig>;
	readonly sessionMetadata?: SessionMetadataMode;
	/** Accepted so one instance can hand the same clock to every module; this one reads none of it (E-238). */
	readonly clock?: Clock;
}

export interface SessionService {
	readonly settings: SessionSettings;
	issue(input: {
		readonly userId: string;
		readonly factors: readonly AuthenticationFactor[];
		readonly observed: ObservedRequest;
	}): Promise<IssuedSession>;
	reissue(input: {
		readonly previousToken: string;
		readonly userId: string;
		readonly factors: readonly AuthenticationFactor[];
		readonly observed: ObservedRequest;
	}): Promise<IssuedSession>;
	reissueAfterCredentialChange(input: {
		readonly resolved: SessionResolution;
		readonly factors: readonly AuthenticationFactor[];
		readonly observed: ObservedRequest;
	}): Promise<IssuedSession>;
	resolve(token: string): Promise<SessionResolution | null>;
	refresh(token: string): Promise<SessionResolution | null>;
	signOut(input: { readonly token: string }): Promise<void>;
	list(input: { readonly resolved: SessionResolution }): Promise<Session[]>;
	revoke(input: {
		readonly resolved: SessionResolution;
		readonly targetSessionId: string;
	}): Promise<void>;
	revokeEveryOther(input: {
		readonly resolved: SessionResolution;
	}): Promise<{ revokedCount: number }>;
	revokeEvery(input: { readonly resolved: SessionResolution }): Promise<{ revokedCount: number }>;
	revokeEverySessionOfUser(input: { readonly actor: Actor }): Promise<{ revokedCount: number }>;
}

const WRITE_NOW = 0;

/** E-93, S-OWNER-7: the brand of a resolved session is asserted here and nowhere else. */
function resolutionOf(userId: string, session: Session, observedAt: Date): SessionResolution {
	return { userId, session, observedAt } as SessionResolution;
}

export function createSessionService(options: SessionServiceOptions): SessionService {
	const settings = sessionSettingsOf(options.session);
	const metadataMode = options.sessionMetadata ?? DEFAULT_SESSION_METADATA_MODE;
	const sessions = createSessionRepository({
		driver: options.driver,
		schema: options.schema ?? "velve",
	});

	function metadataOf(observed: ObservedRequest): SessionMetadata {
		return sessionMetadataFor(metadataMode, observed);
	}

	function insertFor(
		userId: string,
		factors: readonly AuthenticationFactor[],
		observed: ObservedRequest,
		tokenHash: Uint8Array,
	): SessionInsert {
		return {
			userId,
			tokenHash,
			factors,
			...metadataOf(observed),
			idleTimeoutMs: settings.idleTimeoutMs,
			absoluteTimeoutMs: settings.absoluteTimeoutMs,
		};
	}

	// E-233, E-238: the freshness check sits where the actor is minted, and it reads the clock created_at came from.
	function actorOfFreshSession(resolved: SessionResolution): Actor {
		assertSessionIsFresh(resolved.session, {
			freshnessWindowMs: settings.freshnessWindowMs,
			now: resolved.observedAt,
		});
		return actorOfResolvedSession(resolved);
	}

	async function resolveAndExtend(
		token: string,
		writtenNoSoonerThanMs: number,
	): Promise<SessionResolution | null> {
		const found = await sessions.findSessionByTokenHash(sessionTokenHash(token));
		if (found === null) {
			return null;
		}
		// L-4: the one place in the library where a disabled account is named, and the caller has proved the account is theirs.
		if (found.userDisabledAt !== null) {
			throw new VelveError("account_disabled");
		}
		const resolved = resolutionOf(found.userId, found.session, found.observedAt);
		const sinceLastWrite = found.observedAt.getTime() - found.session.lastUsedAt.getTime();
		if (sinceLastWrite < writtenNoSoonerThanMs) {
			return resolved;
		}
		const extended = await sessions.extendIdleDeadline({
			sessionId: resolved.session.id,
			actor: actorOfResolvedSession(resolved),
			idleTimeoutMs: settings.idleTimeoutMs,
			writtenNoSoonerThanMs,
		});
		return extended === null
			? resolved
			: resolutionOf(found.userId, { ...found.session, idleExpiresAt: extended }, found.observedAt);
	}

	return {
		settings,

		async issue({ userId, factors, observed }) {
			const issued = createSessionToken();
			const session = await sessions.insertSession(
				insertFor(userId, factors, observed, issued.tokenHash),
			);
			return { token: issued.token, session };
		},

		// S-FIX-1: every change of the trust level ends the previous session and begins a new one.
		async reissue({ previousToken, userId, factors, observed }) {
			const issued = createSessionToken();
			const session = await sessions.replaceSession({
				previousTokenHash: sessionTokenHash(previousToken),
				insert: insertFor(userId, factors, observed, issued.tokenHash),
			});
			return { token: issued.token, session };
		},

		// S-FIX-6: a credential change takes every other session with it, and nothing turns that off.
		async reissueAfterCredentialChange({ resolved, factors, observed }) {
			const issued = createSessionToken();
			const session = await sessions.replaceEverySessionOfUser({
				actor: actorOfResolvedSession(resolved),
				insert: insertFor(resolved.userId, factors, observed, issued.tokenHash),
			});
			return { token: issued.token, session };
		},

		resolve: (token) => resolveAndExtend(token, settings.idleWriteIntervalMs),

		// 3.15 B.2: refresh forces exactly this write and nothing else — never the absolute deadline, never a new token.
		refresh: (token) => resolveAndExtend(token, WRITE_NOW),

		async signOut({ token }) {
			await sessions.deleteSessionByTokenHash(sessionTokenHash(token));
		},

		async list({ resolved }) {
			return sessions.listSessionsOwnedBy({
				actor: actorOfFreshSession(resolved),
				currentSessionId: resolved.session.id,
			});
		},

		// S-OWNER-4: a session of another user and one that never existed both change nothing and answer the same.
		async revoke({ resolved, targetSessionId }) {
			await sessions.deleteSessionOwnedBy({
				sessionId: targetSessionId,
				actor: actorOfFreshSession(resolved),
			});
		},

		async revokeEveryOther({ resolved }) {
			return {
				revokedCount: await sessions.deleteEveryOtherSessionOwnedBy({
					actor: actorOfFreshSession(resolved),
					keptSessionId: resolved.session.id,
				}),
			};
		},

		async revokeEvery({ resolved }) {
			return {
				revokedCount: await sessions.deleteEverySessionOwnedBy({
					actor: actorOfFreshSession(resolved),
				}),
			};
		},

		// S-FIX-6: the password reset has no surviving session to resolve, so the caller brings the actor its redeemed token produced.
		async revokeEverySessionOfUser({ actor }) {
			return { revokedCount: await sessions.deleteEverySessionOwnedBy({ actor }) };
		},
	};
}
