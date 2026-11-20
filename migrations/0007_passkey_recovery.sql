/* An account that lost its passkey can be recovered to a new one through its address, a
   mailed link and one recovery code (section 3.18, S-INTEG-12). The new passkey waits in
   velve.passkey_recovery until activates_at and is in velve.webauthn_credential only once the
   recovery is activated, so no sign-in path can reach it before then. The seal covers the row
   and the new generation of the purpose passkey_recovery (S-INTEG-2), so a writer without the
   root key can neither shorten the wait, plant a recovery nor bring a cancelled one back. A new
   table and a column with a default rewrite no row, and an account without a recovery keeps the
   seal it had, so nobody is signed out and no pending state ends. */
ALTER TABLE velve.security_state
  ADD COLUMN passkey_recovery_generation bigint NOT NULL DEFAULT 1
    CHECK (passkey_recovery_generation BETWEEN 1 AND 9007199254740991);

CREATE TABLE velve.passkey_recovery (
  user_id          uuid PRIMARY KEY REFERENCES velve.user(id) ON DELETE CASCADE,
  credential_id    bytea NOT NULL,
  public_key       bytea NOT NULL,
  sign_count       bigint NOT NULL DEFAULT 0,
  transports       text[],
  aaguid           uuid,
  backup_eligible  boolean NOT NULL,
  backup_state     boolean NOT NULL,
  user_verified_at_registration boolean NOT NULL,
  label            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  activates_at     timestamptz NOT NULL,
  CONSTRAINT passkey_recovery_credential_id_unique UNIQUE (credential_id)
);
