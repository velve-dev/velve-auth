import { type Actor, actorOfResolvedSession, type ResolvedSession } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import {
	createSessionRepository,
	type IssueAuthorisation,
	type MissedIssue,
	type RevocationSeal,
	type SealVerification,
	type SecurityStateSealing,
	type SessionInsert,
	type SessionRepository,
	type SessionWithOwner,
} from "../db/repositories/session.js";
import { isRowIdentifier } from "../db/row-identifier.js";
import type { AuthenticationFactor, Session } from "../http/caller.js";
import { VelveError } from "../http/error-map.js";
import type { KeyProvider } from "../keys/provider.js";
import {
	bindToken,
	reboundTokenMacIfStale,
	reportRefusedTokenRow,
	type StoredTokenMac,
	type TokenBindingRefusalReport,
} from "../token/binding.js";
import { librarySessionBinding, sessionBinding } from "./binding.js";
import { type SessionConfig, type SessionSettings, sessionSettingsOf } from "./config.js";
import { assertSessionIsFresh } from "./freshness.js";
import {
	DEFAULT_SESSION_METADATA_MODE,
	type SessionMetadata,
	type SessionMetadataMode,
	sessionMetadataFor,
} from "./metadata.js";
import { lendSessionRows } from "./rows.js";
import { createSessionToken, type SessionToken, sessionTokenHash } from "./token.js";

/** the only proof of a resolved session the library accepts, produced by `resolve` alone */
export type SessionResolution = ResolvedSession & {
	readonly session: Session;
	/** the database clock when it answered, the only clock freshness is decided by */
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

/** the sign-in or change a session issue completes, which decides how one that writes no row is answered */
export type SessionIssuePath =
	| "password_sign_in"
	| "passkey_sign_in"
	| "totp_second_factor"
	| "passkey_second_factor"
	| "recovery_second_factor"
	| "magic_link"
	| "oauth_sign_in"
	| "sign_up"
	| "password_set"
	| "password_change"
	| "password_reset"
	| "oauth_link";

//a missed issue is reported with what it completes and answered as that path's ordinary failure (S-INTEG-5)
const MISSED_ISSUE_BY_PATH: Readonly<Record<SessionIssuePath, MissedIssue>> = {
	password_sign_in: { occasion: "sign_in", reason: "session_issue_missed_on_password_sign_in" },
	passkey_sign_in: { occasion: "sign_in", reason: "session_issue_missed_on_passkey_sign_in" },
	totp_second_factor: {
		occasion: "sign_in",
		reason: "session_issue_missed_on_totp_second_factor",
	},
	passkey_second_factor: {
		occasion: "sign_in",
		reason: "session_issue_missed_on_passkey_second_factor",
	},
	recovery_second_factor: {
		occasion: "sign_in",
		reason: "session_issue_missed_on_recovery_second_factor",
	},
	magic_link: { occasion: "sign_in", reason: "session_issue_missed_on_token_redemption" },
	oauth_sign_in: { occasion: "sign_in", reason: "session_issue_missed_on_oauth_flow" },
	sign_up: { occasion: "change", reason: "session_issue_missed_on_sign_up" },
	password_set: { occasion: "change", reason: "session_issue_missed_on_password_set" },
	password_change: { occasion: "change", reason: "session_issue_missed_on_password_change" },
	password_reset: { occasion: "change", reason: "session_issue_missed_on_token_redemption" },
	oauth_link: { occasion: "change", reason: "session_issue_missed_on_oauth_flow" },
};

export interface SessionServiceOptions {
	readonly driver: Driver;
	readonly keys: KeyProvider;
	readonly sealing: SecurityStateSealing;
	readonly schema?: string;
	readonly reportTokenBindingRefusal?: TokenBindingRefusalReport;
	/** verifies the seal under the account lock after an issue wrote no row, so a legitimate change that won the race raises no alarm */
	readonly sealVerifiesAfterMissedIssue?: SealVerification;
	/** runs a single revocation under the account lock and moves the session generation the other sessions are rebound to */
	readonly revocationSeal?: RevocationSeal;
	/** checks the seal a resolution's one statement read, before the session is used */
	readonly checkSessionState?: (
		userId: string,
		document: string | null,
		attempt: "first" | "second",
	) => Promise<"usable" | "broken" | "read_again">;
	readonly session?: Partial<SessionConfig>;
	readonly sessionMetadata?: SessionMetadataMode;
}

export interface SessionService {
	readonly settings: SessionSettings;
	/** the same service over another driver, for a session written in a caller's own transaction */
	boundTo(driver: Driver): SessionService;
	/** a sign-up unless `completes` names the change it completes */
	issue(input: {
		readonly completes?: SessionIssuePath;
		/** what the check that authorised the issue read of the seal row */
		readonly authorisedBy: IssueAuthorisation;
		readonly userId: string;
		readonly factors: readonly AuthenticationFactor[];
		readonly observed: ObservedRequest;
		/** the row id drawn before the issue, for a change that seals a credential naming the new session */
		readonly sessionId?: string;
	}): Promise<IssuedSession>;
	/** issues a session and removes the one the browser presented, whoever owns it, in one transaction */
	issueReplacingPresented(input: {
		readonly completes: SessionIssuePath;
		/** what the check that authorised the issue read of the seal row */
		readonly authorisedBy: IssueAuthorisation;
		/** the row id drawn before the issue, for a change that seals a credential naming the new session */
		readonly sessionId?: string;
		readonly presentedToken: string | null;
		readonly userId: string;
		readonly factors: readonly AuthenticationFactor[];
		readonly observed: ObservedRequest;
	}): Promise<IssuedSession>;
	/** replaces the one named session and leaves every other session of the account alone */
	reissueSessionOfUser(input: {
		readonly completes: SessionIssuePath;
		/** what the check that authorised the issue read of the seal row */
		readonly authorisedBy: IssueAuthorisation;
		readonly actor: Actor;
		readonly previousSessionId: string;
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
		/** the epoch the mass revocation draws, which the kept session is bound under */
		readonly keptUnderEpoch?: number;
	}): Promise<{ revokedCount: number }>;
	revokeEvery(input: { readonly resolved: SessionResolution }): Promise<{ revokedCount: number }>;
	revokeEverySessionOfUser(input: { readonly actor: Actor }): Promise<{ revokedCount: number }>;
	/** the ids a revocation is about to remove, for telling a hook about exactly those rows */
	listEveryIdOwnedBy(input: { readonly resolved: SessionResolution }): Promise<string[]>;
}

const WRITE_NOW = 0;

interface VerifiedSession {
	readonly found: SessionWithOwner;
	readonly stored: StoredTokenMac;
	readonly rebound: StoredTokenMac | null;
}

//the brand of a resolved session is asserted here and nowhere else (S-OWNER-7)
function resolutionOf(userId: string, session: Session, observedAt: Date): SessionResolution {
	return { userId, session, observedAt } as SessionResolution;
}

export function createSessionService(options: SessionServiceOptions): SessionService {
	const settings = sessionSettingsOf(options.session);
	const metadataMode = options.sessionMetadata ?? DEFAULT_SESSION_METADATA_MODE;
	const sessions = repositoryOn(options.driver);

	function repositoryOn(driver: Driver): SessionRepository {
		return createSessionRepository({
			driver,
			schema: options.schema ?? "velve",
			keys: options.keys,
			sealing: options.sealing,
			...(options.reportTokenBindingRefusal === undefined
				? {}
				: { reportTokenBindingRefusal: options.reportTokenBindingRefusal }),
			...(options.sealVerifiesAfterMissedIssue === undefined
				? {}
				: { sealVerifiesAfterMissedIssue: options.sealVerifiesAfterMissedIssue }),
			...(options.revocationSeal === undefined || driver !== options.driver
				? {}
				: { revocationSeal: options.revocationSeal }),
		});
	}

	function metadataOf(observed: ObservedRequest): SessionMetadata {
		return sessionMetadataFor(metadataMode, observed);
	}

	//the mac must cover the factors exactly as the row will store them (S-INTEG-9)
	function insertFor(
		userId: string,
		factors: readonly AuthenticationFactor[],
		observed: ObservedRequest,
		tokenHash: Uint8Array,
		missed: MissedIssue,
		authorisedBy: IssueAuthorisation,
	): SessionInsert {
		const storedFactors = factors.filter((factor, index) => factors.indexOf(factor) === index);
		return {
			userId,
			missed,
			authorisedBy,
			tokenHash,
			factors: storedFactors,
			...metadataOf(observed),
			idleTimeoutMs: settings.idleTimeoutMs,
			absoluteTimeoutMs: settings.absoluteTimeoutMs,
			bindUnder: (issue) =>
				bindToken(options.keys, sessionBinding(userId, tokenHash, storedFactors, issue)),
		};
	}

	//a row the library did not write is answered as no row before anything in it is read (S-INTEG-9)
	async function verifiedSession(
		token: string,
		attempt: "first" | "second" = "first",
	): Promise<VerifiedSession | null> {
		const tokenHash = sessionTokenHash(token);
		const candidate = await sessions.findSessionByTokenHash(tokenHash);
		if (candidate === null || candidate.sessionEpoch === null) {
			return null;
		}
		//the seal is checked from the same statement before the session row is used (S-INTEG-4)
		const state =
			options.checkSessionState === undefined
				? "usable"
				: await options.checkSessionState(candidate.userId, candidate.securityState, attempt);
		if (state === "read_again") {
			return verifiedSession(token, "second");
		}
		if (state === "broken") {
			return null;
		}
		const binding = await librarySessionBinding(
			options.keys,
			{ ...candidate, tokenHash },
			{ report: options.reportTokenBindingRefusal, occasion: "session_resolve" },
		);
		if (binding === null) {
			return null;
		}
		const found = candidate.decode();
		if (found === null) {
			reportRefusedTokenRow(options.reportTokenBindingRefusal, {
				userId: candidate.userId,
				occasion: "session_resolve",
				verdict: "mismatch",
			});
			return null;
		}
		return {
			found,
			stored: candidate,
			rebound: await reboundTokenMacIfStale(options.keys, binding, candidate),
		};
	}

	//freshness is checked where the actor is minted, on the clock created_at came from (E-233)
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
		const verified = await verifiedSession(token);
		if (verified === null) {
			return null;
		}
		const { found } = verified;
		//a disabled account is named only here, once the caller has proved the account is theirs
		if (found.userDisabledAt !== null) {
			throw new VelveError("account_disabled");
		}
		const resolved = resolutionOf(found.userId, found.session, found.observedAt);
		const { rebound } = verified;
		if (rebound !== null) {
			//a rebinding whose miss is let stand must run at read committed whatever the default (E-3481)
			await options.driver.transaction((tx) =>
				repositoryOn(tx).rebindSessionTokenMac({
					actor: actorOfResolvedSession(resolved),
					sessionId: found.session.id,
					previous: verified.stored,
					next: rebound,
				}),
			);
		}
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

	const service: SessionService = {
		settings,

		//a service bound to a caller's transaction moves no generation inside the caller's seal
		boundTo: (driver) => {
			const { revocationSeal: _sealedOnlyOnItsOwn, ...unsealed } = options;
			return createSessionService({ ...unsealed, driver });
		},

		async issue({ completes = "sign_up", authorisedBy, userId, factors, observed, sessionId }) {
			const issued = createSessionToken();
			const session = await sessions.insertSession({
				...insertFor(
					userId,
					factors,
					observed,
					issued.tokenHash,
					MISSED_ISSUE_BY_PATH[completes],
					authorisedBy,
				),
				...(sessionId === undefined ? {} : { sessionId }),
			});
			return { token: issued.token, session };
		},

		//a sign-in must leave no row for the token the browser presented (S-FIX-3)
		async issueReplacingPresented({
			completes,
			authorisedBy,
			presentedToken,
			userId,
			factors,
			observed,
			sessionId,
		}) {
			const issued = createSessionToken();
			const session = await sessions.replacePresentedSession({
				presentedTokenHash: presentedToken === null ? null : sessionTokenHash(presentedToken),
				insert: {
					...insertFor(
						userId,
						factors,
						observed,
						issued.tokenHash,
						MISSED_ISSUE_BY_PATH[completes],
						authorisedBy,
					),
					...(sessionId === undefined ? {} : { sessionId }),
				},
			});
			return { token: issued.token, session };
		},

		async reissueSessionOfUser({
			completes,
			authorisedBy,
			actor,
			previousSessionId,
			factors,
			observed,
		}) {
			const issued = createSessionToken();
			const session = await sessions.replaceSessionOwnedBy({
				actor,
				previousSessionId,
				insert: insertFor(
					actor,
					factors,
					observed,
					issued.tokenHash,
					MISSED_ISSUE_BY_PATH[completes],
					authorisedBy,
				),
			});
			return { token: issued.token, session };
		},

		resolve: (token) => resolveAndExtend(token, settings.idleWriteIntervalMs),

		//refresh only extends the idle timeout, never the absolute deadline or the token
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

		async listEveryIdOwnedBy({ resolved }) {
			return sessions.listEverySessionIdOwnedBy({ actor: actorOfFreshSession(resolved) });
		},

		//revoking a foreign or missing session changes nothing and answers the same (S-OWNER-4)
		async revoke({ resolved, targetSessionId }) {
			//a spelling no uuid column could hold names no session and answers like one (S-OWNER-8)
			if (!isRowIdentifier(targetSessionId)) {
				return;
			}
			await sessions.deleteSessionOwnedBy({
				sessionId: targetSessionId,
				actor: actorOfFreshSession(resolved),
			});
		},

		async revokeEveryOther({ resolved, keptUnderEpoch }) {
			return {
				revokedCount: await sessions.deleteEveryOtherSessionOwnedBy({
					actor: actorOfFreshSession(resolved),
					keptSessionId: resolved.session.id,
					...(keptUnderEpoch === undefined ? {} : { keptUnderEpoch }),
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

		//a reset has no session to resolve, so the actor comes from its redeemed token (E-234)
		async revokeEverySessionOfUser({ actor }) {
			return { revokedCount: await sessions.deleteEverySessionOwnedBy({ actor }) };
		},
	};
	lendSessionRows(service, repositoryOn);
	return service;
}
