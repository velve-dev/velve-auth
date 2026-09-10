import type { pendingRoutes, sessionRoutes, usernameRoutes } from "../core/auth/routes.js";
import type { FactorRouteTable } from "../core/factor/routes.js";
import type { EmailFlowRouteTable } from "../core/flows/routes.js";
import type { AnyRoute, HttpMethod } from "../core/http/route.js";
import type { oauthRoutes } from "../core/oauth/routes.js";
import type { passwordRoutes } from "../core/password/routes.js";

/**
 * Every row the library declares, in the order `assembleVelveAuth` puts them in. A mode or a
 * configuration that leaves one out narrows the table it serves and never this one, which 3.15 E's
 * client states as a promise about the library rather than about an instance (E-673).
 */
export type VelveRouteTable = readonly [
	...ReturnType<typeof sessionRoutes>,
	...ReturnType<typeof usernameRoutes>,
	...ReturnType<typeof pendingRoutes>,
	...ReturnType<typeof oauthRoutes>,
	...EmailFlowRouteTable,
	...ReturnType<typeof passwordRoutes>,
	...FactorRouteTable,
];

/** What a call needs from its own row and nothing else, so no handler is reachable from it (3.15 E). */
export interface ClientRoute {
	readonly name: string;
	readonly method: HttpMethod;
	readonly path: string;
}

type ClientRouteOf<Declared> = Declared extends {
	readonly name: infer Name;
	readonly path: infer Path;
}
	? { readonly name: Name; readonly method: HttpMethod; readonly path: Path }
	: never;

type ClientRoutesOf<Routes extends readonly AnyRoute[]> = {
	readonly [Index in keyof Routes]: ClientRouteOf<Routes[Index]>;
};

/**
 * The route table as a value, carrying no import of the module that declares the row it mirrors:
 * `satisfies` is what holds the two in step, so a row added, renamed, repathed or dropped fails
 * here at compile time rather than at the first call (E-672).
 */
export const VELVE_CLIENT_ROUTES = [
	{ name: "signOut", method: "POST", path: "/sign-out" },
	{ name: "session.read", method: "GET", path: "/session" },
	{ name: "session.list", method: "GET", path: "/session/list" },
	{ name: "session.revoke", method: "POST", path: "/session/revoke" },
	{ name: "session.revokeAllOther", method: "POST", path: "/session/revoke-others" },
	{ name: "session.revokeAll", method: "POST", path: "/session/revoke-all" },
	{ name: "session.refresh", method: "POST", path: "/session/refresh" },
	{ name: "username.isAvailable", method: "GET", path: "/username/available" },
	{ name: "username.change", method: "POST", path: "/username/change" },
	{ name: "pending.read", method: "GET", path: "/pending" },
	{ name: "pending.cancel", method: "POST", path: "/pending/cancel" },
	{ name: "signIn.oauth.start", method: "POST", path: "/sign-in/oauth/start" },
	{ name: "signIn.oauth.callback", method: "GET", path: "/sign-in/oauth/callback/:provider" },
	{
		name: "signIn.oauth.callbackFormPost",
		method: "POST",
		path: "/sign-in/oauth/callback/:provider",
	},
	{ name: "identity.list", method: "GET", path: "/identity/list" },
	{ name: "identity.link.start", method: "POST", path: "/identity/link/start" },
	{ name: "identity.unlink", method: "POST", path: "/identity/unlink" },
	{ name: "signUp.withPassword", method: "POST", path: "/sign-up" },
	{ name: "signUp.withoutPassword", method: "POST", path: "/sign-up/passwordless" },
	{
		name: "password.redeemResetWithRecoveryCode",
		method: "POST",
		path: "/password/redeem-reset-with-recovery-code",
	},
	{ name: "signIn.magicLink.request", method: "POST", path: "/sign-in/magic-link/request" },
	{ name: "signIn.magicLink.redeem", method: "POST", path: "/sign-in/magic-link/redeem" },
	{ name: "email.requestVerification", method: "POST", path: "/email/request-verification" },
	{ name: "email.redeemVerification", method: "POST", path: "/email/redeem-verification" },
	{ name: "email.requestChange", method: "POST", path: "/email/request-change" },
	{ name: "email.redeemChange", method: "POST", path: "/email/redeem-change" },
	{ name: "password.requestReset", method: "POST", path: "/password/request-reset" },
	{ name: "password.redeemReset", method: "POST", path: "/password/redeem-reset" },
	{ name: "signIn.password", method: "POST", path: "/sign-in/password" },
	{ name: "password.set", method: "POST", path: "/password/set" },
	{ name: "password.change", method: "POST", path: "/password/change" },
	{ name: "factor.totp.enroll.start", method: "POST", path: "/factor/totp/enroll/start" },
	{ name: "factor.totp.enroll.finish", method: "POST", path: "/factor/totp/enroll/finish" },
	{ name: "factor.totp.verify", method: "POST", path: "/factor/totp/verify" },
	{ name: "factor.totp.remove", method: "POST", path: "/factor/totp/remove" },
	{ name: "factor.recovery.generate", method: "POST", path: "/factor/recovery/generate" },
	{ name: "factor.recovery.verify", method: "POST", path: "/factor/recovery/verify" },
	{ name: "factor.recovery.remaining", method: "GET", path: "/factor/recovery/remaining" },
	{
		name: "factor.webauthn.register.start",
		method: "POST",
		path: "/factor/webauthn/register/start",
	},
	{
		name: "factor.webauthn.register.finish",
		method: "POST",
		path: "/factor/webauthn/register/finish",
	},
	{
		name: "factor.webauthn.authenticate.start",
		method: "POST",
		path: "/factor/webauthn/authenticate/start",
	},
	{
		name: "factor.webauthn.authenticate.finish",
		method: "POST",
		path: "/factor/webauthn/authenticate/finish",
	},
	{ name: "factor.webauthn.list", method: "GET", path: "/factor/webauthn/list" },
	{ name: "factor.webauthn.rename", method: "POST", path: "/factor/webauthn/rename" },
	{ name: "factor.webauthn.remove", method: "POST", path: "/factor/webauthn/remove" },
	{ name: "signIn.passkey.start", method: "POST", path: "/sign-in/passkey/start" },
	{ name: "signIn.passkey.finish", method: "POST", path: "/sign-in/passkey/finish" },
] as const satisfies ClientRoutesOf<VelveRouteTable>;
