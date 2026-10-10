import type { Migration } from "../migration.js";

export const securityStateSchema: Migration = {
	version: 3,
	name: "security_state",
	sql: `/* One seal per account: an HMAC under state-mac over the canonical encoding of every
   sign-in method, the address and its verified state (section 3.18, S-INTEG-2).
   key_version names the state-mac version the digest was taken under (S-KEY-3), and
   session_epoch rises with every mass revocation of the account's sessions (S-INTEG-9).
   components_version is the version of the last seal that changed a component or the epoch,
   which a session issue is conditional on. session_generation moves with every session revoked
   on its own, attempt_generation with
   every booked second-factor attempt and each <purpose>_generation with every redeemed
   one-time token of that purpose; attempt_last and token_last name the token hash of the row
   that moved them last. Each is
   drawn rather than counted and is sealed with the rest, so a row written back with its old
   MAC binds a generation the account has left (section 3.18 point 3). */
CREATE TABLE velve.security_state (
  user_id     uuid PRIMARY KEY REFERENCES velve.user(id) ON DELETE CASCADE,
  version     bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  digest      bytea NOT NULL CHECK (octet_length(digest) = 32),
  key_version integer NOT NULL CHECK (key_version >= 1),
  session_epoch bigint NOT NULL DEFAULT 1 CHECK (session_epoch BETWEEN 1 AND 9007199254740991),
  components_version bigint NOT NULL DEFAULT 1
    CHECK (components_version BETWEEN 1 AND 9007199254740991),
  session_generation bigint NOT NULL DEFAULT 1
    CHECK (session_generation BETWEEN 1 AND 9007199254740991),
  attempt_generation bigint NOT NULL DEFAULT 1
    CHECK (attempt_generation BETWEEN 1 AND 9007199254740991),
  attempt_last bytea CHECK (octet_length(attempt_last) = 32),
  email_verify_generation bigint NOT NULL DEFAULT 1
    CHECK (email_verify_generation BETWEEN 1 AND 9007199254740991),
  password_reset_generation bigint NOT NULL DEFAULT 1
    CHECK (password_reset_generation BETWEEN 1 AND 9007199254740991),
  email_change_generation bigint NOT NULL DEFAULT 1
    CHECK (email_change_generation BETWEEN 1 AND 9007199254740991),
  magic_link_generation bigint NOT NULL DEFAULT 1
    CHECK (magic_link_generation BETWEEN 1 AND 9007199254740991),
  token_last bytea CHECK (octet_length(token_last) = 32),
  sealed_at   timestamptz NOT NULL DEFAULT now()
);
`,
};
