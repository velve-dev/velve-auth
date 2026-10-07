import type { Migration } from "../migration.js";

export const securityStateSchema: Migration = {
	version: 3,
	name: "security_state",
	sql: `/* One seal per account: an HMAC under state-mac over the canonical encoding of every
   sign-in method, the address and its verified state (section 3.18, S-INTEG-2).
   key_version names the state-mac version the digest was taken under (S-KEY-3), and
   session_epoch rises with every mass revocation of the account's sessions (S-INTEG-9). */
CREATE TABLE velve.security_state (
  user_id     uuid PRIMARY KEY REFERENCES velve.user(id) ON DELETE CASCADE,
  version     bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  digest      bytea NOT NULL CHECK (octet_length(digest) = 32),
  key_version integer NOT NULL CHECK (key_version >= 1),
  session_epoch bigint NOT NULL DEFAULT 1 CHECK (session_epoch BETWEEN 1 AND 9007199254740991),
  sealed_at   timestamptz NOT NULL DEFAULT now()
);
`,
};
