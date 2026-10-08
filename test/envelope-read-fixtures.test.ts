import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inOneTransaction } from "../src/core/auth/account-envelopes.js";
import type { Driver } from "../src/core/db/driver.js";
import { lockAccountRow } from "../src/core/db/lock.js";
import { encryptBound } from "../src/core/keys/envelope-binding.js";
import { createOAuthIdentityRepository } from "../src/core/oauth/identity-repository.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { rebindAfterOneRead, verifiedEnvelopeReadOf } from "./envelope-read-fixtures.js";
import { testKeyRing } from "./totp-fixtures.js";

//the read the rewrite tests lean on is one statement taken after the account lock (E-3224)

const ring = testKeyRing(2);
const beforeRotation = ring.providerAt(1, [1]);
const afterRotation = ring.providerAt(2, [1, 2]);

let connection: TestConnection;
let other: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("envelope_read_fixture");
	connection = migrated.connection;
	schema = migrated.schema;
	other = await openTestConnection();
}, 60_000);

afterAll(async () => {
	await other.close();
	await dropSchema(connection, schema);
	await connection.close();
});

function countingDriver(inner: Driver, statements: string[]): Driver {
	return {
		...inner,
		query: ((text: string, values?: unknown[]) => {
			statements.push(text);
			return inner.query(text, values as never);
		}) as Driver["query"],
	} as Driver;
}

describe("verifiedEnvelopeReadOf", () => {
	it("asks the database exactly once", async () => {
		const userId = await createUser(connection, schema);
		const statements: string[] = [];
		await verifiedEnvelopeReadOf(countingDriver(connection, statements), schema, userId);
		expect(statements).toHaveLength(1);
	});

	it("returns each identity's own key version", async () => {
		const userId = await createUser(connection, schema);
		for (const [keys, label] of [
			[beforeRotation, "one"],
			[afterRotation, "two"],
		] as const) {
			await createOAuthIdentityRepository({
				driver: connection,
				schema,
				keys,
			}).insertIdentityOfSignIn({
				userId,
				provider: "stubby",
				subject: `${label}-${userId}`,
				providerEmail: null,
				providerEmailVerified: false,
				profile: null,
				scopes: [],
				tokenLifetimeInSeconds: 3600,
				tokens: { accessToken: "access", refreshToken: null, idToken: null },
			});
		}
		const read = await verifiedEnvelopeReadOf(connection, schema, userId);
		expect(read.identities.map(({ tokenKeyVersion }) => tokenKeyVersion).sort()).toStrictEqual([
			1, 2,
		]);
	});
});

describe("rebindAfterOneRead", () => {
	it("reads only after the lock it waited for was released", async () => {
		const userId = await createUser(connection, schema);
		const binding = { column: "totp_credential.secret_enc" as const, owner: userId, row: userId };
		const first = await encryptBound(beforeRotation, binding, new TextEncoder().encode("FIRST"));
		const second = await encryptBound(beforeRotation, binding, new TextEncoder().encode("SECOND"));
		await connection.query(
			`INSERT INTO ${schema}.totp_credential (user_id, secret_enc, key_version, confirmed_at)
			 VALUES ($1, $2, 1, now())`,
			[userId, first.ciphertext],
		);

		let attempt: Promise<unknown> = Promise.resolve();
		await other.transaction(async (holding) => {
			await lockAccountRow(holding, schema, userId);
			attempt = inOneTransaction(connection, (driver) =>
				rebindAfterOneRead({
					driver,
					schema,
					keys: afterRotation,
					actor: actorOfTestUser(userId),
					sealing: "required",
				}),
			);
			await new Promise((resolve) => setTimeout(resolve, 600));
			await holding.query(
				`UPDATE ${schema}.totp_credential SET secret_enc = $2 WHERE user_id = $1`,
				[userId, second.ciphertext],
			);
		});

		await expect(attempt).resolves.toMatchObject({ totpRewritten: true });
	});
});
