/**
 * What `@velve/auth` exports on behalf of the e-mailed flows. `src/index.ts` re-exports this module
 * whole, so the feature that owns them adds a name here and never in the shared barrel. The
 * configuration side — `EmailConfig` and the six `EmailMessage` kinds — is exported by the
 * configuration chapter and is not repeated here.
 */
export type {
	ChangedUser,
	EmailNamespace,
	MagicLinkNamespace,
	MailedPasswordNamespace,
	RecoveryPasswordNamespace,
	SetPasswordResult,
	SignUpNamespace,
} from "./results.js";
export type { EmailFlowSurface } from "./routes.js";
