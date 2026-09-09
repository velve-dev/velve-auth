import type { Migration } from "../migration.js";

export const initialSchema: Migration = {
	version: 1,
	name: "initial_schema",
	sql: `CREATE SCHEMA IF NOT EXISTS velve;

/* The runner creates this table before it can read its own ledger, so migration 1
   must tolerate finding it already there. */
CREATE TABLE IF NOT EXISTS velve.schema_migration (
  version     integer PRIMARY KEY,
  name        text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  checksum    text NOT NULL
);

CREATE TABLE velve.user (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text,
  email_verified_at timestamptz,
  username          text,
  username_key      text,
  disabled_at       timestamptz,
  imported_from     text,
  imported_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_email_normalized    CHECK (email IS NULL OR email = lower(email)),
  CONSTRAINT user_username_normalized CHECK (username_key IS NULL OR username_key = lower(username_key)),
  CONSTRAINT user_username_pairing    CHECK ((username IS NULL) = (username_key IS NULL))
);
CREATE UNIQUE INDEX user_email_key        ON velve.user (email)        WHERE email IS NOT NULL;
CREATE UNIQUE INDEX user_username_key_key ON velve.user (username_key) WHERE username_key IS NOT NULL;

/* phc holds AES-256-GCM ciphertext over the canonical PHC string, purpose
   password-enc; scheme stays cleartext so the estate can be surveyed without a key (L-2). */
/* set_by_session_id answers L-12's question — was this password stored by the session that is
   confirming the address — and carries no foreign key on purpose: a cascade would delete the
   credential when the session is revoked, and a nulling one would erase the answer at the moment
   S-LINK-4 asks for it. NULL means unknown and counts as a different session (E-595). */
CREATE TABLE velve.password_credential (
  user_id            uuid PRIMARY KEY REFERENCES velve.user(id) ON DELETE CASCADE,
  phc                bytea NOT NULL,
  key_version        integer NOT NULL DEFAULT 1,
  scheme             text NOT NULL,
  set_by_session_id  uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE velve.identity (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  provider           text NOT NULL,
  subject            text NOT NULL,
  provider_email     text,
  provider_email_verified boolean NOT NULL DEFAULT false,
  profile            jsonb,
  access_token_enc   bytea,
  refresh_token_enc  bytea,
  id_token_enc       bytea,
  token_key_version  integer,
  scopes             text[],
  token_expires_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_provider_subject UNIQUE (provider, subject)
);
CREATE INDEX identity_user_id_idx ON velve.identity (user_id);

CREATE TABLE velve.session (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  token_sha256        bytea NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  factors             text[] NOT NULL DEFAULT '{}',
  ip                  inet,
  user_agent          text,
  CONSTRAINT session_token_unique UNIQUE (token_sha256)
);
CREATE INDEX session_user_id_idx ON velve.session (user_id);
CREATE INDEX session_sweep_idx   ON velve.session (absolute_expires_at);

/* E-23: a session changes owner only by being replaced, so the owner column is immutable. */
CREATE FUNCTION velve.reject_session_owner_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'session.user_id is immutable: re-issue a session as INSERT plus DELETE in one transaction'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER session_user_id_immutable
BEFORE UPDATE OF user_id ON velve.session
FOR EACH ROW EXECUTE FUNCTION velve.reject_session_owner_update();

CREATE TABLE velve.one_time_token (
  token_sha256 bytea PRIMARY KEY,
  purpose      text NOT NULL,
  user_id      uuid REFERENCES velve.user(id) ON DELETE CASCADE,
  payload      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX one_time_token_user_purpose_idx ON velve.one_time_token (user_id, purpose);
CREATE INDEX one_time_token_sweep_idx        ON velve.one_time_token (expires_at);

CREATE TABLE velve.pending_authentication (
  token_sha256      bytea PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  factors_completed text[] NOT NULL,
  attempts          integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL
);
CREATE INDEX pending_authentication_sweep_idx ON velve.pending_authentication (expires_at);

CREATE TABLE velve.totp_credential (
  user_id      uuid PRIMARY KEY REFERENCES velve.user(id) ON DELETE CASCADE,
  secret_enc   bytea NOT NULL,
  key_version  integer NOT NULL,
  confirmed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE velve.totp_used_step (
  user_id    uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  time_step  bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, time_step)
);
CREATE INDEX totp_used_step_sweep_idx ON velve.totp_used_step (expires_at);

/* key_version carries the token-pepper version the HMAC was taken under, so a
   rotation does not invalidate every recovery code (L-3). */
CREATE TABLE velve.recovery_code (
  user_id     uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  code_hmac   bytea NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code_hmac)
);

CREATE TABLE velve.webauthn_credential (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
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
  last_used_at     timestamptz,
  CONSTRAINT webauthn_credential_id_unique UNIQUE (credential_id)
);
CREATE INDEX webauthn_credential_user_idx ON velve.webauthn_credential (user_id);

CREATE TABLE velve.webauthn_challenge (
  challenge_sha256 bytea PRIMARY KEY,
  purpose          text NOT NULL,
  user_id          uuid REFERENCES velve.user(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
CREATE INDEX webauthn_challenge_sweep_idx ON velve.webauthn_challenge (expires_at);

CREATE TABLE velve.oauth_flow (
  state_sha256         bytea PRIMARY KEY,
  provider             text NOT NULL,
  pkce_verifier_enc    bytea NOT NULL,
  key_version          integer NOT NULL,
  nonce                text,
  redirect_path        text,
  link_to_user_id      uuid REFERENCES velve.user(id) ON DELETE CASCADE,
  link_from_session_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL
);
CREATE INDEX oauth_flow_sweep_idx ON velve.oauth_flow (expires_at);

CREATE TABLE velve.rate_bucket (
  bucket_key text PRIMARY KEY,
  tokens     real NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX rate_bucket_sweep_idx ON velve.rate_bucket (expires_at);

CREATE TABLE velve.import_mapping (
  source      text NOT NULL,
  source_id   text NOT NULL,
  user_id     uuid NOT NULL REFERENCES velve.user(id) ON DELETE CASCADE,
  run_id      uuid NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);
CREATE INDEX import_mapping_user_idx ON velve.import_mapping (user_id);
CREATE INDEX import_mapping_run_idx  ON velve.import_mapping (run_id);

CREATE TABLE velve.password_reset_required (
  user_id    uuid PRIMARY KEY REFERENCES velve.user(id) ON DELETE CASCADE,
  reason     text NOT NULL,
  source     text NOT NULL,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
`,
};
