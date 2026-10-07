import type { Migration } from "../migration.js";

export const tokenMacSchema: Migration = {
	version: 4,
	name: "token_mac",
	sql: `/* Every token row carries an HMAC under token-mac over purpose, owner, token_sha256 and
   its security-relevant content, with the version it was taken under (section 3.18, S-INTEG-9).
   No existing row has one, so every session, one-time token and pending authentication ends. */
DELETE FROM velve.session;
DELETE FROM velve.one_time_token;
DELETE FROM velve.pending_authentication;
ALTER TABLE velve.session
  ADD COLUMN token_mac bytea NOT NULL CHECK (octet_length(token_mac) = 32),
  ADD COLUMN token_mac_key_version integer NOT NULL CHECK (token_mac_key_version >= 1);
ALTER TABLE velve.one_time_token
  ADD COLUMN token_mac bytea NOT NULL CHECK (octet_length(token_mac) = 32),
  ADD COLUMN token_mac_key_version integer NOT NULL CHECK (token_mac_key_version >= 1);
ALTER TABLE velve.pending_authentication
  ADD COLUMN token_mac bytea NOT NULL CHECK (octet_length(token_mac) = 32),
  ADD COLUMN token_mac_key_version integer NOT NULL CHECK (token_mac_key_version >= 1);
`,
};
