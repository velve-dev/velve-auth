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

async function signedInAs(handler: (request: Request) => Promise<Response>, subject: string) {
	provider.reportClaims({
		sub: subject,
		email: `${subject}@provider.example`,
		email_verified: true,
	});
	return completed(handler, await startedFlow(handler));
}

//every statement passes through, and the first that takes the account lock is followed by the change
function changingAfterTheLock(change: () => Promise<void>): {
	readonly pool: Driver;
	readonly changed: () => boolean;
} {
	let changed = false;
	const intercepting = (transaction: Driver): Driver => ({
		async query<T>(sql: string, parameters: unknown[]): Promise<T[]> {
			const answer = await transaction.query<T>(sql, parameters);
			if (!changed && sql.includes(`/* locks: ${schema}.user */`)) {
				changed = true;
				await change();
			}
			return answer;
		},
		transaction: (work) => transaction.transaction(work),
	});
	return {
		pool: {
			query: (sql, parameters) => connection.query(sql, parameters),
			transaction: (work) =>
				connection.transaction((transaction) => work(intercepting(transaction))),
		},
		changed: () => changed,
	};
}

async function identityOf(subject: string): Promise<{ id: string; user_id: string }> {
	const [row] = await connection.query<{ id: string; user_id: string }>(
		`SELECT id, user_id FROM ${schema}.identity WHERE subject = $1`,
		[subject],
	);
	return row ?? { id: "", user_id: "" };
}

describe("an automatic link decides again under the lock which account it joins (S-LINK-2)", () => {
	async function linkWhileTheAccountChanges(change: string) {
		const handler = handlerOn(other, true);
		const subject = `requalify-${randomBytes(4).toString("hex")}`;
		const address = `${subject}@provider.example`;
		const [user] = await connection.query<{ id: string }>(
			`INSERT INTO ${schema}.user (email, email_verified_at) VALUES ($1, now()) RETURNING id`,
			[address],
		);
		const userId = user?.id ?? "";
		provider.reportClaims({ sub: subject, email: address, email_verified: true });
		const flow = await startedFlow(handler);
		const holder = await openTestConnection();

		let waited = false;
		let signIn: Promise<Response> = Promise.resolve(new Response());
		await holder.transaction(async (holding) => {
			await lockAccountRow(holding, schema, userId);
			signIn = completed(handler, flow);
			waited = await aBackendWaitsForALock();
			await holding.query(change, [userId, `moved-${subject}@elsewhere.example`]);
		});
		await holder.close();
		const answer = await signIn;
		const unknown = await handlerOn(connection)(
			requestTo("/sign-in/oauth/callback/stubby?code=x&state=nope", {
				method: "GET",
				cookie: `${DEFAULT_COOKIE_NAMES.oauthState}=nope`,
			}),
		);
		const [linked] = await connection.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM ${schema}.identity WHERE subject = $1`,
			[subject],
		);
		return { waited, answer, unknown, identities: linked?.count };
	}

	it("links nothing into an account whose address moved while the sign-in waited", async () => {
		const outcome = await linkWhileTheAccountChanges(
			`UPDATE ${schema}.user SET email = $2 WHERE id = $1`,
		);

		expect(outcome.waited).toBe(true);
		expect(outcome.identities).toBe(0);
		expect(outcome.answer.status).toBe(outcome.unknown.status);
		expect(await outcome.answer.text()).toBe(await outcome.unknown.text());
	});

	it("links nothing into an account whose address lost its verification while the sign-in waited", async () => {
		const outcome = await linkWhileTheAccountChanges(
			`UPDATE ${schema}.user SET email_verified_at = NULL WHERE id = $1 AND $2::text IS NOT NULL`,
		);

		expect(outcome.waited).toBe(true);
		expect(outcome.identities).toBe(0);
		expect(outcome.answer.status).toBe(outcome.unknown.status);
		expect(await outcome.answer.text()).toBe(await outcome.unknown.text());
	});
});

describe("a known identity's sign-in reads the identity again under the account lock (S-INTEG-1)", () => {
	it("refuses a sign-in whose identity changed owner while it waited for the lock", async () => {
		const subjectA = `owner-a-${randomBytes(4).toString("hex")}`;
		const subjectB = `owner-b-${randomBytes(4).toString("hex")}`;
		const plain = handlerOn(connection);
		expect((await signedInAs(plain, subjectA)).status).toBeLessThan(400);
		expect((await signedInAs(plain, subjectB)).status).toBeLessThan(400);
		const a = await identityOf(subjectA);
		const b = await identityOf(subjectB);
		const moving = changingAfterTheLock(async () => {
			await other.query(`UPDATE ${schema}.identity SET user_id = $2 WHERE id = $1`, [
				a.id,
				b.user_id,
			]);
		});

		const answer = await signedInAs(handlerOn(moving.pool), subjectA);

		expect(moving.changed()).toBe(true);
		expect(answer.status).toBeGreaterThanOrEqual(400);
	});

	it("refuses a sign-in whose identity row was replaced by another row of the same subject", async () => {
		const subject = `replaced-${randomBytes(4).toString("hex")}`;
		expect((await signedInAs(handlerOn(connection), subject)).status).toBeLessThan(400);
		const identity = await identityOf(subject);
		const replacing = changingAfterTheLock(async () => {
			await other.query(`UPDATE ${schema}.identity SET id = gen_random_uuid() WHERE id = $1`, [
				identity.id,
			]);
		});

		const answer = await signedInAs(handlerOn(replacing.pool), subject);

		expect(replacing.changed()).toBe(true);
		expect(answer.status).toBeGreaterThanOrEqual(400);
	});

	it("answers a sign-in whose identity vanished while it waited exactly like an unknown state", async () => {
		const subject = `vanished-${randomBytes(4).toString("hex")}`;
		expect((await signedInAs(handlerOn(connection), subject)).status).toBeLessThan(400);
		const identity = await identityOf(subject);
		const deleting = changingAfterTheLock(async () => {
			await other.query(`DELETE FROM ${schema}.identity WHERE id = $1`, [identity.id]);
		});

		const answer = await signedInAs(handlerOn(deleting.pool), subject);
		const unknown = await handlerOn(connection)(
			requestTo("/sign-in/oauth/callback/stubby?code=x&state=nope", {
				method: "GET",
				cookie: `${DEFAULT_COOKIE_NAMES.oauthState}=nope`,
			}),
		);

		expect(deleting.changed()).toBe(true);
		expect(answer.status).toBe(unknown.status);
		expect(await answer.text()).toBe(await unknown.text());
	});
});
