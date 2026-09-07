import type { Migration } from "../migration.js";

export type IdentityMode = "email" | "username" | "username_email";

const IDENTITY_MODE_SQL: Readonly<Record<IdentityMode, string>> = {
	email: `ALTER TABLE velve.user
  ADD CONSTRAINT user_identity_mode CHECK (email IS NOT NULL);
`,
	username: `ALTER TABLE velve.user
  ADD CONSTRAINT user_identity_mode CHECK (username IS NOT NULL);
`,
	username_email: `ALTER TABLE velve.user
  ADD CONSTRAINT user_identity_mode CHECK (email IS NOT NULL AND username IS NOT NULL);
`,
};

export function identityModeMigration(mode: IdentityMode): Migration {
	return { version: 2, name: `identity_${mode}`, sql: IDENTITY_MODE_SQL[mode] };
}
