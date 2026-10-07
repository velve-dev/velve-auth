import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inOneTransaction, rebindEnvelopesOfAccount } from "../src/core/auth/account-envelopes.js";
import { VelveStartupError } from "../src/core/auth/startup.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { encryptWithPurposeKey } from "../src/core/keys/envelope.js";
import { decryptBound } from "../src/core/keys/envelope-binding.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, requestTo } from "./auth-fixtures.js";
import { actorOfTestUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { testKeyRing } from "./totp-fixtures.js";

const PASSWORD = "a password long enough for the policy 7c1e";
const keys = testKeyRing(1).providerAt(1, [1]);

let connection: TestConnection;
let schema: string;
let n = 0;

function instance(sealing?: "required" | "migrating") {
	return toWebHandler(
		createVelveAuth(
			configFor({
				database: connection,
				schema,
				keys,
				rateLimit: {
					perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
					perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
				},
				...(sealing === undefined ? {} : { securityState: { sealing } }),
			}),
		),
	);
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("integ_malformed");
	connection = migrated.connection;
	schema = migrated.schema;
}, 60_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

async function signUp(): Promise<{ email: string; userId: string }> {
	n += 1;
	const email = `rv${n}@example.com`;
	const answer = await instance()(requestTo("/sign-up", { body: { email, password: PASSWORD } }));
	expect(answer.status).toBe(200);
	const [row] = await connection.query<{ id: string }>(
		`SELECT id FROM ${schema}.user WHERE email = $1`,
		[email],
	);
	return { email, userId: (row as { id: string }).id };
}

async function status(handler: ReturnType<typeof instance>, email: string): Promise<number> {
	const answer = await handler(
		requestTo("/sign-in/password", { body: { email, password: PASSWORD } }),
	);
	await answer.text();
	return answer.status;
}

async function setPhc(userId: string, bytes: Uint8Array) {
	await connection.query(`UPDATE ${schema}.password_credential SET phc = $2 WHERE user_id = $1`, [
		userId,
		bytes,
	]);
}

async function unboundPhcOf(userId: string): Promise<Uint8Array<ArrayBuffer>> {
	const [row] = await connection.query<{ phc: Uint8Array; key_version: number }>(
		`SELECT phc, key_version FROM ${schema}.password_credential WHERE user_id = $1`,
		[userId],
	);
	const plain = await decryptBound(
		keys,
		{ column: "password_credential.phc", owner: userId, row: userId },
		{ keyVersion: 1, ciphertext: Uint8Array.from(row?.phc ?? []) },
		"refused",
	);
	return (await encryptWithPurposeKey(keys, "password-enc", plain)).ciphertext;
}

async function sealRowFor(userId: string) {
	await connection.query(
		`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
		 VALUES ($1, 1, $2, 1)`,
		[userId, new Uint8Array(32)],
	);
}

//a sealed account, a malformed value and the start check all refuse the old form (S-INTEG-1)
describe("S-INTEG-1: the old form only for an account without a seal row", () => {
	it("refuses an unbound password envelope of an account WITH a seal row under migrating", async () => {
		const account = await signUp();
		await setPhc(account.userId, await unboundPhcOf(account.userId));
		await sealRowFor(account.userId);
		expect(await status(instance("migrating"), account.email)).toBe(401);
	});

	it("rebindEnvelopesOfAccount does not launder an old-form envelope of a sealed account", async () => {
		const victim = await signUp();
		const other = await signUp();
		const laundered = await unboundPhcOf(other.userId);
		await setPhc(victim.userId, laundered);
		await sealRowFor(victim.userId);
		await expect(
			inOneTransaction(connection, (tx) =>
				rebindEnvelopesOfAccount({
					driver: tx,
					schema,
					keys,
					actor: actorOfTestUser(victim.userId),
					sealing: "migrating",
				}),
			),
		).rejects.toMatchObject({ name: "KeyError" });
		const [left] = await connection.query<{ phc: Uint8Array }>(
			`SELECT phc FROM ${schema}.password_credential WHERE user_id = $1`,
			[victim.userId],
		);
		expect(Buffer.from(left?.phc ?? []).equals(Buffer.from(laundered))).toBe(true);
	});
});

describe("S-INTEG-1: truncated and re-marked password envelopes are the ordinary failure", () => {
	for (const mode of [undefined, "migrating"] as const) {
		it(`mode ${mode ?? "required"}`, async () => {
			const account = await signUp();
			const good = await (async () => {
				const [row] = await connection.query<{ phc: Uint8Array }>(
					`SELECT phc FROM ${schema}.password_credential WHERE user_id = $1`,
					[account.userId],
				);
				return Uint8Array.from(row?.phc ?? []);
			})();
			const handler = instance(mode);
			const variants: Uint8Array[] = [
				new Uint8Array(0),
				Uint8Array.of(2),
				Uint8Array.of(0),
				good.subarray(0, good.length - 1),
				good.subarray(0, 13),
				Uint8Array.of(0, ...good.subarray(1)),
				Uint8Array.of(...good, 0),
			];
			for (const variant of variants) {
				await setPhc(account.userId, variant);
				expect(await status(handler, account.email)).toBe(401);
			}
			await setPhc(account.userId, good);
			expect(await status(handler, account.email)).toBe(200);
		});
	}
});

describe("S-INTEG-1: the sealing option is checked at start", () => {
	it("refuses a misspelt mode, an empty object and null with the documented code", () => {
		for (const bad of [{ sealing: "migratng" }, {}, null, "required"]) {
			let code: string | null = null;
			try {
				createVelveAuth(
					configFor({ database: connection, schema, keys, securityState: bad as never }),
				);
			} catch (failure) {
				code = failure instanceof VelveStartupError ? failure.code : String(failure);
			}
			expect(code).toBe("security_state_sealing_unknown");
		}
	});
});
