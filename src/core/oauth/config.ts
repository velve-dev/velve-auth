import type { ProviderAccount } from "./claims.js";
/** the fourteen built-in providers, every other provider being generic */
export type KnownProvider =
	| "google"
	| "github"
	| "apple"
	| "microsoft"
	| "gitlab"
	| "discord"
	| "facebook"
	| "linkedin"
	| "twitch"
	| "spotify"
	| "slack"
	| "notion"
	| "zoom"
	| "dropbox";

/** the four prompt values the authorization request may carry, and no free-form string */
export type OAuthPrompt = "select_account" | "consent" | "login" | "none";

/** how the provider answers, where Apple requires `form_post` once the email scope is asked for */
export type OAuthResponseMode = "query" | "form_post";

export interface ProviderCredentials {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly scopes?: readonly string[];
	/** absent means `${callbackBaseUrl}/${provider}`, where the callback route answers */
	readonly redirectUri?: string;
	/** for a self-hosted built-in provider whose endpoints live on another host */
	readonly authorizationEndpoint?: string;
	readonly tokenEndpoint?: string;
	readonly userInfoEndpoint?: string;
	readonly issuer?: string;
	readonly jwksUri?: string;
	readonly prompt?: OAuthPrompt;
	readonly responseMode?: OAuthResponseMode;
}

/** a generic provider, whose `subjectClaim` has no default and reaches nested claims by dots */
export interface GenericProviderConfig extends ProviderCredentials {
	readonly authorizationEndpoint: string;
	readonly tokenEndpoint: string;
	readonly subjectClaim: string;
	readonly emailClaim?: string;
	readonly emailVerifiedClaim?: string;
}

export const KNOWN_PROVIDERS: readonly KnownProvider[] = [
	"google",
	"github",
	"apple",
	"microsoft",
	"gitlab",
	"discord",
	"facebook",
	"linkedin",
	"twitch",
	"spotify",
	"slack",
	"notion",
	"zoom",
	"dropbox",
];

/** the OAuth configuration, where a known provider may be given credentials alone */
export interface OAuthConfig {
	readonly providers: Partial<Record<KnownProvider, ProviderCredentials>> & {
		readonly [customId: string]: ProviderCredentials | GenericProviderConfig;
	};
	/** the absolute callback URL the provider id is appended to, never derived from a request */
	readonly callbackBaseUrl: string;
	/** the providers trusted for an automatic link, one of the three conditions it requires */
	readonly trustedProviders: readonly string[];
	/** off by default, so omitting it stores no provider token */
	readonly storeTokens?: boolean;
	/** supplies the identifiers a provider cannot for a new account, never its email address */
	readonly identifiersForNewAccount?: (
		input: NewAccountInput,
	) => Promise<NewAccountIdentifiers> | NewAccountIdentifiers;
}

/** what the application is told about the person it is being asked to name */
export interface NewAccountInput {
	readonly provider: string;
	readonly account: ProviderAccount;
}

export interface NewAccountIdentifiers {
	readonly username?: string;
}
