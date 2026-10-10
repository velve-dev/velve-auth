import type { Migration } from "../migration.js";

export const tokenMacSchema: Migration = {
	version: 4,
	name: "token_mac",
	sql: `/* Every token row carries an HMAC under token-mac over purpose, owner, token_sha256 and
   its security-relevant content, with the version it was taken under (section 3.18, S-INTEG-9).
   No existing row has one, so every session, one-time token, pending authentication and
   WebAuthn challenge ends.
   The tables are locked first, as a 1.x instance still running would otherwise insert between
   the deletes and the NOT NULL columns; stop every 1.x instance before migrating. They are
   locked one statement each in the order a sign-in reaches them, the pending authentication
   and the one-time token before the session, so a second-factor completion or a reset in flight
   is waited for. A 1.x sign-up reaches the session before the one-time token, so one still in
   flight can deadlock with the migration, and PostgreSQL then aborts one of the two; the
   migration is one transaction, an abort leaves nothing behind, and it is simply run again. */
LOCK TABLE velve.pending_authentication IN ACCESS EXCLUSIVE MODE;
LOCK TABLE velve.one_time_token IN ACCESS EXCLUSIVE MODE;
LOCK TABLE velve.webauthn_challenge IN ACCESS EXCLUSIVE MODE;
LOCK TABLE velve.session IN ACCESS EXCLUSIVE MODE;
DELETE FROM velve.session;
DELETE FROM velve.one_time_token;
DELETE FROM velve.pending_authentication;
DELETE FROM velve.webauthn_challenge;
ALTER TABLE velve.session
  ADD COLUMN token_mac bytea NOT NULL CHECK (octet_length(token_mac) = 32),
  ADD COLUMN token_mac_key_version integer NOT NULL CHECK (token_mac_key_version >= 1);
ALTER TABLE velve.one_time_token
  ADD COLUMN token_mac bytea NOT NULL CHECK (octet_length(token_mac) = 32),
  ADD COLUMN token_mac_key_version integer NOT NULL CHECK (token_mac_key_version >= 1);
ALTER TABLE velve.pending_authentication
  ADD COLUMN token_mac bytea NOT NULL CHECK (octet_length(token_mac) = 32),
  ADD COLUMN token_mac_key_version integer NOT NULL CHECK (token_mac_key_version >= 1),
  ADD COLUMN session_epoch bigint NOT NULL
    CHECK (session_epoch BETWEEN 1 AND 9007199254740991),
  ADD COLUMN attempt_generation bigint NOT NULL
    CHECK (attempt_generation BETWEEN 1 AND 9007199254740991);
ALTER TABLE velve.webauthn_challenge
  ADD COLUMN token_mac bytea NOT NULL CHECK (octet_length(token_mac) = 32),
  ADD COLUMN token_mac_key_version integer NOT NULL CHECK (token_mac_key_version >= 1);
/* The start reads which token-mac versions are stored, and the maintenance pass which rows are
   under an old one; each index lets both step from version to version instead of reading every
   row. */
CREATE INDEX session_token_mac_key_version_idx ON velve.session (token_mac_key_version);
CREATE INDEX one_time_token_token_mac_key_version_idx
  ON velve.one_time_token (token_mac_key_version);
CREATE INDEX pending_authentication_token_mac_key_version_idx
  ON velve.pending_authentication (token_mac_key_version);
CREATE INDEX webauthn_challenge_token_mac_key_version_idx
  ON velve.webauthn_challenge (token_mac_key_version);
`,
};
