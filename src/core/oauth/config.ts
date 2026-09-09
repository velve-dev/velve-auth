/** Architecture 3.15 A.8. The fourteen providers 3.10 names at launch; everything else is generic. */
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

/** Section 1, C69. The four values the authorization request may carry, and no free-form string. */
export type OAuthPrompt = "select_account" | "consent" | "login" | "none";

/** Section 1, C70. `form_post` is what Apple requires once the e-mail scope is asked for (E-541). */
export type OAuthResponseMode = "query" | "form_post";

export interface ProviderCredentials {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly scopes?: readonly string[];
	/** C74. Absent means `${callbackBaseUrl}/${provider}`, which is where the callback route answers. */
	readonly redirectUri?: string;
	/** C75, the self-hosted case: a built-in provider whose endpoints live on another host. */
	readonly authorizationEndpoint?: string;
	readonly tokenEndpoint?: string;
	readonly userInfoEndpoint?: string;
	readonly issuer?: string;
	readonly jwksUri?: string;
	readonly prompt?: OAuthPrompt;
	readonly responseMode?: OAuthResponseMode;
}

/**
 * `subjectClaim` has no default on purpose: the stable provider id is the only linking key
 * (S-LINK-1), and `"sub"` is convenient and, in the one case where it is wrong, an
 * account-takeover bug. A dot reaches into a nested claim — `bot.owner.user.id`.
 */
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

/**
 * The index signature admits what the named keys hold, so a known provider can be configured with
 * credentials alone; which shape an id must carry is decided at start (E-718).
 */
export interface OAuthConfig {
	readonly providers: Partial<Record<KnownProvider, ProviderCredentials>> & {
		readonly [customId: string]: ProviderCredentials | GenericProviderConfig;
	};
	/**
	 * The absolute URL the mounted callback route answers on, with the provider id appended to it;
	 * the library never derives it from a request header (S-REDIR-6, E-540).
	 */
	readonly callbackBaseUrl: string;
	/** The third of the three conditions S-LINK-2 puts on an automatic link. */
	readonly trustedProviders: readonly string[];
	/** 3.10 makes `false` the default, so omitting it stores no provider token. */
	readonly storeTokens?: boolean;
}
