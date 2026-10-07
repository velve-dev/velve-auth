import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import {
	createPendingAuthenticationService,
	MAXIMUM_PENDING_ATTEMPTS,
	type PendingAuthenticationService,
	type PendingToken,
	toPendingToken,
} from "../src/core/factor/pending/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { encodeBase64Url } from "../src/core/keys/base64url.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { createSessionService, type SessionService } from "../src/core/session/service.js";
import {
	canonicalPayloadOf,
	encodeTokenBinding,
	type TokenBinding,
	type TokenBindingRefusal,
} from "../src/core/token/binding.js";
import { createOneTimeTokens, type OneTimeTokens } from "../src/core/token/one-time-token.js";
import { toSecretToken } from "../src/core/token/secret-token.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { testKeyRing } from "./totp-fixtures.js";

/**
 * T-INTEG-9 (section 6.24): a database writer without the root key inserts token rows for a token
 * of their own choosing, and rewrites real rows to another account, another purpose and another
 * content. Every row is refused as a missing one would be, and the refusal reaches the verdict
 * the security-state alarm is wired to, with the reason `token_binding_mismatch`.
 */

const NO_REQUEST = { ipAddress: null, userAgent: null };

let migrated: MigratedSchema;
let schema: string;
let keys: KeyProvider;
let refusals: TokenBindingRefusal[];
let sessions: SessionService;
let pending: PendingAuthenticationService;
let oneTimeTokens: OneTimeTokens;
let owner: string;
let victim: string;

function report(refusal: TokenBindingRefusal): void {
	refusals.push(refusal);
}

function sha256Of(token: string): Buffer {
	return createHash("sha256").update(token, "utf8").digest();
}

function byte(): number {
	return randomBytes(1).readUInt8(0);
}

function chosenToken(): string {
	return encodeBase64Url(randomBytes(32));
}

function servicesUnder(provider: KeyProvider) {
	return {
		sessions: createSessionService({
			driver: migrated.connection,
			keys: provider,
			schema,
			reportTokenBindingRefusal: report,
		}),
		pending: createPendingAuthenticationService({
			driver: migrated.connection,
			keys: provider,
			schema,
			reportTokenBindingRefusal: report,
		}),
		oneTimeTokens: createOneTimeTokens(
			createOneTimeTokenRepository({ driver: migrated.connection, schema }),
			{ keys: provider, reportTokenBindingRefusal: report },
		),
	};
}

async function sql(statement: string, parameters: unknown[] = []): Promise<void> {
	await migrated.connection.query(statement, parameters);
}

async function issuedSession(userId: string): Promise<string> {
	return (await sessions.issue({ userId, factors: ["password"], observed: NO_REQUEST })).token;
}

async function issuedPending(userId: string): Promise<PendingToken> {
	return (await pending.begin({ userId, factorsCompleted: ["password"] })).token;
}

async function issuedOneTime(
	userId: string,
	purpose: "email_verify" | "email_change" = "email_verify",
): Promise<string> {
	const payload = purpose === "email_change" ? { newEmail: "mine@example.com" } : undefined;
	return (
		await oneTimeTokens.issue({ purpose, userId, ...(payload === undefined ? {} : { payload }) })
	).token;
}

function expectOneRefusal(occasion: TokenBindingRefusal["occasion"], userId: string): void {
	expect(refusals).toStrictEqual([
		{ userId, occasion, reason: "token_binding_mismatch", verdict: "mismatch" },
	]);
}

beforeAll(async () => {
	migrated = await openMigratedSchema("integtokenbinding");
	schema = migrated.schema;
	keys = testKeyRing(1).providerAt(1);
	({ sessions, pending, oneTimeTokens } = servicesUnder(keys));
	owner = await createUser(migrated.connection, schema);
	victim = await createUser(migrated.connection, schema);
});

afterAll(async () => {
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

describe("rows a writer inserts for a token of their own choosing (T-INTEG-9, 3/3)", () => {
	it("refuses a session row", async () => {
		refusals = [];
		const token = chosenToken();
		await sql(
			`INSERT INTO ${schema}.session
			   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors,
			    token_mac, token_mac_key_version)
			 VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days', '{password,totp}',
			    $3, 1)`,
			[victim, sha256Of(token), randomBytes(32)],
		);

		expect(await sessions.resolve(token)).toBeNull();
		expectOneRefusal("session_resolve", victim);
	});

	it("refuses a pending authentication row", async () => {
		refusals = [];
		const token = chosenToken();
		await sql(
			`INSERT INTO ${schema}.pending_authentication
			   (token_sha256, user_id, factors_completed, expires_at, token_mac, token_mac_key_version)
			 VALUES ($1, $2, '{password}', now() + interval '5 minutes', $3, 1)`,
			[sha256Of(token), victim, randomBytes(32)],
		);

		expect(await pending.resolve(toPendingToken(token))).toBeNull();
		await expect(pending.consume(toPendingToken(token))).rejects.toThrow();
		expect(refusals).toHaveLength(2);
		expect(refusals.every((refusal) => refusal.occasion === "factor_check")).toBe(true);
		expect(refusals.every((refusal) => refusal.reason === "token_binding_mismatch")).toBe(true);
	});

	it("refuses a one-time token row", async () => {
		refusals = [];
		const token = chosenToken();
		await sql(
			`INSERT INTO ${schema}.one_time_token
			   (token_sha256, purpose, user_id, expires_at, token_mac, token_mac_key_version)
			 VALUES ($1, 'password_reset', $2, now() + interval '1 hour', $3, 1)`,
			[sha256Of(token), victim, randomBytes(32)],
		);

		expect(
			await oneTimeTokens.redeem({ token: toSecretToken(token), purpose: "password_reset" }),
		).toBeNull();
		expectOneRefusal("token_redemption", victim);
	});
});

describe("real rows a writer rewrites (T-INTEG-9, 9/9)", () => {
	it("refuses a session moved to another account", async () => {
		const token = await issuedSession(owner);
		await sql(
			`WITH moved AS (DELETE FROM ${schema}.session WHERE token_sha256 = $1 RETURNING *)
			 INSERT INTO ${schema}.session
			   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors,
			    token_mac, token_mac_key_version)
			 SELECT $2, token_sha256, idle_expires_at, absolute_expires_at, factors,
			    token_mac, token_mac_key_version FROM moved`,
			[sha256Of(token), victim],
		);
		refusals = [];

		expect(await sessions.resolve(token)).toBeNull();
		expectOneRefusal("session_resolve", victim);
	});

	it("refuses a session moved into the pending table", async () => {
		const token = await issuedSession(owner);
		await sql(
			`WITH moved AS (DELETE FROM ${schema}.session WHERE token_sha256 = $1 RETURNING *)
			 INSERT INTO ${schema}.pending_authentication
			   (token_sha256, user_id, factors_completed, expires_at, token_mac, token_mac_key_version)
			 SELECT token_sha256, user_id, factors, now() + interval '5 minutes',
			    token_mac, token_mac_key_version FROM moved`,
			[sha256Of(token)],
		);
		refusals = [];

		expect(await pending.resolve(toPendingToken(token))).toBeNull();
		expectOneRefusal("factor_check", owner);
	});

	it("refuses a session whose factors were raised", async () => {
		const token = await issuedSession(owner);
		await sql(`UPDATE ${schema}.session SET factors = '{password,totp}' WHERE token_sha256 = $1`, [
			sha256Of(token),
		]);
		refusals = [];

		expect(await sessions.resolve(token)).toBeNull();
		expectOneRefusal("session_resolve", owner);
	});

	it("refuses a pending authentication moved to another account", async () => {
		const token = await issuedPending(owner);
		await sql(`UPDATE ${schema}.pending_authentication SET user_id = $2 WHERE token_sha256 = $1`, [
			sha256Of(token),
			victim,
		]);
		refusals = [];

		expect(await pending.resolve(token)).toBeNull();
		expectOneRefusal("factor_check", victim);
	});

	it("refuses a pending authentication moved into the session table", async () => {
		const token = await issuedPending(owner);
		await sql(
			`WITH moved AS (
			   DELETE FROM ${schema}.pending_authentication WHERE token_sha256 = $1 RETURNING *
			 )
			 INSERT INTO ${schema}.session
			   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors,
			    token_mac, token_mac_key_version)
			 SELECT user_id, token_sha256, now() + interval '1 day', now() + interval '2 days',
			    factors_completed, token_mac, token_mac_key_version FROM moved`,
			[sha256Of(token)],
		);
		refusals = [];

		expect(await sessions.resolve(token)).toBeNull();
		expectOneRefusal("session_resolve", owner);
	});

	it("refuses a pending authentication whose completed factors were raised", async () => {
		const token = await issuedPending(owner);
		await sql(
			`UPDATE ${schema}.pending_authentication SET factors_completed = '{password,totp}'
			 WHERE token_sha256 = $1`,
			[sha256Of(token)],
		);
		refusals = [];

		await expect(pending.consume(token)).rejects.toThrow();
		expectOneRefusal("factor_check", owner);
	});

	it("refuses a one-time token moved to another account", async () => {
		const token = await issuedOneTime(owner);
		await sql(`UPDATE ${schema}.one_time_token SET user_id = $2 WHERE token_sha256 = $1`, [
			sha256Of(token),
			victim,
		]);
		refusals = [];

		expect(
			await oneTimeTokens.redeem({ token: toSecretToken(token), purpose: "email_verify" }),
		).toBeNull();
		expectOneRefusal("token_redemption", victim);
	});

	it("refuses a one-time token given another purpose", async () => {
		const token = await issuedOneTime(owner);
		await sql(
			`UPDATE ${schema}.one_time_token SET purpose = 'password_reset' WHERE token_sha256 = $1`,
			[sha256Of(token)],
		);
		refusals = [];

		expect(
			await oneTimeTokens.redeem({ token: toSecretToken(token), purpose: "password_reset" }),
		).toBeNull();
		expectOneRefusal("token_redemption", owner);
	});

	it("refuses a one-time token whose payload names another address", async () => {
		const token = await issuedOneTime(owner, "email_change");
		await sql(
			`UPDATE ${schema}.one_time_token SET payload = '{"newEmail":"attacker@example.com"}'
			 WHERE token_sha256 = $1`,
			[sha256Of(token)],
		);
		refusals = [];

		expect(
			await oneTimeTokens.redeem({ token: toSecretToken(token), purpose: "email_change" }),
		).toBeNull();
		expectOneRefusal("token_redemption", owner);
	});
});

describe("the attempt counter of a pending authentication (S-INTEG-9)", () => {
	it("refuses a row whose counter a writer reset", async () => {
		const token = await issuedPending(owner);
		expect(await pending.registerFailedAttempt(token)).toStrictEqual({
			outcome: "attempts_remain",
			attemptsRemaining: MAXIMUM_PENDING_ATTEMPTS - 1,
		});
		await sql(`UPDATE ${schema}.pending_authentication SET attempts = 0 WHERE token_sha256 = $1`, [
			sha256Of(token),
		]);
		refusals = [];

		expect(await pending.resolve(token)).toBeNull();
		expect(await pending.registerFailedAttempt(token)).toStrictEqual({ outcome: "exhausted" });
		expect(refusals.map((refusal) => refusal.occasion)).toStrictEqual([
			"factor_check",
			"factor_check",
		]);
	});

	it("rebinds the row on every attempt, so the counted row still verifies", async () => {
		const token = await issuedPending(owner);
		refusals = [];
		for (let attempt = 1; attempt < MAXIMUM_PENDING_ATTEMPTS; attempt += 1) {
			expect(await pending.registerFailedAttempt(token)).toStrictEqual({
				outcome: "attempts_remain",
				attemptsRemaining: MAXIMUM_PENDING_ATTEMPTS - attempt,
			});
			expect((await pending.resolve(token))?.pending.attemptsRemaining).toBe(
				MAXIMUM_PENDING_ATTEMPTS - attempt,
			);
		}

		expect(await pending.registerFailedAttempt(token)).toStrictEqual({ outcome: "exhausted" });
		expect(await pending.resolve(token)).toBeNull();
		expect(refusals).toStrictEqual([]);
	});

	it("counts concurrent attempts exactly once each", async () => {
		const token = await issuedPending(owner);
		const parallel = MAXIMUM_PENDING_ATTEMPTS - 1;

		const outcomes = await Promise.all(
			Array.from({ length: parallel }, () => pending.registerFailedAttempt(token)),
		);

		const remaining = outcomes
			.map((outcome) => (outcome.outcome === "attempts_remain" ? outcome.attemptsRemaining : -1))
			.sort((left, right) => left - right);
		expect(remaining).toStrictEqual(Array.from({ length: parallel }, (_, index) => index + 1));
		expect((await pending.resolve(token))?.pending.attemptsRemaining).toBe(1);
	});
});

describe("what a row the library wrote keeps (S-INTEG-9)", () => {
	it("resolves an untouched session, pending authentication and one-time token", async () => {
		refusals = [];
		const session = await issuedSession(owner);
		const pendingToken = await issuedPending(owner);
		const oneTime = await issuedOneTime(owner, "email_change");

		expect((await sessions.resolve(session))?.userId).toBe(owner);
		expect((await pending.resolve(pendingToken))?.userId).toBe(owner);
		expect(
			await oneTimeTokens.redeem({ token: toSecretToken(oneTime), purpose: "email_change" }),
		).toMatchObject({ userId: owner, payload: { newEmail: "mine@example.com" } });
		expect(refusals).toStrictEqual([]);
	});

	it("refuses a row under a key version the ring does not hold, naming that verdict", async () => {
		const token = await issuedSession(owner);
		await sql(`UPDATE ${schema}.session SET token_mac_key_version = 7 WHERE token_sha256 = $1`, [
			sha256Of(token),
		]);
		refusals = [];

		expect(await sessions.resolve(token)).toBeNull();
		expect(refusals).toStrictEqual([
			{
				userId: owner,
				occasion: "session_resolve",
				reason: "token_binding_mismatch",
				verdict: "key_version_unknown",
			},
		]);
	});

	it("does not let a throwing report change the refusal", async () => {
		const throwing = createSessionService({
			driver: migrated.connection,
			keys,
			schema,
			reportTokenBindingRefusal: () => {
				throw new Error("the alarm sink is down");
			},
		});
		const token = await issuedSession(owner);
		await sql(`UPDATE ${schema}.session SET factors = '{}' WHERE token_sha256 = $1`, [
			sha256Of(token),
		]);

		expect(await throwing.resolve(token)).toBeNull();
	});
});

describe("a row under an older key version (S-KEY-5)", () => {
	it("is rebound under the current version on a successful resolve", async () => {
		const ring = testKeyRing(2);
		const before = servicesUnder(ring.providerAt(1, [1]));
		const rotated = servicesUnder(ring.providerAt(2, [1, 2]));
		const retired = servicesUnder(ring.providerAt(2, [2]));
		const session = (
			await before.sessions.issue({ userId: owner, factors: ["password"], observed: NO_REQUEST })
		).token;
		const pendingToken = (
			await before.pending.begin({ userId: owner, factorsCompleted: ["password"] })
		).token;
		refusals = [];

		expect((await rotated.sessions.resolve(session))?.userId).toBe(owner);
		expect((await rotated.pending.resolve(pendingToken))?.userId).toBe(owner);
		const versions = await migrated.connection.query<{ version: number }>(
			`SELECT token_mac_key_version AS version FROM ${schema}.session WHERE token_sha256 = $1
			 UNION ALL
			 SELECT token_mac_key_version FROM ${schema}.pending_authentication WHERE token_sha256 = $2`,
			[sha256Of(session), sha256Of(pendingToken)],
		);

		expect(versions.map((row) => row.version)).toStrictEqual([2, 2]);
		expect((await retired.sessions.resolve(session))?.userId).toBe(owner);
		expect((await retired.pending.resolve(pendingToken))?.userId).toBe(owner);
		expect(refusals).toStrictEqual([]);
	});

	it("is refused once its version has left the ring without a rebinding", async () => {
		const ring = testKeyRing(2);
		const before = servicesUnder(ring.providerAt(1, [1]));
		const retired = servicesUnder(ring.providerAt(2, [2]));
		const session = (
			await before.sessions.issue({ userId: owner, factors: ["password"], observed: NO_REQUEST })
		).token;
		refusals = [];

		expect(await retired.sessions.resolve(session)).toBeNull();
		expect(refusals.map((refusal) => refusal.verdict)).toStrictEqual(["key_version_unknown"]);
	});
});

describe("the encoding the MAC is taken over (S-INTEG-9)", () => {
	function randomBinding(): TokenBinding {
		const pick = <T>(values: readonly T[]): T => values[byte() % values.length] as T;
		const purpose = pick([
			"session",
			"pending_authentication",
			"email_verify",
			"magic_link",
		] as const);
		const text = () => pick(["", ",", "a", "a,b", "b", "\u0000", "password", "totp"]);
		const factors = Array.from({ length: byte() % 4 }, text);
		return {
			purpose,
			ownerId: pick([null, "", "a", "ab"]),
			tokenSha256: randomBytes(byte() % 3),
			content:
				purpose === "email_verify" || purpose === "magic_link"
					? { payload: pick([null, {}, { a: "" }, { a: ",", b: [1, "x"] }, { "": null }]) }
					: purpose === "pending_authentication"
						? { factors, attempts: byte() % 3 }
						: { factors },
		};
	}

	function sameBinding(left: TokenBinding, right: TokenBinding): boolean {
		const comparable = (binding: TokenBinding) =>
			JSON.stringify({
				...binding,
				tokenSha256: Buffer.from(binding.tokenSha256).toString("hex"),
				content:
					"payload" in binding.content
						? canonicalPayloadOf(binding.content.payload)
						: binding.content,
			});
		return comparable(left) === comparable(right);
	}

	it("never encodes two different rows alike, over 1000 random pairs", () => {
		let collisions = 0;
		let differing = 0;
		for (let pair = 0; pair < 1000; pair += 1) {
			const left = randomBinding();
			const right = randomBinding();
			if (sameBinding(left, right)) {
				continue;
			}
			differing += 1;
			if (Buffer.from(encodeTokenBinding(left)).equals(Buffer.from(encodeTokenBinding(right)))) {
				collisions += 1;
			}
		}

		expect(differing).toBeGreaterThan(900);
		expect(collisions).toBe(0);
	});

	it("keeps a comma inside a factor name apart from two names", () => {
		const base = { purpose: "session", ownerId: "a", tokenSha256: new Uint8Array(32) } as const;

		expect(
			Buffer.from(encodeTokenBinding({ ...base, content: { factors: ["password,totp"] } })).equals(
				Buffer.from(encodeTokenBinding({ ...base, content: { factors: ["password", "totp"] } })),
			),
		).toBe(false);
	});

	it("reads a payload in the order jsonb returns its keys", () => {
		expect(canonicalPayloadOf({ b: 1, a: { d: 2, c: 3 } })).toBe(
			canonicalPayloadOf({ a: { c: 3, d: 2 }, b: 1 }),
		);
	});
});

describe("what the outside sees of a refused row (S-INTEG-9)", () => {
	let mounted: MountedAuth;

	beforeAll(async () => {
		mounted = await mountAuth("integtokenhttp", { keys });
	});

	afterAll(async () => {
		await dropSchema(mounted.connection, mounted.schema);
		await mounted.connection.close();
	});

	async function answerOf(request: Request) {
		const response = await mounted.handler(request);
		return {
			status: response.status,
			body: await response.text(),
			cookies: response.headers.getSetCookie(),
		};
	}

	it("answers a forged session exactly as an unknown one", async () => {
		const userId = await createUser(mounted.connection, mounted.schema);
		const forged = chosenToken();
		await mounted.connection.query(
			`INSERT INTO ${mounted.schema}.session
			   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors,
			    token_mac, token_mac_key_version)
			 VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days', '{password}', $3, 1)`,
			[userId, sha256Of(forged), randomBytes(32)],
		);
		const read = (token: string) =>
			requestTo("/session", {
				method: "GET",
				cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}`,
			});

		const refused = await answerOf(read(forged));

		expect(refused).toStrictEqual(await answerOf(read(chosenToken())));
		expect(refused.body).not.toContain(userId);
	});

	it("answers a forged magic link exactly as an unknown one", async () => {
		const userId = await createUser(mounted.connection, mounted.schema);
		const forged = chosenToken();
		await mounted.connection.query(
			`INSERT INTO ${mounted.schema}.one_time_token
			   (token_sha256, purpose, user_id, expires_at, token_mac, token_mac_key_version)
			 VALUES ($1, 'magic_link', $2, now() + interval '10 minutes', $3, 1)`,
			[sha256Of(forged), userId, randomBytes(32)],
		);
		const redeem = (token: string) => requestTo("/sign-in/magic-link/redeem", { body: { token } });

		const refused = await answerOf(redeem(forged));

		expect(refused.status).toBe(400);
		expect(refused).toStrictEqual(await answerOf(redeem(chosenToken())));
	});
});
