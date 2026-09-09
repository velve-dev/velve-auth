/**
 * What `@velve/auth` exports on behalf of the e-mailed flows. `src/index.ts` re-exports this module
 * whole, so the feature that owns them adds a name here and never in the shared barrel. Empty
 * until it does: the flows are declared in `core/auth/config.ts` as `EmailConfig` and
 * `EmailMessage`, which the configuration chapter already exports.
 */
export type {};
