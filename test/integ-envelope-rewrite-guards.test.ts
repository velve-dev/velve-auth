import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	EnvelopeChangedSinceReadError,
	inOneTransaction,
	rebindEnvelopesOfAccount,
} from "../src/core/auth/account-envelopes.js";
import { lockAccountRow } from "../src/core/db/lock.js";
import { encryptWithPurposeKey } from "../src/core/keys/envelope.js";
import { decryptBound, encryptBound } from "../src/core/keys/envelope-binding.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { createOAuthIdentityRepository } from "../src/core/oauth/identity-repository.js";
import { sealPhc } from "../src/core/password/credential.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { rebindAfterOneRead, verifiedEnvelopeReadOf } from "./envelope-read-fixtures.js";
import { testKeyRing } from "./totp-fixtures.js";

//the rewrite of one account's envelopes is held to the seal row, the rotation and the account lock (E-3121)

const ring = testKeyRing(2);
const beforeRotation = ring.providerAt(1, [1]);
const afterRotation = ring.providerAt(2, [1, 2]);
const LOCK_HELD_MS = 500;

const STORED_PHC = `$argon2id$v=19$m=19456,t=2,p=1$${"c2FsdA".repeat(4)}$${"aGFzaA".repeat(7)}`;

let connection: TestConnection;
let writer: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("integ_rewrite_guards");
	connection = migrated.connection;
	schema = migrated.schema;
	writer = await openTestConnection();
}, 60_000);

afterAll(async () => {
	await writer.close();
	await dropSchema(connection, schema);
	await connection.close();
});

function rewrite(userId: string, keys = afterRotation) {
	return inOneTransaction(connection, (driver) =>
		rebindAfterOneRead({
			driver,
			schema,
			keys,
			actor: actorOfTestUser(userId),
			sealing: "required",
		}),
	);
}

async function sealedAccount(): Promise<string> {
	const userId = await createUser(connection, schema);
	await connection.query(
		`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version, session_epoch)
		 VALUES ($1, 1, decode(repeat('00', 32), 'hex'), 1, 1)`,
		[userId],
	);
	return userId;
}

function migratingRewrite(userId: string) {
	return inOneTransaction(connection, (driver) =>
		rebindAfterOneRead({
			driver,
			schema,
			keys: beforeRotation,
			actor: actorOfTestUser(userId),
			sealing: "migrating",
		}),
	);
}

describe("the rewrite of one account's envelopes (S-INTEG-1)", () => {
	it("re-keys a bound identity's tokens under the current version after a rotation", async () => {
		const userId = await createUser(connection, schema);
		const repository = createOAuthIdentityRepository({
			driver: connection,
			schema,
			keys: beforeRotation,
		});
		const identity = await repository.insertIdentityOfSignIn({
			userId,
			provider: "stubby",
			subject: `rotation-${userId}`,
			providerEmail: null,
			providerEmailVerified: false,
			profile: null,
			scopes: [],
			tokenLifetimeInSeconds: 3600,
			tokens: { accessToken: "access", refreshToken: "refresh", idToken: "id" },
		});

		const outcome = await rewrite(userId);

		expect(outcome.identitiesRewritten).toBe(1);
		const [row] = await connection.query<{
			token_key_version: number;
			access_token_enc: Uint8Array;
		}>(`SELECT token_key_version, access_token_enc FROM ${schema}.identity WHERE id = $1`, [
			identity?.id,
		]);
		expect(row?.token_key_version).toBe(2);
		await expect(
			decryptBound(
				afterRotation,
				{ column: "identity.access_token_enc", owner: userId, row: identity?.id ?? "" },
				{ keyVersion: 2, ciphertext: Uint8Array.from(row?.access_token_enc ?? []) },
				"refused",
			),
		).resolves.toStrictEqual(new TextEncoder().encode("access"));
	});

	it("reports nothing rewritten for an account that holds no envelope", async () => {
		const userId = await createUser(connection, schema);

		expect(await rewrite(userId)).toStrictEqual({
			envelopes: { password: null, totpSecret: null, identities: [] },
			passwordRewritten: false,
			totpRewritten: false,
			identitiesRewritten: 0,
		});
	});

	it("waits for a transaction that holds the account row", async () => {
		const userId = await createUser(connection, schema);
		let rewriteFinished = false;
		let pendingRewrite: Promise<unknown> = Promise.resolve();

		const holderConnection = await openTestConnection();
		await holderConnection.transaction(async (holder) => {
			await lockAccountRow(holder, schema, userId);
			pendingRewrite = rewrite(userId).then(() => {
				rewriteFinished = true;
			});
			await new Promise((resolve) => setTimeout(resolve, LOCK_HELD_MS));
			expect(rewriteFinished).toBe(false);
		});
		await pendingRewrite;
		await holderConnection.close();
		expect(rewriteFinished).toBe(true);
	});
});

describe("the rewrite never opens the old form of a sealed account (S-INTEG-1)", () => {
	it("refuses an unbound TOTP secret copied onto a sealed account and leaves the row as it was", async () => {
		const userId = await sealedAccount();
		const copied = await encryptWithPurposeKey(
			beforeRotation,
			"totp-enc",
			new TextEncoder().encode("12345678901234567890"),
		);
		await connection.query(
			`INSERT INTO ${schema}.totp_credential (user_id, secret_enc, key_version, confirmed_at)
			 VALUES ($1, $2, $3, now())`,
			[userId, copied.ciphertext, copied.keyVersion],
		);

		await expect(migratingRewrite(userId)).rejects.toMatchObject({ code: "envelope_unbound" });

		const [row] = await connection.query<{ secret_enc: Uint8Array }>(
			`SELECT secret_enc FROM ${schema}.totp_credential WHERE user_id = $1`,
			[userId],
		);
		expect(Uint8Array.from(row?.secret_enc ?? [])).toStrictEqual(copied.ciphertext);
	});

	it("refuses an unbound provider token copied onto a sealed account's identity", async () => {
		const userId = await sealedAccount();
		const identity = await createOAuthIdentityRepository({
			driver: connection,
			schema,
			keys: beforeRotation,
		}).insertIdentityOfSignIn({
			userId,
			provider: "stubby",
			subject: `sealed-${userId}`,
			providerEmail: null,
			providerEmailVerified: false,
			profile: null,
			scopes: [],
			tokenLifetimeInSeconds: 3600,
			tokens: { accessToken: "access", refreshToken: null, idToken: null },
		});
		const copied = await encryptWithPurposeKey(
			beforeRotation,
			"oauth-token-enc",
			new TextEncoder().encode("attacker-token"),
		);
		await connection.query(`UPDATE ${schema}.identity SET access_token_enc = $2 WHERE id = $1`, [
			identity?.id,
			copied.ciphertext,
		]);

		await expect(migratingRewrite(userId)).rejects.toMatchObject({ code: "envelope_unbound" });
	});
});

describe("the rewrite opens and swaps only what the one verified read returned (S-INTEG-3)", () => {
	const utf8 = new TextEncoder();

	//the read, then a write the account lock does not hold off, then the rewrite of that read
	function rewriteAfterAForeignWrite(
		userId: string,
		foreignWrite: () => Promise<unknown>,
		options: { readonly keys: KeyProvider; readonly sealing: "required" | "migrating" },
	) {
		return inOneTransaction(connection, async (driver) => {
			await lockAccountRow(driver, schema, userId);
			const read = await verifiedEnvelopeReadOf(driver, schema, userId);
			await foreignWrite();
			return rebindEnvelopesOfAccount({
				driver,
				schema,
				keys: options.keys,
				actor: actorOfTestUser(userId),
				sealing: options.sealing,
				read,
			});
		});
	}

	it("refuses rather than re-keying an older ciphertext of the same row committed after the read", async () => {
		const userId = await sealedAccount();
		const binding = { column: "totp_credential.secret_enc" as const, owner: userId, row: userId };
		const older = await encryptBound(
			beforeRotation,
			binding,
			utf8.encode("OLD-SECRET-ROLLED-BACK"),
		);
		const current = await encryptBound(beforeRotation, binding, utf8.encode("CURRENT-SECRET"));
		await connection.query(
			`INSERT INTO ${schema}.totp_credential (user_id, secret_enc, key_version, confirmed_at)
			 VALUES ($1, $2, 1, now())`,
			[userId, current.ciphertext],
		);

		const attempt = rewriteAfterAForeignWrite(
			userId,
			() =>
				writer.query(`UPDATE ${schema}.totp_credential SET secret_enc = $2 WHERE user_id = $1`, [
					userId,
					older.ciphertext,
				]),
			{ keys: afterRotation, sealing: "required" },
		);

		await expect(attempt).rejects.toBeInstanceOf(EnvelopeChangedSinceReadError);
		const [stored] = await connection.query<{ secret_enc: Uint8Array; key_version: number }>(
			`SELECT secret_enc, key_version FROM ${schema}.totp_credential WHERE user_id = $1`,
			[userId],
		);
		expect(stored?.key_version).toBe(1);
		expect(Uint8Array.from(stored?.secret_enc ?? [])).toStrictEqual(older.ciphertext);
	});

	it("refuses a password row whose key version alone changed after the read", async () => {
		const userId = await createUser(connection, schema);
		const sealed = await sealPhc(beforeRotation, userId, STORED_PHC);
		await connection.query(
			`INSERT INTO ${schema}.password_credential (user_id, phc, key_version, scheme)
			 VALUES ($1, $2, $3, 'argon2id')`,
			[userId, sealed.ciphertext, sealed.keyVersion],
		);

		const attempt = rewriteAfterAForeignWrite(
			userId,
			() =>
				writer.query(
					`UPDATE ${schema}.password_credential SET key_version = 2 WHERE user_id = $1`,
					[userId],
				),
			{ keys: afterRotation, sealing: "required" },
		);

		await expect(attempt).rejects.toBeInstanceOf(EnvelopeChangedSinceReadError);
	});

	it("refuses a TOTP row whose key version alone changed after the read", async () => {
		const userId = await createUser(connection, schema);
		const binding = { column: "totp_credential.secret_enc" as const, owner: userId, row: userId };
		const current = await encryptBound(beforeRotation, binding, utf8.encode("CURRENT-SECRET"));
		await connection.query(
			`INSERT INTO ${schema}.totp_credential (user_id, secret_enc, key_version, confirmed_at)
			 VALUES ($1, $2, 1, now())`,
			[userId, current.ciphertext],
		);

		const attempt = rewriteAfterAForeignWrite(
			userId,
			() =>
				writer.query(`UPDATE ${schema}.totp_credential SET key_version = 2 WHERE user_id = $1`, [
					userId,
				]),
			{ keys: afterRotation, sealing: "required" },
		);

		await expect(attempt).rejects.toBeInstanceOf(EnvelopeChangedSinceReadError);
	});

	it("keeps the old form closed when the seal row the read saw is deleted before the rewrite", async () => {
		const userId = await sealedAccount();
		const copied = await encryptWithPurposeKey(beforeRotation, "totp-enc", utf8.encode("copied"));
		await connection.query(
			`INSERT INTO ${schema}.totp_credential (user_id, secret_enc, key_version, confirmed_at)
			 VALUES ($1, $2, $3, now())`,
			[userId, copied.ciphertext, copied.keyVersion],
		);

		const attempt = rewriteAfterAForeignWrite(
			userId,
			() => writer.query(`DELETE FROM ${schema}.security_state WHERE user_id = $1`, [userId]),
			{ keys: beforeRotation, sealing: "migrating" },
		);

		await expect(attempt).rejects.toMatchObject({ code: "envelope_unbound" });
	});
});
