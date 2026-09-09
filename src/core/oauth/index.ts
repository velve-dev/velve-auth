/**
 * What `@velve/auth` exports on behalf of third-party sign-in. `src/index.ts` re-exports this
 * module whole, so the feature that owns OAuth adds a name here and never in the barrel that three
 * features would otherwise share.
 */
export type {
	GenericProviderConfig,
	KnownProvider,
	OAuthConfig,
	OAuthPrompt,
	OAuthResponseMode,
	ProviderCredentials,
} from "./config.js";
export type { OAuthCallbackOutcome } from "./service.js";
