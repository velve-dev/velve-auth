import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import {
	openTestConnection,
	PostgresServerError,
	type TestConnection,
} from "./db-postgres-connection.js";

const schema = `velve_schema_${randomBytes(6).toString("hex")}`;
let connection: TestConnection;

beforeAll(async () => {
	connection = await openTestConnection();
	await runMigrations({ driver: connection, schema, migrations: coreMigrations("email") });
});

afterAll(async () => {
	await connection.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
	await connection.close();
});

async function createUser(email: string): Promise<string> {
	const [row] = await connection.query<{ id: string }>(
		`INSERT INTO ${schema}.user (email) VALUES ($1) RETURNING id`,
		[email],
	);
	if (row === undefined) {
		throw new Error("the user was not created");
	}
	return row.id;
}

async function createSession(userId: string): Promise<string> {
	const [row] = await connection.query<{ id: string }>(
		`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at)
		 VALUES ($1, $2, now() + interval '1 day', now() + interval '30 days') RETURNING id`,
		[userId, randomBytes(32)],
	);
	if (row === undefined) {
		throw new Error("the session was not created");
	}
	return row.id;
}

async function userOwnedTableNames(): Promise<string[]> {
	const rows = await connection.query<{ table_name: string }>(
		`SELECT DISTINCT child.relname AS table_name
		 FROM pg_constraint constraint_
		 JOIN pg_class child ON child.oid = constraint_.conrelid
		 JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
		 WHERE namespace_.nspname = $1
		   AND constraint_.contype = 'f'
		   AND constraint_.confrelid = to_regclass($2)::oid
		 ORDER BY child.relname`,
		[schema, `${schema}.user`],
	);
	return rows.map((row) => row.table_name);
}

describe("the shipped schema", () => {
	it("creates the sixteen tables of architecture 3.17", async () => {
		const rows = await connection.query<{ table_name: string }>(
			"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
			[schema],
		);

		expect(rows.map((row) => row.table_name)).toEqual([
			"identity",
			"import_mapping",
			"oauth_flow",
			"one_time_token",
			"password_credential",
			"password_reset_required",
			"pending_authentication",
			"rate_bucket",
			"recovery_code",
			"schema_migration",
			"session",
			"totp_credential",
			"totp_used_step",
			"user",
			"webauthn_challenge",
			"webauthn_credential",
		]);
	});

	it("stores the password hash as encrypted bytes with a key version", async () => {
		const rows = await connection.query<{ column_name: string; data_type: string }>(
			`SELECT column_name, data_type FROM information_schema.columns
			 WHERE table_schema = $1 AND table_name = 'password_credential'
			   AND column_name IN ('phc', 'key_version', 'scheme') ORDER BY column_name`,
			[schema],
		);

		expect(rows).toEqual([
			{ column_name: "key_version", data_type: "integer" },
			{ column_name: "phc", data_type: "bytea" },
			{ column_name: "scheme", data_type: "text" },
		]);
	});

	it("carries a key version on every recovery code", async () => {
		const rows = await connection.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_schema = $1 AND table_name = 'recovery_code' AND column_name = 'key_version'`,
			[schema],
		);

		expect(rows).toHaveLength(1);
	});

	it("gives no user-owned table a counted-up primary key (S-OWNER-9)", async () => {
		const owned = await userOwnedTableNames();
		const rows = await connection.query<{ table_name: string; column_name: string }>(
			`SELECT child.relname AS table_name, column_.attname AS column_name
			 FROM pg_constraint constraint_
			 JOIN pg_class child ON child.oid = constraint_.conrelid
			 JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
			 JOIN pg_attribute column_ ON column_.attrelid = child.oid
			   AND column_.attnum = ANY (constraint_.conkey)
			 LEFT JOIN pg_attrdef default_ ON default_.adrelid = child.oid
			   AND default_.adnum = column_.attnum
			 WHERE namespace_.nspname = $1 AND constraint_.contype = 'p'
			   AND child.relname = ANY ($2::text[])
			   AND (column_.attidentity <> ''
			        OR pg_get_expr(default_.adbin, child.oid) LIKE 'nextval%')`,
			[schema, `{${owned.join(",")}}`],
		);

		expect(rows).toEqual([]);
	});
});

describe("session ownership (E-23)", () => {
	it("rejects an UPDATE that names user_id", async () => {
		const userId = await createUser("owner@example.com");
		const otherId = await createUser("other@example.com");
		await createSession(userId);

		await expect(
			connection.query(`UPDATE ${schema}.session SET user_id = $1 WHERE user_id = $2`, [
				otherId,
				userId,
			]),
		).rejects.toBeInstanceOf(PostgresServerError);
	});

	it("rejects an UPDATE that names user_id even without changing it", async () => {
		const userId = await createUser("selfassign@example.com");
		await createSession(userId);

		await expect(
			connection.query(`UPDATE ${schema}.session SET user_id = user_id WHERE user_id = $1`, [
				userId,
			]),
		).rejects.toMatchObject({ sqlState: "23514" });
	});

	it("allows an UPDATE of every other column", async () => {
		const userId = await createUser("touch@example.com");
		const sessionId = await createSession(userId);

		await connection.query(`UPDATE ${schema}.session SET last_used_at = now() WHERE id = $1`, [
			sessionId,
		]);

		const rows = await connection.query(`SELECT id FROM ${schema}.session WHERE id = $1`, [
			sessionId,
		]);
		expect(rows).toHaveLength(1);
	});
});

describe("deleting a user (S-TOKEN-5)", () => {
	it("removes every row the user owns, in every table that references them", async () => {
		const userId = await createUser("cascade@example.com");
		const bytes = () => randomBytes(32);

		await createSession(userId);
		await connection.query(
			`INSERT INTO ${schema}.password_credential (user_id, phc, scheme) VALUES ($1, $2, 'argon2id')`,
			[userId, bytes()],
		);
		await connection.query(
			`INSERT INTO ${schema}.identity (user_id, provider, subject) VALUES ($1, 'github', $2)`,
			[userId, randomBytes(8).toString("hex")],
		);
		await connection.query(
			`INSERT INTO ${schema}.one_time_token (token_sha256, purpose, user_id, expires_at)
			 VALUES ($1, 'email_verify', $2, now() + interval '1 hour')`,
			[bytes(), userId],
		);
		await connection.query(
			`INSERT INTO ${schema}.pending_authentication (token_sha256, user_id, factors_completed, expires_at)
			 VALUES ($1, $2, '{password}', now() + interval '10 minutes')`,
			[bytes(), userId],
		);
		await connection.query(
			`INSERT INTO ${schema}.totp_credential (user_id, secret_enc, key_version) VALUES ($1, $2, 1)`,
			[userId, bytes()],
		);
		await connection.query(
			`INSERT INTO ${schema}.totp_used_step (user_id, time_step, expires_at)
			 VALUES ($1, 1, now() + interval '2 minutes')`,
			[userId],
		);
		await connection.query(
			`INSERT INTO ${schema}.recovery_code (user_id, code_hmac, key_version) VALUES ($1, $2, 1)`,
			[userId, bytes()],
		);
		await connection.query(
			`INSERT INTO ${schema}.webauthn_credential
			 (user_id, credential_id, public_key, backup_eligible, backup_state, user_verified_at_registration)
			 VALUES ($1, $2, $3, false, false, true)`,
			[userId, bytes(), bytes()],
		);
		await connection.query(
			`INSERT INTO ${schema}.webauthn_challenge (challenge_sha256, purpose, user_id, expires_at)
			 VALUES ($1, 'register', $2, now() + interval '5 minutes')`,
			[bytes(), userId],
		);
		await connection.query(
			`INSERT INTO ${schema}.oauth_flow
			 (state_sha256, provider, pkce_verifier_enc, key_version, link_to_user_id, expires_at)
			 VALUES ($1, 'github', $2, 1, $3, now() + interval '10 minutes')`,
			[bytes(), bytes(), userId],
		);
		await connection.query(
			`INSERT INTO ${schema}.import_mapping (source, source_id, user_id, run_id)
			 VALUES ('supabase', $1, $2, gen_random_uuid())`,
			[randomBytes(8).toString("hex"), userId],
		);
		await connection.query(
			`INSERT INTO ${schema}.password_reset_required (user_id, reason, source)
			 VALUES ($1, 'unsupported_scheme', 'clerk')`,
			[userId],
		);

		const owned = await userOwnedTableNames();
		expect(owned).toHaveLength(13);

		await connection.query(`DELETE FROM ${schema}.user WHERE id = $1`, [userId]);

		for (const table of owned) {
			const column = table === "oauth_flow" ? "link_to_user_id" : "user_id";
			const [count] = await connection.query<{ remaining: string }>(
				`SELECT count(*) AS remaining FROM ${schema}.${table} WHERE ${column} = $1`,
				[userId],
			);
			expect(`${table}:${count?.remaining}`).toBe(`${table}:0`);
		}
	});
});
