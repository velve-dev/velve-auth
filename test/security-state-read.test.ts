import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { rootKeyProvider } from "../src/core/keys/index.js";
import {
	checkSecurityState,
	readSecurityState,
	type SecurityStateVerdict,
} from "../src/core/security-state/read.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { generateRootKey } from "./keys-fixtures.js";
import {
	EVERY_COMPONENT,
	insertIdentity,
	insertPasskey,
	insertRecoveryCode,
	type SeededComponents,
	sealDirectly,
	seedAccount,
} from "./security-state-fixtures.js";

//the one read and its check detect every change T-INTEG-2 lists, one account each (E-3153)

let connection: TestConnection;
let schema: string;
const keys = rootKeyProvider({
	currentVersion: 1,
	keysByVersion: { 1: generateRootKey(), 2: generateRootKey() },
});

beforeAll(async () => {
	const migrated = await openMigratedSchema("seal_read");
	connection = migrated.connection;
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

async function verdictOf(userId: string): Promise<SecurityStateVerdict> {
	const read = await readSecurityState(connection, schema, userId);
	if (read === null) {
		throw new Error("the account vanished");
	}
	return (await checkSecurityState(keys, read, "required")).verdict;
}

function countingStatements(driver: Driver): { driver: Driver; statements: string[] } {
	const statements: string[] = [];
	return {
		statements,
		driver: {
			query<T>(sql: string, params: unknown[]): Promise<T[]> {
				statements.push(sql);
				return driver.query<T>(sql, params);
			},
			transaction: (work) => driver.transaction(work),
		},
	};
}

describe("the one statement that reads an account's seal and components", () => {
	it("returns every component, ciphertexts and row ids included, in one statement", async () => {
		const userId = await seedAccount(connection, schema, EVERY_COMPONENT);
		await sealDirectly(connection, schema, keys, userId, { version: 3, sessionEpoch: 99 });
		const counted = countingStatements(connection);

		const read = await readSecurityState(counted.driver, schema, userId);

		expect(counted.statements).toHaveLength(1);
		const [stored] = await connection.query<{
			phc: Buffer;
			secret_enc: Buffer;
			set_by_session_id: string;
		}>(
			`SELECT credential.phc, secret.secret_enc, credential.set_by_session_id::text AS set_by_session_id
FROM ${schema}.password_credential credential JOIN ${schema}.totp_credential secret USING (user_id)
WHERE user_id = $1`,
			[userId],
		);
		expect(read?.userId).toBe(userId);
		expect(read?.seal?.version).toBe(3);
		expect(read?.seal?.sessionEpoch).toBe(99);
		expect(read?.seal?.keyVersion).toBe(1);
		expect(read?.seal?.digest).toHaveLength(32);
		expect(read?.emailVerified).toBe(true);
		expect(read?.disabled).toBe(true);
		expect(read?.passwordResetRequired).toBe(true);
		expect(Buffer.from(read?.password?.phc ?? []).equals(stored?.phc ?? Buffer.alloc(0))).toBe(
			true,
		);
		expect(read?.password?.scheme).toBe("argon2id");
		expect(read?.password?.setBySessionId).toBe(stored?.set_by_session_id);
		expect(
			Buffer.from(read?.totp?.secretEnc ?? []).equals(stored?.secret_enc ?? Buffer.alloc(0)),
		).toBe(true);
		expect(read?.totp?.confirmed).toBe(true);
		expect(read?.passkeys).toHaveLength(2);
		expect(read?.passkeys[0]?.publicKey).toHaveLength(77);
		expect(read?.passkeys[0]?.signCount).toBe(0);
		expect(read?.identities).toHaveLength(2);
		expect(read?.identities[0]?.accessTokenEnc).toBeNull();
		expect(read?.identities[0]?.tokenKeyVersion).toBeNull();
		expect(read?.recoveryCodes).toHaveLength(3);
	});

	it("returns an identity's stored provider tokens and their key version for the envelope rewrite", async () => {
		const userId = await seedAccount(connection, schema, { identities: 1 });
		const access = randomBytes(40);
		const identifying = randomBytes(60);
		await connection.query(
			`UPDATE ${schema}.identity SET access_token_enc = $2, id_token_enc = $3, token_key_version = 2 WHERE user_id = $1`,
			[userId, access, identifying],
		);

		const read = await readSecurityState(connection, schema, userId);

		const [identity] = read?.identities ?? [];
		expect(Buffer.from(identity?.accessTokenEnc ?? []).equals(access)).toBe(true);
		expect(identity?.refreshTokenEnc).toBeNull();
		expect(Buffer.from(identity?.idTokenEnc ?? []).equals(identifying)).toBe(true);
		expect(identity?.tokenKeyVersion).toBe(2);
	});

	it("answers null for an account that does not exist and for an id that is no uuid", async () => {
		const counted = countingStatements(connection);

		expect(await readSecurityState(counted.driver, schema, randomUUID())).toBeNull();
		expect(await readSecurityState(counted.driver, schema, "not-an-id")).toBeNull();
		expect(counted.statements).toHaveLength(1);
	});

	it("reads an account without a seal row as unsealed in migrating and as seal_missing in required", async () => {
		const userId = await seedAccount(connection, schema, { password: true });
		const read = await readSecurityState(connection, schema, userId);
		if (read === null) {
			throw new Error("the account vanished");
		}

		expect(read.seal).toBeNull();
		expect((await checkSecurityState(keys, read, "migrating")).verdict).toBe("unsealed");
		expect((await checkSecurityState(keys, read, "required")).verdict).toBe("seal_missing");
	});

	it("verifies a seal taken over exactly what it read", async () => {
		const userId = await seedAccount(connection, schema, EVERY_COMPONENT);
		await sealDirectly(connection, schema, keys, userId);

		expect(await verdictOf(userId)).toBe("valid");
	});
});

interface Change {
	readonly name: string;
	readonly base: SeededComponents;
	readonly apply: (userId: string) => Promise<void>;
	readonly expected?: SecurityStateVerdict;
}

const WITHOUT_RESET_ROW: SeededComponents = { ...EVERY_COMPONENT, resetRequired: false };

describe("every change T-INTEG-2 lists makes the check refuse the account", () => {
	const sql = (statement: string) => async (userId: string) => {
		await connection.query(statement.replaceAll("velve.", `${schema}.`), [userId]);
	};

	const changes: readonly Change[] = [
		{
			name: "the TOTP secret deleted",
			base: EVERY_COMPONENT,
			apply: sql("DELETE FROM velve.totp_credential WHERE user_id = $1"),
		},
		{
			name: "a passkey deleted",
			base: EVERY_COMPONENT,
			apply: sql(
				"DELETE FROM velve.webauthn_credential WHERE id = (SELECT id FROM velve.webauthn_credential WHERE user_id = $1 LIMIT 1)",
			),
		},
		{
			name: "a recovery code deleted",
			base: EVERY_COMPONENT,
			apply: sql(
				"DELETE FROM velve.recovery_code WHERE ctid = (SELECT ctid FROM velve.recovery_code WHERE user_id = $1 LIMIT 1)",
			),
		},
		{
			name: "an identity deleted",
			base: EVERY_COMPONENT,
			apply: sql(
				"DELETE FROM velve.identity WHERE id = (SELECT id FROM velve.identity WHERE user_id = $1 LIMIT 1)",
			),
		},
		{
			name: "a foreign passkey inserted",
			base: EVERY_COMPONENT,
			apply: (userId) => insertPasskey(connection, schema, userId),
		},
		{
			name: "a foreign identity inserted",
			base: EVERY_COMPONENT,
			apply: (userId) => insertIdentity(connection, schema, userId),
		},
		{
			name: "another account's TOTP ciphertext put in",
			base: EVERY_COMPONENT,
			apply: async (userId) => {
				const other = await seedAccount(connection, schema, { totp: "confirmed" });
				await connection.query(
					`UPDATE ${schema}.totp_credential SET secret_enc =
  (SELECT secret_enc FROM ${schema}.totp_credential WHERE user_id = $2) WHERE user_id = $1`,
					[userId, other],
				);
			},
		},
		{
			name: "the password ciphertext replaced in place, as an older one of the same row would be",
			base: EVERY_COMPONENT,
			apply: async (userId) => {
				await connection.query(
					`UPDATE ${schema}.password_credential SET phc = $2 WHERE user_id = $1`,
					[userId, randomBytes(96)],
				);
			},
		},
		{
			name: "the address changed",
			base: EVERY_COMPONENT,
			apply: sql("UPDATE velve.user SET email = 'writer@example.com' WHERE id = $1"),
		},
		{
			name: "email_verified_at cleared",
			base: EVERY_COMPONENT,
			apply: sql("UPDATE velve.user SET email_verified_at = NULL WHERE id = $1"),
		},
		{
			name: "set_by_session_id changed",
			base: EVERY_COMPONENT,
			apply: sql(
				"UPDATE velve.password_credential SET set_by_session_id = gen_random_uuid() WHERE user_id = $1",
			),
		},
		{
			name: "the password_reset_required row deleted",
			base: EVERY_COMPONENT,
			apply: sql("DELETE FROM velve.password_reset_required WHERE user_id = $1"),
		},
		{
			name: "the TOTP secret's confirmed_at toggled",
			base: EVERY_COMPONENT,
			apply: sql("UPDATE velve.totp_credential SET confirmed_at = NULL WHERE user_id = $1"),
		},
		{
			name: "a recovery code inserted",
			base: EVERY_COMPONENT,
			apply: (userId) => insertRecoveryCode(connection, schema, userId),
		},
		{
			name: "the password row deleted",
			base: EVERY_COMPONENT,
			apply: sql("DELETE FROM velve.password_credential WHERE user_id = $1"),
		},
		{
			name: "a password_reset_required row inserted",
			base: WITHOUT_RESET_ROW,
			apply: sql(
				"INSERT INTO velve.password_reset_required (user_id, reason, source) VALUES ($1, 'x', 'x')",
			),
		},
		{
			name: "session_epoch changed",
			base: EVERY_COMPONENT,
			apply: sql(
				"UPDATE velve.security_state SET session_epoch = session_epoch + 1 WHERE user_id = $1",
			),
		},
		{
			name: "the seal row's key_version changed to a version the ring holds",
			base: EVERY_COMPONENT,
			apply: sql("UPDATE velve.security_state SET key_version = 2 WHERE user_id = $1"),
		},
		{
			name: "the seal row's key_version changed to a version the ring does not hold",
			base: EVERY_COMPONENT,
			apply: sql("UPDATE velve.security_state SET key_version = 3 WHERE user_id = $1"),
			expected: "key_version_unknown",
		},
		{
			name: "version changed",
			base: EVERY_COMPONENT,
			apply: sql("UPDATE velve.security_state SET version = version + 1 WHERE user_id = $1"),
		},
		{
			name: "digest changed",
			base: EVERY_COMPONENT,
			apply: sql(
				"UPDATE velve.security_state SET digest = set_byte(digest, 0, (get_byte(digest, 0) + 1) % 256) WHERE user_id = $1",
			),
		},
		{
			name: "another account's seal row moved onto this one",
			base: EVERY_COMPONENT,
			apply: async (userId) => {
				const other = await seedAccount(connection, schema, EVERY_COMPONENT);
				await sealDirectly(connection, schema, keys, other);
				await connection.query(`DELETE FROM ${schema}.security_state WHERE user_id = $1`, [userId]);
				await connection.query(
					`UPDATE ${schema}.security_state SET user_id = $1 WHERE user_id = $2`,
					[userId, other],
				);
			},
		},
		{
			name: "a password row inserted into an account without a password",
			base: { ...EVERY_COMPONENT, password: false },
			apply: async (userId) => {
				await connection.query(
					`INSERT INTO ${schema}.password_credential (user_id, phc, key_version, scheme) VALUES ($1, $2, 1, 'argon2id')`,
					[userId, randomBytes(96)],
				);
			},
		},
		{
			name: "a TOTP row inserted into an account without one",
			base: { ...EVERY_COMPONENT, totp: false },
			apply: async (userId) => {
				await connection.query(
					`INSERT INTO ${schema}.totp_credential (user_id, secret_enc, key_version) VALUES ($1, $2, 1)`,
					[userId, randomBytes(48)],
				);
			},
		},
		{
			name: "a passkey's public_key changed in place",
			base: EVERY_COMPONENT,
			apply: sql(
				"UPDATE velve.webauthn_credential SET public_key = public_key || '\\x00'::bytea WHERE id = (SELECT id FROM velve.webauthn_credential WHERE user_id = $1 LIMIT 1)",
			),
		},
		{
			name: "an identity's subject changed in place",
			base: EVERY_COMPONENT,
			apply: sql(
				"UPDATE velve.identity SET subject = subject || 'x' WHERE id = (SELECT id FROM velve.identity WHERE user_id = $1 LIMIT 1)",
			),
		},
		{
			name: "password_credential.key_version changed",
			base: EVERY_COMPONENT,
			apply: sql("UPDATE velve.password_credential SET key_version = 2 WHERE user_id = $1"),
		},
		{
			name: "totp_credential.key_version changed",
			base: EVERY_COMPONENT,
			apply: sql("UPDATE velve.totp_credential SET key_version = 2 WHERE user_id = $1"),
		},
		{
			name: "recovery_code.key_version changed",
			base: EVERY_COMPONENT,
			apply: sql(
				"UPDATE velve.recovery_code SET key_version = 2 WHERE ctid = (SELECT ctid FROM velve.recovery_code WHERE user_id = $1 LIMIT 1)",
			),
		},
		{
			name: "recovery_code.code_hmac changed",
			base: EVERY_COMPONENT,
			apply: sql(
				"UPDATE velve.recovery_code SET code_hmac = set_byte(code_hmac, 0, (get_byte(code_hmac, 0) + 1) % 256) WHERE ctid = (SELECT ctid FROM velve.recovery_code WHERE user_id = $1 LIMIT 1)",
			),
		},
		{
			name: "webauthn_credential.credential_id changed",
			base: EVERY_COMPONENT,
			apply: sql(
				"UPDATE velve.webauthn_credential SET credential_id = credential_id || '\\x00'::bytea WHERE id = (SELECT id FROM velve.webauthn_credential WHERE user_id = $1 LIMIT 1)",
			),
		},
		{
			name: "identity.provider changed",
			base: EVERY_COMPONENT,
			apply: sql(
				"UPDATE velve.identity SET provider = 'google' WHERE id = (SELECT id FROM velve.identity WHERE user_id = $1 LIMIT 1)",
			),
		},
		{
			name: "disabled_at cleared on a disabled account",
			base: EVERY_COMPONENT,
			apply: sql("UPDATE velve.user SET disabled_at = NULL WHERE id = $1"),
		},
	];

	it("lists the thirty-two changes of T-INTEG-2 and the unknown key version beside them", () => {
		expect(changes).toHaveLength(33);
	});

	for (const change of changes) {
		it(`refuses ${change.name}`, async () => {
			const userId = await seedAccount(connection, schema, change.base);
			await sealDirectly(connection, schema, keys, userId);
			expect(await verdictOf(userId)).toBe("valid");

			await change.apply(userId);

			expect(await verdictOf(userId)).toBe(change.expected ?? "seal_mismatch");
		});
	}
});
