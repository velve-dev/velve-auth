import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initialSchema } from "../src/core/db/migrations/initial-schema.js";
import { dropSchema, type MigratedSchema, openMigratedSchema, readColumns } from "./db-fixtures.js";

// Every entry is one column of the schema in architecture 3.2 with the differences
// from 3.17 (L-2, L-3, import_mapping, password_reset_required) already applied.
const SPECIFIED_COLUMNS: readonly string[] = [
	"identity.access_token_enc bytea",
	"identity.created_at timestamp with time zone NOT NULL DEFAULT",
	"identity.id uuid NOT NULL DEFAULT",
	"identity.id_token_enc bytea",
	"identity.profile jsonb",
	"identity.provider text NOT NULL",
	"identity.provider_email text",
	"identity.provider_email_verified boolean NOT NULL DEFAULT",
	"identity.refresh_token_enc bytea",
	"identity.scopes text[]",
	"identity.subject text NOT NULL",
	"identity.token_expires_at timestamp with time zone",
	"identity.token_key_version integer",
	"identity.updated_at timestamp with time zone NOT NULL DEFAULT",
	"identity.user_id uuid NOT NULL",
	"import_mapping.imported_at timestamp with time zone NOT NULL DEFAULT",
	"import_mapping.run_id uuid NOT NULL",
	"import_mapping.source text NOT NULL",
	"import_mapping.source_id text NOT NULL",
	"import_mapping.user_id uuid NOT NULL",
	"oauth_flow.created_at timestamp with time zone NOT NULL DEFAULT",
	"oauth_flow.expires_at timestamp with time zone NOT NULL",
	"oauth_flow.key_version integer NOT NULL",
	"oauth_flow.link_to_user_id uuid",
	"oauth_flow.nonce text",
	"oauth_flow.pkce_verifier_enc bytea NOT NULL",
	"oauth_flow.provider text NOT NULL",
	"oauth_flow.redirect_path text",
	"oauth_flow.state_sha256 bytea NOT NULL",
	"one_time_token.created_at timestamp with time zone NOT NULL DEFAULT",
	"one_time_token.expires_at timestamp with time zone NOT NULL",
	"one_time_token.payload jsonb",
	"one_time_token.purpose text NOT NULL",
	"one_time_token.token_sha256 bytea NOT NULL",
	"one_time_token.user_id uuid",
	"password_credential.created_at timestamp with time zone NOT NULL DEFAULT",
	"password_credential.key_version integer NOT NULL DEFAULT",
	"password_credential.phc bytea NOT NULL",
	"password_credential.scheme text NOT NULL",
	"password_credential.updated_at timestamp with time zone NOT NULL DEFAULT",
	"password_credential.user_id uuid NOT NULL",
	"password_reset_required.created_at timestamp with time zone NOT NULL DEFAULT",
	"password_reset_required.detail text",
	"password_reset_required.reason text NOT NULL",
	"password_reset_required.source text NOT NULL",
	"password_reset_required.user_id uuid NOT NULL",
	"pending_authentication.attempts integer NOT NULL DEFAULT",
	"pending_authentication.created_at timestamp with time zone NOT NULL DEFAULT",
	"pending_authentication.expires_at timestamp with time zone NOT NULL",
	"pending_authentication.factors_completed text[] NOT NULL",
	"pending_authentication.token_sha256 bytea NOT NULL",
	"pending_authentication.user_id uuid NOT NULL",
	"rate_bucket.bucket_key text NOT NULL",
	"rate_bucket.expires_at timestamp with time zone NOT NULL",
	"rate_bucket.tokens real NOT NULL",
	"rate_bucket.updated_at timestamp with time zone NOT NULL",
	"recovery_code.code_hmac bytea NOT NULL",
	"recovery_code.created_at timestamp with time zone NOT NULL DEFAULT",
	"recovery_code.key_version integer NOT NULL DEFAULT",
	"recovery_code.user_id uuid NOT NULL",
	"schema_migration.applied_at timestamp with time zone NOT NULL DEFAULT",
	"schema_migration.checksum text NOT NULL",
	"schema_migration.name text NOT NULL",
	"schema_migration.version integer NOT NULL",
	"session.absolute_expires_at timestamp with time zone NOT NULL",
	"session.created_at timestamp with time zone NOT NULL DEFAULT",
	"session.factors text[] NOT NULL DEFAULT",
	"session.id uuid NOT NULL DEFAULT",
	"session.idle_expires_at timestamp with time zone NOT NULL",
	"session.ip inet",
	"session.last_used_at timestamp with time zone NOT NULL DEFAULT",
	"session.token_sha256 bytea NOT NULL",
	"session.user_agent text",
	"session.user_id uuid NOT NULL",
	"totp_credential.confirmed_at timestamp with time zone",
	"totp_credential.created_at timestamp with time zone NOT NULL DEFAULT",
	"totp_credential.key_version integer NOT NULL",
	"totp_credential.secret_enc bytea NOT NULL",
	"totp_credential.user_id uuid NOT NULL",
	"totp_used_step.expires_at timestamp with time zone NOT NULL",
	"totp_used_step.time_step bigint NOT NULL",
	"totp_used_step.user_id uuid NOT NULL",
	"user.created_at timestamp with time zone NOT NULL DEFAULT",
	"user.disabled_at timestamp with time zone",
	"user.email text",
	"user.email_verified_at timestamp with time zone",
	"user.id uuid NOT NULL DEFAULT",
	"user.imported_at timestamp with time zone",
	"user.imported_from text",
	"user.updated_at timestamp with time zone NOT NULL DEFAULT",
	"user.username text",
	"user.username_key text",
	"webauthn_challenge.challenge_sha256 bytea NOT NULL",
	"webauthn_challenge.created_at timestamp with time zone NOT NULL DEFAULT",
	"webauthn_challenge.expires_at timestamp with time zone NOT NULL",
	"webauthn_challenge.purpose text NOT NULL",
	"webauthn_challenge.user_id uuid",
	"webauthn_credential.aaguid uuid",
	"webauthn_credential.backup_eligible boolean NOT NULL",
	"webauthn_credential.backup_state boolean NOT NULL",
	"webauthn_credential.created_at timestamp with time zone NOT NULL DEFAULT",
	"webauthn_credential.credential_id bytea NOT NULL",
	"webauthn_credential.id uuid NOT NULL DEFAULT",
	"webauthn_credential.label text",
	"webauthn_credential.last_used_at timestamp with time zone",
	"webauthn_credential.public_key bytea NOT NULL",
	"webauthn_credential.sign_count bigint NOT NULL DEFAULT",
	"webauthn_credential.transports text[]",
	"webauthn_credential.user_id uuid NOT NULL",
	"webauthn_credential.user_verified_at_registration boolean NOT NULL",
];

// Every index the same two sections declare, plus the ones PostgreSQL creates for
// a PRIMARY KEY or a UNIQUE constraint.
const SPECIFIED_INDEXES: readonly string[] = [
	"CREATE UNIQUE INDEX identity_pkey ON SCHEMA.identity USING btree (id)",
	"CREATE UNIQUE INDEX identity_provider_subject ON SCHEMA.identity USING btree (provider, subject)",
	"CREATE INDEX identity_user_id_idx ON SCHEMA.identity USING btree (user_id)",
	"CREATE UNIQUE INDEX import_mapping_pkey ON SCHEMA.import_mapping USING btree (source, source_id)",
	"CREATE INDEX import_mapping_run_idx ON SCHEMA.import_mapping USING btree (run_id)",
	"CREATE INDEX import_mapping_user_idx ON SCHEMA.import_mapping USING btree (user_id)",
	"CREATE UNIQUE INDEX oauth_flow_pkey ON SCHEMA.oauth_flow USING btree (state_sha256)",
	"CREATE INDEX oauth_flow_sweep_idx ON SCHEMA.oauth_flow USING btree (expires_at)",
	"CREATE UNIQUE INDEX one_time_token_pkey ON SCHEMA.one_time_token USING btree (token_sha256)",
	"CREATE INDEX one_time_token_sweep_idx ON SCHEMA.one_time_token USING btree (expires_at)",
	"CREATE INDEX one_time_token_user_purpose_idx ON SCHEMA.one_time_token USING btree (user_id, purpose)",
	"CREATE UNIQUE INDEX password_credential_pkey ON SCHEMA.password_credential USING btree (user_id)",
	"CREATE UNIQUE INDEX password_reset_required_pkey ON SCHEMA.password_reset_required USING btree (user_id)",
	"CREATE UNIQUE INDEX pending_authentication_pkey ON SCHEMA.pending_authentication USING btree (token_sha256)",
	"CREATE INDEX pending_authentication_sweep_idx ON SCHEMA.pending_authentication USING btree (expires_at)",
	"CREATE UNIQUE INDEX rate_bucket_pkey ON SCHEMA.rate_bucket USING btree (bucket_key)",
	"CREATE INDEX rate_bucket_sweep_idx ON SCHEMA.rate_bucket USING btree (expires_at)",
	"CREATE UNIQUE INDEX recovery_code_pkey ON SCHEMA.recovery_code USING btree (user_id, code_hmac)",
	"CREATE UNIQUE INDEX schema_migration_pkey ON SCHEMA.schema_migration USING btree (version)",
	"CREATE UNIQUE INDEX session_pkey ON SCHEMA.session USING btree (id)",
	"CREATE INDEX session_sweep_idx ON SCHEMA.session USING btree (absolute_expires_at)",
	"CREATE UNIQUE INDEX session_token_unique ON SCHEMA.session USING btree (token_sha256)",
	"CREATE INDEX session_user_id_idx ON SCHEMA.session USING btree (user_id)",
	"CREATE UNIQUE INDEX totp_credential_pkey ON SCHEMA.totp_credential USING btree (user_id)",
	"CREATE UNIQUE INDEX totp_used_step_pkey ON SCHEMA.totp_used_step USING btree (user_id, time_step)",
	"CREATE INDEX totp_used_step_sweep_idx ON SCHEMA.totp_used_step USING btree (expires_at)",
	'CREATE UNIQUE INDEX user_email_key ON SCHEMA."user" USING btree (email) WHERE (email IS NOT NULL)',
	'CREATE UNIQUE INDEX user_pkey ON SCHEMA."user" USING btree (id)',
	'CREATE UNIQUE INDEX user_username_key_key ON SCHEMA."user" USING btree (username_key) WHERE (username_key IS NOT NULL)',
	"CREATE UNIQUE INDEX webauthn_challenge_pkey ON SCHEMA.webauthn_challenge USING btree (challenge_sha256)",
	"CREATE INDEX webauthn_challenge_sweep_idx ON SCHEMA.webauthn_challenge USING btree (expires_at)",
	"CREATE UNIQUE INDEX webauthn_credential_id_unique ON SCHEMA.webauthn_credential USING btree (credential_id)",
	"CREATE UNIQUE INDEX webauthn_credential_pkey ON SCHEMA.webauthn_credential USING btree (id)",
	"CREATE INDEX webauthn_credential_user_idx ON SCHEMA.webauthn_credential USING btree (user_id)",
];

const SPECIFIED_TABLES = 16;

let migrated: MigratedSchema;

beforeAll(async () => {
	migrated = await openMigratedSchema("velve_conformance");
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("migration 1 against architecture 3.2 and 3.17", () => {
	it("creates every table in its final form rather than altering it afterwards", () => {
		expect(initialSchema.sql).not.toMatch(/\bALTER\s+TABLE\b/i);
		expect(initialSchema.sql).not.toMatch(/\bDROP\s+COLUMN\b/i);
	});

	it("leaves the schema with sixteen tables", async () => {
		const rows = await migrated.connection.query<{ present: number }>(
			`SELECT count(*)::int AS present FROM information_schema.tables
			 WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
			[migrated.schema],
		);

		expect(rows[0]?.present).toBe(SPECIFIED_TABLES);
	});

	it("matches the specification column by column, in type, nullability and default", async () => {
		const columns = await readColumns(migrated.connection, migrated.schema);

		const actual = columns.map(
			(column) =>
				`${column.table}.${column.column} ${column.type}${column.notNull ? " NOT NULL" : ""}${
					column.hasDefault ? " DEFAULT" : ""
				}`,
		);

		expect(actual).toEqual([...SPECIFIED_COLUMNS]);
	});

	it("matches the specification index for index", async () => {
		const rows = await migrated.connection.query<{ definition: string }>(
			"SELECT indexdef AS definition FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname",
			[migrated.schema],
		);

		const actual = rows.map((row) => row.definition.replaceAll(`${migrated.schema}.`, "SCHEMA."));

		expect(actual).toEqual([...SPECIFIED_INDEXES]);
	});

	it("stores the encrypted PHC string as bytea with a key version (L-2, S-REST-5)", async () => {
		const columns = await readColumns(migrated.connection, migrated.schema);
		const credential = columns.filter((column) => column.table === "password_credential");

		expect(credential.find((column) => column.column === "phc")).toMatchObject({
			type: "bytea",
			notNull: true,
		});
		expect(credential.find((column) => column.column === "key_version")).toMatchObject({
			type: "integer",
			notNull: true,
			hasDefault: true,
		});
		expect(credential.find((column) => column.column === "scheme")?.type).toBe("text");
	});

	it("carries the token-pepper version on every recovery code (L-3, S-REST-3)", async () => {
		const columns = await readColumns(migrated.connection, migrated.schema);

		expect(
			columns.find((column) => column.table === "recovery_code" && column.column === "key_version"),
		).toMatchObject({ type: "integer", notNull: true });
	});

	it("keeps every compared secret as a 32-byte-capable bytea column (S-REST-2)", async () => {
		const columns = await readColumns(migrated.connection, migrated.schema);
		const compared: readonly [string, string][] = [
			["session", "token_sha256"],
			["one_time_token", "token_sha256"],
			["pending_authentication", "token_sha256"],
			["webauthn_challenge", "challenge_sha256"],
			["oauth_flow", "state_sha256"],
		];

		for (const [table, column] of compared) {
			expect(columns.find((fact) => fact.table === table && fact.column === column)).toMatchObject({
				type: "bytea",
				notNull: true,
			});
		}
	});

	it("keeps every reversible secret in an encrypted bytea column (S-REST-4)", async () => {
		const columns = await readColumns(migrated.connection, migrated.schema);
		const encrypted: readonly [string, string][] = [
			["totp_credential", "secret_enc"],
			["oauth_flow", "pkce_verifier_enc"],
			["identity", "access_token_enc"],
			["identity", "refresh_token_enc"],
			["identity", "id_token_enc"],
		];

		for (const [table, column] of encrypted) {
			expect(columns.find((fact) => fact.table === table && fact.column === column)?.type).toBe(
				"bytea",
			);
		}
	});
});
