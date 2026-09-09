import { VelveStartupError } from "../auth/startup.js";
import type {
	GenericProviderConfig,
	KnownProvider,
	OAuthConfig,
	OAuthPrompt,
	OAuthResponseMode,
	ProviderCredentials,
} from "./config.js";

/**
 * What the library knows about a provider before an operator configures anything. Endpoints live
 * here and in the configuration, and nowhere else: no discovery document and no response body ever
 * becomes a URL the server calls (S-REDIR-6).
 */
interface ProviderDescriptor {
	readonly authorizationEndpoint: string;
	readonly tokenEndpoint: string;
	readonly userInfoEndpoint?: string;
	readonly userInfoHeaders?: Readonly<Record<string, string>>;
	readonly issuer?: string;
	readonly jwksUri?: string;
	readonly subjectClaim: string;
	readonly emailClaim?: string;
	readonly emailVerifiedClaim?: string;
	readonly defaultScopes: readonly string[];
	readonly responseMode?: OAuthResponseMode;
}

/**
 * A provider without `jwksUri` reads its claims from `userInfoEndpoint`, and a configured one with
 * neither answers `oauth_provider_error` at the callback rather than refusing the start, because
 * 3.15 A.8 makes both optional (E-557). `microsoft` carries no `issuer` because the value is the
 * tenant's and a fixed one would refuse every real token (E-556).
 */
const DESCRIPTORS: Readonly<Record<KnownProvider, ProviderDescriptor>> = {
	google: {
		authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenEndpoint: "https://oauth2.googleapis.com/token",
		userInfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
		issuer: "https://accounts.google.com",
		jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
		subjectClaim: "sub",
		emailClaim: "email",
		emailVerifiedClaim: "email_verified",
		defaultScopes: ["openid", "email", "profile"],
	},
	github: {
		authorizationEndpoint: "https://github.com/login/oauth/authorize",
		tokenEndpoint: "https://github.com/login/oauth/access_token",
		userInfoEndpoint: "https://api.github.com/user",
		userInfoHeaders: { Accept: "application/vnd.github+json" },
		subjectClaim: "id",
		emailClaim: "email",
		defaultScopes: ["read:user", "user:email"],
	},
	apple: {
		authorizationEndpoint: "https://appleid.apple.com/auth/authorize",
		tokenEndpoint: "https://appleid.apple.com/auth/token",
		issuer: "https://appleid.apple.com",
		jwksUri: "https://appleid.apple.com/auth/keys",
		subjectClaim: "sub",
		emailClaim: "email",
		emailVerifiedClaim: "email_verified",
		defaultScopes: ["name", "email"],
		responseMode: "form_post",
	},
	microsoft: {
		authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
		tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
		userInfoEndpoint: "https://graph.microsoft.com/oidc/userinfo",
		jwksUri: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
		subjectClaim: "sub",
		emailClaim: "email",
		defaultScopes: ["openid", "email", "profile"],
	},
	gitlab: {
		authorizationEndpoint: "https://gitlab.com/oauth/authorize",
		tokenEndpoint: "https://gitlab.com/oauth/token",
		userInfoEndpoint: "https://gitlab.com/oauth/userinfo",
		issuer: "https://gitlab.com",
		jwksUri: "https://gitlab.com/oauth/discovery/keys",
		subjectClaim: "sub",
		emailClaim: "email",
		emailVerifiedClaim: "email_verified",
		defaultScopes: ["openid", "email"],
	},
	discord: {
		authorizationEndpoint: "https://discord.com/oauth2/authorize",
		tokenEndpoint: "https://discord.com/api/oauth2/token",
		userInfoEndpoint: "https://discord.com/api/users/@me",
		subjectClaim: "id",
		emailClaim: "email",
		emailVerifiedClaim: "verified",
		defaultScopes: ["identify", "email"],
	},
	facebook: {
		authorizationEndpoint: "https://www.facebook.com/v21.0/dialog/oauth",
		tokenEndpoint: "https://graph.facebook.com/v21.0/oauth/access_token",
		userInfoEndpoint: "https://graph.facebook.com/v21.0/me?fields=id,name,email",
		subjectClaim: "id",
		emailClaim: "email",
		defaultScopes: ["email", "public_profile"],
	},
	linkedin: {
		authorizationEndpoint: "https://www.linkedin.com/oauth/v2/authorization",
		tokenEndpoint: "https://www.linkedin.com/oauth/v2/accessToken",
		userInfoEndpoint: "https://api.linkedin.com/v2/userinfo",
		issuer: "https://www.linkedin.com",
		jwksUri: "https://www.linkedin.com/oauth/openid/jwks",
		subjectClaim: "sub",
		emailClaim: "email",
		emailVerifiedClaim: "email_verified",
		defaultScopes: ["openid", "profile", "email"],
	},
	twitch: {
		authorizationEndpoint: "https://id.twitch.tv/oauth2/authorize",
		tokenEndpoint: "https://id.twitch.tv/oauth2/token",
		userInfoEndpoint: "https://id.twitch.tv/oauth2/userinfo",
		issuer: "https://id.twitch.tv/oauth2",
		jwksUri: "https://id.twitch.tv/oauth2/keys",
		subjectClaim: "sub",
		emailClaim: "email",
		emailVerifiedClaim: "email_verified",
		defaultScopes: ["openid", "user:read:email"],
	},
	spotify: {
		authorizationEndpoint: "https://accounts.spotify.com/authorize",
		tokenEndpoint: "https://accounts.spotify.com/api/token",
		userInfoEndpoint: "https://api.spotify.com/v1/me",
		subjectClaim: "id",
		emailClaim: "email",
		defaultScopes: ["user-read-email", "user-read-private"],
	},
	slack: {
		authorizationEndpoint: "https://slack.com/openid/connect/authorize",
		tokenEndpoint: "https://slack.com/api/openid.connect.token",
		userInfoEndpoint: "https://slack.com/api/openid.connect.userInfo",
		issuer: "https://slack.com",
		jwksUri: "https://slack.com/openid/connect/keys",
		subjectClaim: "sub",
		emailClaim: "email",
		emailVerifiedClaim: "email_verified",
		defaultScopes: ["openid", "email", "profile"],
	},
	notion: {
		authorizationEndpoint: "https://api.notion.com/v1/oauth/authorize",
		tokenEndpoint: "https://api.notion.com/v1/oauth/token",
		userInfoEndpoint: "https://api.notion.com/v1/users/me",
		userInfoHeaders: { "Notion-Version": "2022-06-28" },
		subjectClaim: "bot.owner.user.id",
		emailClaim: "bot.owner.user.person.email",
		defaultScopes: [],
	},
	zoom: {
		authorizationEndpoint: "https://zoom.us/oauth/authorize",
		tokenEndpoint: "https://zoom.us/oauth/token",
		userInfoEndpoint: "https://api.zoom.us/v2/users/me",
		subjectClaim: "id",
		emailClaim: "email",
		emailVerifiedClaim: "verified",
		defaultScopes: ["user:read"],
	},
	dropbox: {
		authorizationEndpoint: "https://www.dropbox.com/oauth2/authorize",
		tokenEndpoint: "https://api.dropboxapi.com/oauth2/token",
		issuer: "https://www.dropbox.com",
		jwksUri: "https://www.dropbox.com/.well-known/openid-configuration/jwks",
		subjectClaim: "sub",
		emailClaim: "email",
		emailVerifiedClaim: "email_verified",
		defaultScopes: ["openid", "email", "profile"],
	},
};

export interface ResolvedProvider {
	readonly id: string;
	readonly clientId: string;
	readonly clientSecret: string;
	readonly authorizationEndpoint: string;
	readonly tokenEndpoint: string;
	readonly userInfoEndpoint: string | null;
	readonly userInfoHeaders: Readonly<Record<string, string>>;
	readonly issuer: string | null;
	readonly jwksUri: string | null;
	readonly subjectClaim: string;
	readonly emailClaim: string | null;
	readonly emailVerifiedClaim: string | null;
	readonly scopes: readonly string[];
	readonly redirectUri: string;
	readonly prompt: OAuthPrompt | null;
	readonly responseMode: OAuthResponseMode;
	/** The third condition of S-LINK-2, read once at start so no handler re-reads the list. */
	readonly trustedForAutomaticLinking: boolean;
}

export type ProviderTable = ReadonlyMap<string, ResolvedProvider>;

function isKnownProvider(id: string): id is KnownProvider {
	return Object.hasOwn(DESCRIPTORS, id);
}

/** S-REDIR-6: an endpoint the server calls itself is an absolute `https` URL or the start fails. */
function assertCallableEndpoint(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new VelveStartupError("oauth_provider_incomplete");
	}
	if (parsed.protocol !== "https:") {
		throw new VelveStartupError("oauth_provider_incomplete");
	}
	return url;
}

function descriptorOf(id: string, configured: ProviderCredentials): ProviderDescriptor {
	if (isKnownProvider(id)) {
		return DESCRIPTORS[id];
	}
	const generic = configured as GenericProviderConfig;
	return {
		authorizationEndpoint: generic.authorizationEndpoint,
		tokenEndpoint: generic.tokenEndpoint,
		subjectClaim: generic.subjectClaim,
		defaultScopes: [],
		...(generic.emailClaim === undefined ? {} : { emailClaim: generic.emailClaim }),
		...(generic.emailVerifiedClaim === undefined
			? {}
			: { emailVerifiedClaim: generic.emailVerifiedClaim }),
	};
}

function callbackUrlFor(callbackBaseUrl: string, id: string): string {
	return `${callbackBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(id)}`;
}

function resolveProvider(
	id: string,
	configured: ProviderCredentials,
	oauth: OAuthConfig,
): ResolvedProvider {
	const descriptor = descriptorOf(id, configured);
	const userInfoEndpoint = configured.userInfoEndpoint ?? descriptor.userInfoEndpoint ?? null;
	const jwksUri = configured.jwksUri ?? descriptor.jwksUri ?? null;

	return {
		id,
		clientId: configured.clientId,
		clientSecret: configured.clientSecret,
		authorizationEndpoint: assertCallableEndpoint(
			configured.authorizationEndpoint ?? descriptor.authorizationEndpoint,
		),
		tokenEndpoint: assertCallableEndpoint(configured.tokenEndpoint ?? descriptor.tokenEndpoint),
		userInfoEndpoint: userInfoEndpoint === null ? null : assertCallableEndpoint(userInfoEndpoint),
		userInfoHeaders: descriptor.userInfoHeaders ?? {},
		issuer: configured.issuer ?? descriptor.issuer ?? null,
		jwksUri: jwksUri === null ? null : assertCallableEndpoint(jwksUri),
		subjectClaim: descriptor.subjectClaim,
		emailClaim: descriptor.emailClaim ?? null,
		emailVerifiedClaim: descriptor.emailVerifiedClaim ?? null,
		scopes: configured.scopes ?? descriptor.defaultScopes,
		redirectUri: assertCallableEndpoint(
			configured.redirectUri ?? callbackUrlFor(oauth.callbackBaseUrl, id),
		),
		prompt: configured.prompt ?? null,
		responseMode: configured.responseMode ?? descriptor.responseMode ?? "query",
		trustedForAutomaticLinking: oauth.trustedProviders.includes(id),
	};
}

/** Every configured provider, resolved once while the instance is built (E-543). */
export function resolveProviderTable(oauth: OAuthConfig | undefined): ProviderTable {
	const table = new Map<string, ResolvedProvider>();
	for (const [id, configured] of Object.entries(oauth?.providers ?? {})) {
		table.set(id, resolveProvider(id, configured, oauth as OAuthConfig));
	}
	return table;
}
