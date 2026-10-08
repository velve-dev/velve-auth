import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inOneTransaction } from "../src/core/auth/account-envelopes.js";
import type { Driver } from "../src/core/db/driver.js";
import { lockAccountRow } from "../src/core/db/lock.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { encryptWithPurposeKey } from "../src/core/keys/envelope.js";
import { decryptBound } from "../src/core/keys/envelope-binding.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, requestTo } from "./auth-fixtures.js";
import { actorOfTestUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { rebindAfterOneRead } from "./envelope-read-fixtures.js";
import {
	codeCarrying,
	createStubProvider,
	oauthConfigFor,
	type StubProvider,
} from "./oauth-provider.js";
import { testKeyRing } from "./totp-fixtures.js";

//every OAuth sign-in writes an account's provider tokens under that account's lock (E-3222)

const keys = testKeyRing(1).providerAt(1);
const LOCK_WAIT_POLLS = 60;
const LOCK_HELD_MS = 1_500;
const POLL_INTERVAL_MS = 50;

let connection: TestConnection;
let other: TestConnection;
let observer: TestConnection;
let schema: string;
let provider: StubProvider;

beforeAll(async () => {
	const migrated = await openMigratedSchema("integ_refresh_race");
	connection = migrated.connection;
	schema = migrated.schema;
	other = await openTestConnection();
	observer = await openTestConnection();
	provider = await createStubProvider({ claims: { sub: "nobody" }, openIdConnect: true });
}, 60_000);

afterAll(async () => {
	await other.close();
	await observer.close();
	await dropSchema(connection, schema);
	await connection.close();
});

function handlerOn(database: Driver, trusted = false) {
	return toWebHandler(
		createVelveAuth(
			configFor({
				database,
				schema,
				keys,
				oauth: oauthConfigFor({ openIdConnect: true, storeTokens: true, trusted }),
				fetch: provider.fetch,
				rateLimit: {
					perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
					perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
				},
			}),
		),
	);
}

async function startedFlow(handler: (request: Request) => Promise<Response>) {
	const answer = await handler(requestTo("/sign-in/oauth/start", { body: { provider: "stubby" } }));
	const body = (await answer.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const url = new URL(body.authorizationUrl);
	return {
		state: url.searchParams.get("state") ?? "",
		pointer: body.stateCookie.value,
		nonce: url.searchParams.get("nonce"),
	};
}

function completed(
	handler: (request: Request) => Promise<Response>,
	flow: { state: string; pointer: string; nonce: string | null },
): Promise<Response> {
	return handler(
		requestTo(
			`/sign-in/oauth/callback/stubby?code=${codeCarrying(flow.nonce)}&state=${encodeURIComponent(flow.state)}`,
			{ method: "GET", cookie: `${DEFAULT_COOKIE_NAMES.oauthState}=${flow.pointer}` },
		),
	);
}

//a backend waiting to lock this schema's account row is the sign-in queueing behind the rewrite
async function aBackendWaitsForALock(): Promise<boolean> {
	for (let poll = 0; poll < LOCK_WAIT_POLLS; poll += 1) {
		const [row] = await observer.query<{ waiting: number }>(
			`SELECT count(*)::int AS waiting FROM pg_stat_activity
			 WHERE wait_event_type = 'Lock' AND position($1 in query) > 0`,
			[`/* locks: ${schema}.user */`],
		);
		if ((row?.waiting ?? 0) > 0) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	return false;
}

describe("a sign-in that refreshes provider tokens during the account rewrite (S-INTEG-1)", () => {
	it("waits for the rewrite's account lock, and both the rewrite and the sign-in succeed", async () => {
		const elsewhere = handlerOn(other);
		const subject = `race-${randomBytes(4).toString("hex")}`;
		provider.reportClaims({
			sub: subject,
			email: `${subject}@provider.example`,
			email_verified: true,
		});
		expect((await completed(elsewhere, await startedFlow(elsewhere))).status).toBeLessThan(400);
		const [identity] = await connection.query<{ id: string; user_id: string }>(
			`SELECT id, user_id FROM ${schema}.identity WHERE subject = $1`,
			[subject],
		);
		const old = await encryptWithPurposeKey(
			keys,
			"oauth-token-enc",
			new TextEncoder().encode("an access token from before the upgrade"),
		);
		await connection.query(
			`UPDATE ${schema}.identity SET access_token_enc = $2, refresh_token_enc = NULL,
			 id_token_enc = NULL, token_key_version = $3 WHERE id = $1`,
			[identity?.id, old.ciphertext, old.keyVersion],
		);
		const flow = await startedFlow(elsewhere);

		let signIn: Promise<Response> | null = null;
		let waited = false;
		const intercepting = (transaction: Driver): Driver => ({
			async query<T>(sql: string, parameters: unknown[]): Promise<T[]> {
				if (
					signIn === null &&
					/^UPDATE \S+\.identity\s+SET access_token_enc = \$3/.test(sql.trim())
				) {
					signIn = completed(elsewhere, flow);
					waited = await aBackendWaitsForALock();
				}
				return transaction.query<T>(sql, parameters);
			},
			transaction: (work) => transaction.transaction(work),
		});
		const pool: Driver = {
			query: (sql, parameters) => connection.query(sql, parameters),
			transaction: (work) =>
				connection.transaction((transaction) => work(intercepting(transaction))),
		};

		const rewrite = await inOneTransaction(pool, (transaction) =>
			rebindAfterOneRead({
				driver: transaction,
				schema,
				keys,
				actor: actorOfTestUser(identity?.user_id ?? ""),
				sealing: "migrating",
			}),
		);

		expect(waited).toBe(true);
		expect(rewrite.identitiesRewritten).toBe(1);
		expect((await (signIn as Promise<Response> | null))?.status).toBeLessThan(400);
		const [after] = await connection.query<{
			access_token_enc: Uint8Array;
			token_key_version: number;
		}>(`SELECT access_token_enc, token_key_version FROM ${schema}.identity WHERE id = $1`, [
			identity?.id,
		]);
		await expect(
			decryptBound(
				keys,
				{
					column: "identity.access_token_enc",
					owner: identity?.user_id ?? "",
					row: identity?.id ?? "",
				},
				{
					keyVersion: after?.token_key_version ?? 0,
					ciphertext: Uint8Array.from(after?.access_token_enc ?? []),
				},
				"refused",
			),
		).resolves.toBeDefined();
	});
});

describe("an automatic link writes provider tokens into an existing account (S-INTEG-1)", () => {
	it("waits for a transaction holding that account's lock before its identity row and tokens land", async () => {
		const handler = handlerOn(other, true);
		const subject = `autolink-${randomBytes(4).toString("hex")}`;
		const address = `${subject}@provider.example`;
		const [user] = await connection.query<{ id: string }>(
			`INSERT INTO ${schema}.user (email, email_verified_at) VALUES ($1, now()) RETURNING id`,
			[address],
		);
		const userId = user?.id ?? "";
		provider.reportClaims({ sub: subject, email: address, email_verified: true });
		const flow = await startedFlow(handler);
		const holder = await openTestConnection();

		let landedWhileLocked = -1;
		let signIn: Promise<Response> = Promise.resolve(new Response());
		await holder.transaction(async (holding) => {
			await lockAccountRow(holding, schema, userId);
			signIn = completed(handler, flow);
			await new Promise((resolve) => setTimeout(resolve, LOCK_HELD_MS));
			const [row] = await connection.query<{ landed: number }>(
				`SELECT count(*)::int AS landed FROM ${schema}.identity
				 WHERE user_id = $1 AND access_token_enc IS NOT NULL`,
				[userId],
			);
			landedWhileLocked = row?.landed ?? -1;
		});
		await holder.close();
		const answer = await signIn;

		expect(landedWhileLocked).toBe(0);
		expect(answer.status).toBeLessThan(400);
		const [linked] = await connection.query<{ landed: number }>(
			`SELECT count(*)::int AS landed FROM ${schema}.identity WHERE user_id = $1`,
			[userId],
		);
		expect(linked?.landed).toBe(1);
	});
});
