import type { PendingToken } from "../factor/pending/token.js";
import type { PendingAuthentication, Session } from "../http/caller.js";
import type { CookieInstruction } from "../http/cookies.js";
import type { SessionToken } from "../session/token.js";
import type { User } from "./user.js";

/** a linked provider identity whose `profile` the library neither reads nor promises a shape for */
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

/** both ways in create a user and a session and differ in the `factors` they record */
export interface SignUpResult {
	readonly user: User;
	readonly sessionToken: SessionToken;
	readonly session: Session;
}

/** the `second_factor_required` branch has no session and no `sessionToken` property at all */
export type SignInResult =
	| {
			readonly status: "signed_in";
			readonly sessionToken: SessionToken;
			readonly session: Session;
			readonly user: User;
			/** set only on the WebAuthn paths, and `undefined` means "not applicable", never "no" */
			readonly signCountRegressed?: boolean;
	  }
	| {
			readonly status: "second_factor_required";
			readonly pendingToken: PendingToken;
			readonly pending: PendingAuthentication;
	  };

/** the one server result that mentions a cookie, the pointer that has to reach the browser */
export interface OAuthRedirect {
	readonly authorizationUrl: string;
	readonly stateCookie: CookieInstruction;
}

/** linking re-issues the session, as a new identity changes the trust level */
export type OAuthCallbackResult =
	| SignInResult
	| {
			readonly status: "identity_linked";
			readonly identity: Identity;
			readonly sessionToken: SessionToken;
			readonly session: Session;
	  };
