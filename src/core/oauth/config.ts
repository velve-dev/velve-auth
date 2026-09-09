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

export interface ProviderCredentials {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly scopes?: readonly string[];
}

/**
 * `subjectClaim` has no default on purpose: the stable provider id is the only linking key
 * (S-LINK-1), and `"sub"` is convenient and, in the one case where it is wrong, an
 * account-takeover bug.
 */
export interface GenericProviderConfig extends ProviderCredentials {
	readonly authorizationEndpoint: string;
	readonly tokenEndpoint: string;
	readonly userInfoEndpoint?: string;
	readonly issuer?: string;
	readonly jwksUri?: string;
	readonly subjectClaim: string;
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
	/** The third of the three conditions S-LINK-2 puts on an automatic link. */
	readonly trustedProviders: readonly string[];
	/** 3.10 makes `false` the default, so omitting it stores no provider token. */
	readonly storeTokens?: boolean;
}
