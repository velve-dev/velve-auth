import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inOneTransaction, rebindEnvelopesOfAccount } from "../src/core/auth/account-envelopes.js";
import { lockAccountRow } from "../src/core/db/lock.js";
import { encryptWithPurposeKey } from "../src/core/keys/envelope.js";
import { decryptBound } from "../src/core/keys/envelope-binding.js";
import { createOAuthIdentityRepository } from "../src/core/oauth/identity-repository.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { testKeyRing } from "./totp-fixtures.js";

//the rewrite of one account's envelopes is held to the seal row, the rotation and the account lock (E-3121)

const ring = testKeyRing(2);
const beforeRotation = ring.providerAt(1, [1]);
const afterRotation = ring.providerAt(2, [1, 2]);
const LOCK_HELD_MS = 500;

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("integ_rewrite_guards");
	connection = migrated.connection;
	schema = migrated.schema;
}, 60_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function rewrite(userId: string, keys = afterRotation) {
	return inOneTransaction(connection, (driver) =>
		rebindEnvelopesOfAccount({
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
		rebindEnvelopesOfAccount({
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
