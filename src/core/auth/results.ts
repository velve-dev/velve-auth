import type { PendingToken } from "../factor/pending/token.js";
import type { PendingAuthentication, Session } from "../http/caller.js";
import type { CookieInstruction } from "../http/cookies.js";
import type { SessionToken } from "../session/token.js";
import type { User } from "./user.js";

/**
 * Architecture 3.15 C. `profile` is `unknown` because the library does not read these claims and
 * may not promise a shape the provider changes tomorrow.
 */
export interface Identity {
	readonly id: string;
	readonly provider: string;
	readonly subject: string;
	readonly createdAt: Date;
	readonly providerEmail: string | null;
	readonly providerEmailVerified: boolean;
	readonly profile: unknown;
	readonly scopes: readonly string[];
	readonly tokenExpiresAt: Date | null;
}

/** 3.15 B.1: both ways in create a user and a session, and they differ in the `factors` they record. */
export interface SignUpResult {
	readonly user: User;
	readonly sessionToken: SessionToken;
	readonly session: Session;
}

/**
 * 3.15 C.1: in the `second_factor_required` branch there is no `Session` and no `sessionToken` —
 * not as `null`, not as an optional field, but as an absent property, so that reading
 * `result.sessionToken` without checking `result.status` does not compile.
 */
export type SignInResult =
	| {
			readonly status: "signed_in";
			readonly sessionToken: SessionToken;
			readonly session: Session;
			readonly user: User;
			/** Only on the WebAuthn paths; `undefined` means "not applicable", never "no" (L-9). */
			readonly signCountRegressed?: boolean;
	  }
	| {
			readonly status: "second_factor_required";
			readonly pendingToken: PendingToken;
			readonly pending: PendingAuthentication;
	  };

/** 3.15 C: the one place a server method mentions a cookie, because the pointer has to reach the browser. */
export interface OAuthRedirect {
	readonly authorizationUrl: string;
	readonly stateCookie: CookieInstruction;
}

/** 3.15 C.1: linking re-issues the session, because a new identity changes the trust level. */
export type OAuthCallbackResult =
	| SignInResult
	| {
			readonly status: "identity_linked";
			readonly identity: Identity;
			readonly sessionToken: SessionToken;
			readonly session: Session;
	  };
