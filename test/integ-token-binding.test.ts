import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockAccountRow } from "../src/core/db/lock.js";
import { createSessionRepository } from "../src/core/db/repositories/session.js";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import { bookAttemptOn } from "../src/core/factor/pending/booking.js";
import {
	createPendingAuthenticationService,
	createSecondFactorCompletion,
	MAXIMUM_PENDING_ATTEMPTS,
	type PendingAuthenticationService,
	type PendingToken,
	toPendingToken,
	verifyUnderPendingAttemptLimit,
} from "../src/core/factor/pending/index.js";
import { createWebAuthnChallenges } from "../src/core/factor/webauthn/challenge.js";
import { redeemOrRefuse } from "../src/core/flows/artefact.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { ConcealedError, toVisibleFailure } from "../src/core/http/error-map.js";
import { encodeBase64Url } from "../src/core/keys/base64url.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { sessionRowsOn } from "../src/core/session/rows.js";
import { createSessionService, type SessionService } from "../src/core/session/service.js";
import {
	canonicalPayloadOf,
	encodeTokenBinding,
	type TokenBinding,
	type TokenBindingRefusal,
} from "../src/core/token/binding.js";
import { createOneTimeTokens, type OneTimeTokens } from "../src/core/token/one-time-token.js";
import { rebindTokenRowsUnderCurrentKey } from "../src/core/token/rebind.js";
import { toSecretToken } from "../src/core/token/secret-token.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import {
	actorOfTestUser,
	createUser,
	dropSchema,
	type MigratedSchema,
	openMigratedSchema,
} from "./db-fixtures.js";
import { openTestConnection } from "./db-postgres-connection.js";
import { decodingJsonb } from "./jsonb-decoding-driver.js";
import {
	aFreshEpochOtherThan,
	raiseEpochOf as raiseEpochTo,
	rebindSessionsOf,
	SESSION_FIXTURE_KEYS,
	sessionInsertFor,
} from "./session-fixtures.js";
import { failOneAttempt, testKeyRing } from "./totp-fixtures.js";

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
			sealing: "migrating",
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
			createOneTimeTokenRepository({ driver: decodingJsonb(migrated.connection), schema }),
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
});

afterAll(async () => {
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

describe("rows a writer inserts for a token of their own choosing (T-INTEG-9, 3/3)", () => {
	it("refuses a session row", async () => {
		const victim = await createUser(migrated.connection, schema);
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
		const victim = await createUser(migrated.connection, schema);
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
		const victim = await createUser(migrated.connection, schema);
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

describe("real rows a writer rewrites (T-INTEG-9)", () => {
	it("refuses a session moved to another account", async () => {
		const owner = await createUser(migrated.connection, schema);
		const victim = await createUser(migrated.connection, schema);
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
		const owner = await createUser(migrated.connection, schema);
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
		const owner = await createUser(migrated.connection, schema);
		const token = await issuedSession(owner);
		await sql(`UPDATE ${schema}.session SET factors = '{password,totp}' WHERE token_sha256 = $1`, [
			sha256Of(token),
		]);
		refusals = [];

		expect(await sessions.resolve(token)).toBeNull();
		expectOneRefusal("session_resolve", owner);
	});

	it("refuses a pending authentication moved to another account", async () => {
		const owner = await createUser(migrated.connection, schema);
		const victim = await createUser(migrated.connection, schema);
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
		const owner = await createUser(migrated.connection, schema);
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
		const owner = await createUser(migrated.connection, schema);
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
		const owner = await createUser(migrated.connection, schema);
		const victim = await createUser(migrated.connection, schema);
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

	it("refuses a one-time token moved into the pending table", async () => {
		const owner = await createUser(migrated.connection, schema);
		const token = await issuedOneTime(owner);
		await sql(
			`WITH moved AS (DELETE FROM ${schema}.one_time_token WHERE token_sha256 = $1 RETURNING *)
			 INSERT INTO ${schema}.pending_authentication
			   (token_sha256, user_id, factors_completed, expires_at, token_mac, token_mac_key_version)
			 SELECT token_sha256, user_id, '{password}', now() + interval '5 minutes',
			    token_mac, token_mac_key_version FROM moved`,
			[sha256Of(token)],
		);
		refusals = [];

		expect(await pending.resolve(toPendingToken(token))).toBeNull();
		expectOneRefusal("factor_check", owner);
	});

	it("refuses a one-time token given another purpose", async () => {
		const owner = await createUser(migrated.connection, schema);
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
		const owner = await createUser(migrated.connection, schema);
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
	it("refuses a row whose counter a writer reset after four failed attempts", async () => {
		const owner = await createUser(migrated.connection, schema);
		const token = await issuedPending(owner);
		for (let attempt = 1; attempt < MAXIMUM_PENDING_ATTEMPTS; attempt += 1) {
			await failOneAttempt(pending, token);
		}
		expect((await pending.resolve(token))?.pending.attemptsRemaining).toBe(1);
		await sql(`UPDATE ${schema}.pending_authentication SET attempts = 0 WHERE token_sha256 = $1`, [
			sha256Of(token),
		]);
		refusals = [];

		expect(await pending.resolve(token)).toBeNull();
		expect(await failOneAttempt(pending, token)).toStrictEqual({ outcome: "missing" });
		expect(refusals.map((refusal) => refusal.occasion)).toStrictEqual([
			"factor_check",
			"factor_check",
		]);
	});

	it("rebinds the row on every attempt, so the counted row still verifies", async () => {
		const owner = await createUser(migrated.connection, schema);
		const token = await issuedPending(owner);
		refusals = [];
		for (let attempt = 1; attempt < MAXIMUM_PENDING_ATTEMPTS; attempt += 1) {
			expect(await failOneAttempt(pending, token)).toStrictEqual({
				outcome: "attempts_remain",
				attemptsRemaining: MAXIMUM_PENDING_ATTEMPTS - attempt,
			});
			expect((await pending.resolve(token))?.pending.attemptsRemaining).toBe(
				MAXIMUM_PENDING_ATTEMPTS - attempt,
			);
		}

		expect(await failOneAttempt(pending, token)).toStrictEqual({ outcome: "exhausted" });
		expect(await pending.resolve(token)).toBeNull();
		expect(refusals).toStrictEqual([]);
	});

	it("books two attempts that resolved the same row each once, without an alarm", async () => {
		const owner = await createUser(migrated.connection, schema);
		const token = await issuedPending(owner);
		refusals = [];

		const [first, second] = await Promise.all([
			bookAttemptOn(pending, token),
			bookAttemptOn(pending, token),
		]);

		expect([first?.outcome, second?.outcome]).toStrictEqual(["booked", "booked"]);
		expect((await pending.resolve(token))?.pending.attemptsRemaining).toBe(
			MAXIMUM_PENDING_ATTEMPTS - 2,
		);
		expect(refusals).toStrictEqual([]);
	});

	it("answers a refused booking exactly as a missing pending row, outwardly", async () => {
		const owner = await createUser(migrated.connection, schema);
		const token = await issuedPending(owner);
		await sql(`UPDATE ${schema}.pending_authentication SET attempts = 3 WHERE token_sha256 = $1`, [
			sha256Of(token),
		]);
		const outwardOf = (work: Promise<unknown>) =>
			work.then(
				() => "succeeded",
				(failure: unknown) => {
					const visible = toVisibleFailure(failure);
					return { code: visible.error.code, status: visible.error.httpStatus };
				},
			);
		const evaluate = () => Promise.reject(new Error("a wrong code"));

		const refused = await outwardOf(verifyUnderPendingAttemptLimit(pending, token, evaluate));
		const missing = await outwardOf(
			verifyUnderPendingAttemptLimit(pending, toPendingToken(chosenToken()), evaluate),
		);

		expect(refused).toStrictEqual(missing);
		expect(refused).toStrictEqual({ code: "invalid_pending_authentication", status: 401 });
	});

	it("answers a booking on a consumed or expired row as a missing row, without an alarm", async () => {
		const owner = await createUser(migrated.connection, schema);
		const consumed = await issuedPending(owner);
		const expired = await issuedPending(owner);
		await pending.consume(consumed);
		await sql(
			`UPDATE ${schema}.pending_authentication SET expires_at = now() - interval '1 second'
			 WHERE token_sha256 = $1`,
			[sha256Of(expired)],
		);
		refusals = [];

		expect((await bookAttemptOn(pending, consumed)).outcome).toBe("missing");
		expect((await bookAttemptOn(pending, expired)).outcome).toBe("missing");
		expect(refusals).toStrictEqual([]);
	});
});

describe("what a row the library wrote keeps (S-INTEG-9)", () => {
	it("resolves an untouched session, pending authentication and one-time token", async () => {
		const owner = await createUser(migrated.connection, schema);
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
		const owner = await createUser(migrated.connection, schema);
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
		const owner = await createUser(migrated.connection, schema);
		const throwing = createSessionService({
			sealing: "migrating",
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
	it("rebinds a session on a resolve and a pending row only on its booking (E-3149)", async () => {
		const owner = await createUser(migrated.connection, schema);
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
		const versionsOf = () =>
			migrated.connection.query<{ version: number }>(
				`SELECT token_mac_key_version AS version FROM ${schema}.session WHERE token_sha256 = $1
			 UNION ALL
			 SELECT token_mac_key_version FROM ${schema}.pending_authentication WHERE token_sha256 = $2`,
				[sha256Of(session), sha256Of(pendingToken)],
			);

		expect((await versionsOf()).map((row) => row.version)).toStrictEqual([2, 1]);
		expect((await bookAttemptOn(rotated.pending, pendingToken)).outcome).toBe("booked");
		expect((await versionsOf()).map((row) => row.version)).toStrictEqual([2, 2]);
		expect((await retired.sessions.resolve(session))?.userId).toBe(owner);
		expect((await retired.pending.resolve(pendingToken))?.userId).toBe(owner);
		expect(refusals).toStrictEqual([]);
	});

	it("is refused once its version has left the ring without a rebinding", async () => {
		const owner = await createUser(migrated.connection, schema);
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

describe("the session epoch a session MAC binds (S-INTEG-9)", () => {
	async function sealedAccount(): Promise<string> {
		const userId = await createUser(migrated.connection, schema);
		await sql(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
			 VALUES ($1, 1, $2, 1)`,
			[userId, randomBytes(32)],
		);
		return userId;
	}

	//the seal branch raises the epoch with a reseal, and this stands in for it
	async function raiseEpochOf(userId: string): Promise<void> {
		await raiseEpochTo(migrated.connection, schema, userId);
	}

	async function savedRow(sessionId: string): Promise<Record<string, unknown>> {
		const [row] = await migrated.connection.query<Record<string, unknown>>(
			`SELECT * FROM ${schema}.session WHERE id = $1`,
			[sessionId],
		);
		if (row === undefined) {
			throw new Error("the issued session left no row to save");
		}
		return row;
	}

	async function writtenBack(row: Record<string, unknown>): Promise<void> {
		const columns = Object.keys(row);
		await sql(
			`INSERT INTO ${schema}.session (${columns.join(", ")})
			 VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
			columns.map((column) => row[column]),
		);
	}

	it("refuses a session issued under an older epoch than the account's", async () => {
		const userId = await sealedAccount();
		const issued = await sessions.issue({ userId, factors: ["password"], observed: NO_REQUEST });
		await raiseEpochOf(userId);
		refusals = [];

		expect(await sessions.resolve(issued.token)).toBeNull();
		expectOneRefusal("session_resolve", userId);
	});

	it("refuses a row written back after every session was deleted and the epoch raised", async () => {
		const userId = await sealedAccount();
		const issued = await sessions.issue({ userId, factors: ["password"], observed: NO_REQUEST });
		const row = await savedRow(issued.session.id);
		await sql(`DELETE FROM ${schema}.session WHERE user_id = $1`, [userId]);
		await raiseEpochOf(userId);
		await writtenBack(row);
		refusals = [];

		expect(await sessions.resolve(issued.token)).toBeNull();
		const fresh = await sessions.issue({ userId, factors: ["password"], observed: NO_REQUEST });
		expect((await sessions.resolve(fresh.token))?.userId).toBe(userId);
		expectOneRefusal("session_resolve", userId);
	});

	it("binds an account without a seal row to epoch 1 and checks it against 1", async () => {
		const userId = await createUser(migrated.connection, schema);
		const issued = await sessions.issue({ userId, factors: ["password"], observed: NO_REQUEST });
		refusals = [];

		expect((await sessions.resolve(issued.token))?.userId).toBe(userId);
		await sql(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version, session_epoch)
			 VALUES ($1, 1, $2, 1, $3)`,
			[userId, randomBytes(32), aFreshEpochOtherThan(1)],
		);
		expect(await sessions.resolve(issued.token)).toBeNull();
		expectOneRefusal("session_resolve", userId);
	});

	it('refuses an account without a seal row in "required", issuing and resolving alike', async () => {
		const required = createSessionService({
			driver: migrated.connection,
			keys,
			sealing: "required",
			schema,
			reportTokenBindingRefusal: report,
		});
		const unsealed = await createUser(migrated.connection, schema);
		const issuedWhileMigrating = await sessions.issue({
			userId: unsealed,
			factors: ["password"],
			observed: NO_REQUEST,
		});
		const sealed = await sealedAccount();
		refusals = [];

		await expect(
			required.issue({ userId: unsealed, factors: ["password"], observed: NO_REQUEST }),
		).rejects.toThrow(ConcealedError);
		expect(await required.resolve(issuedWhileMigrating.token)).toBeNull();
		const issued = await required.issue({
			userId: sealed,
			factors: ["password"],
			observed: NO_REQUEST,
		});
		expect((await required.resolve(issued.token))?.userId).toBe(sealed);
		expect(refusals).toStrictEqual([]);
	});

	it("does not lift a session into a newer epoch when it rebinds", async () => {
		const ring = testKeyRing(2);
		const before = servicesUnder(ring.providerAt(1, [1]));
		const rotated = servicesUnder(ring.providerAt(2, [1, 2]));
		const userId = await sealedAccount();
		const issued = await before.sessions.issue({
			userId,
			factors: ["password"],
			observed: NO_REQUEST,
		});
		await raiseEpochOf(userId);

		expect(await rotated.sessions.resolve(issued.token)).toBeNull();
		const [stored] = await migrated.connection.query<{ version: number }>(
			`SELECT token_mac_key_version AS version FROM ${schema}.session WHERE id = $1`,
			[issued.session.id],
		);
		expect(stored?.version).toBe(1);
	});

	it("writes no row when the epoch it bound moved before the insert", async () => {
		const userId = await sealedAccount();
		const repository = createSessionRepository({
			keys: SESSION_FIXTURE_KEYS,
			driver: migrated.connection,
			schema,
		});
		const token = chosenToken();

		await expect(
			repository.insertSession(
				sessionInsertFor(userId, {
					tokenHash: sha256Of(token),
					bindUnder: async () => {
						await raiseEpochOf(userId);
						return { tokenMac: new Uint8Array(32), tokenMacKeyVersion: 1 };
					},
				}),
			),
		).rejects.toThrow(ConcealedError);
		const [row] = await migrated.connection.query<{ present: number }>(
			`SELECT count(*)::int AS present FROM ${schema}.session WHERE user_id = $1`,
			[userId],
		);
		expect(row?.present).toBe(0);
	});
});

describe("the session lists of an account (S-INTEG-9)", () => {
	it("lists, shows to a plugin and announces only the rows the library wrote", async () => {
		const userId = await createUser(migrated.connection, schema);
		const own = await sessions.issue({ userId, factors: ["password"], observed: NO_REQUEST });
		const resolved = await sessions.resolve(own.token);
		if (resolved === null) {
			throw new Error("the issued session did not resolve");
		}
		await sql(
			`INSERT INTO ${schema}.session
			   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors,
			    token_mac, token_mac_key_version)
			 VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days', '{password,totp}',
			    $3, 1)`,
			[userId, sha256Of(chosenToken()), randomBytes(32)],
		);
		const rows = sessionRowsOn(sessions, migrated.connection);
		const pluginRows = createSessionRepository({
			driver: migrated.connection,
			schema,
			keys,
			sealing: "migrating",
			reportTokenBindingRefusal: report,
		});
		refusals = [];

		expect((await sessions.list({ resolved })).map((session) => session.id)).toStrictEqual([
			own.session.id,
		]);
		expect(
			(await pluginRows.listSessionsOfUser({ userId })).map((session) => session.id),
		).toStrictEqual([own.session.id]);
		expect(await rows.listEverySessionIdOwnedBy({ actor: actorOfTestUser(userId) })).toStrictEqual([
			own.session.id,
		]);
		expect(refusals.map((refusal) => refusal.occasion)).toStrictEqual([
			"session_resolve",
			"session_resolve",
			"session_resolve",
		]);
	});
});

describe("further rewrites of real rows (S-INTEG-9)", () => {
	it("refuses two sessions of one account whose MACs were swapped", async () => {
		const userId = await createUser(migrated.connection, schema);
		const first = await issuedSession(userId);
		const second = await issuedSession(userId);
		await sql(
			`UPDATE ${schema}.session x SET token_mac = y.token_mac FROM ${schema}.session y
			 WHERE x.token_sha256 = $1 AND y.token_sha256 = $2`,
			[sha256Of(first), sha256Of(second)],
		);
		refusals = [];

		expect(await sessions.resolve(first)).toBeNull();
		expectOneRefusal("session_resolve", userId);
	});

	it("refuses a key version far past the ring, as an unknown one", async () => {
		const userId = await createUser(migrated.connection, schema);
		const token = await issuedSession(userId);
		await sql(
			`UPDATE ${schema}.session SET token_mac_key_version = 2147483647 WHERE token_sha256 = $1`,
			[sha256Of(token)],
		);
		refusals = [];

		expect(await sessions.resolve(token)).toBeNull();
		expect(refusals.map((refusal) => refusal.verdict)).toStrictEqual(["key_version_unknown"]);
	});

	it("refuses a session whose one factor was written twice", async () => {
		const userId = await createUser(migrated.connection, schema);
		const token = await issuedSession(userId);
		await sql(
			`UPDATE ${schema}.session SET factors = '{password,password}' WHERE token_sha256 = $1`,
			[sha256Of(token)],
		);
		refusals = [];

		expect(await sessions.resolve(token)).toBeNull();
		expectOneRefusal("session_resolve", userId);
	});
});

describe("a pending row written back with its older MAC (section 3.18, The limits)", () => {
	//this pins a named limit: a consistent older version of the row verifies (E-3143)
	it("gives the writer back the budget of the version written back", async () => {
		const userId = await createUser(migrated.connection, schema);
		const token = await issuedPending(userId);
		const [saved] = await migrated.connection.query<{ mac: Buffer; version: number }>(
			`SELECT token_mac AS mac, token_mac_key_version AS version
			 FROM ${schema}.pending_authentication WHERE token_sha256 = $1`,
			[sha256Of(token)],
		);
		for (let attempt = 1; attempt < MAXIMUM_PENDING_ATTEMPTS; attempt += 1) {
			await failOneAttempt(pending, token);
		}
		await sql(
			`UPDATE ${schema}.pending_authentication
			 SET attempts = 0, token_mac = $2, token_mac_key_version = $3 WHERE token_sha256 = $1`,
			[sha256Of(token), saved?.mac, saved?.version],
		);
		refusals = [];

		expect((await pending.resolve(token))?.pending.attemptsRemaining).toBe(
			MAXIMUM_PENDING_ATTEMPTS,
		);
		expect(refusals).toStrictEqual([]);
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
						: { factors, sessionEpoch: byte() % 3, createdAtMicros: byte() % 3 },
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
			Buffer.from(
				encodeTokenBinding({
					...base,
					content: { factors: ["password,totp"], sessionEpoch: 1, createdAtMicros: 0 },
				}),
			).equals(
				Buffer.from(
					encodeTokenBinding({
						...base,
						content: { factors: ["password", "totp"], sessionEpoch: 1, createdAtMicros: 0 },
					}),
				),
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

describe("a one-time token row whose payload is a jsonb value no issue writes (S-INTEG-9)", () => {
	async function insertedWithPayload(userId: string, token: string, payloadJson: string) {
		await sql(
			`INSERT INTO ${schema}.one_time_token
			   (token_sha256, purpose, user_id, payload, expires_at, token_mac, token_mac_key_version)
			 VALUES ($1, 'magic_link', $2, $3::jsonb, now() + interval '1 hour', $4, 1)`,
			[sha256Of(token), userId, payloadJson, randomBytes(32)],
		);
	}

	it.each(['"not json"', "7", "true", '"{}"'])(
		"is answered as a missing row with one alarm when its payload is %s",
		async (payloadJson) => {
			const userId = await createUser(migrated.connection, schema);
			const token = chosenToken();
			await insertedWithPayload(userId, token, payloadJson);
			refusals = [];

			const redeemed = await oneTimeTokens
				.redeem({ token: toSecretToken(token), purpose: "magic_link" })
				.catch((failure: unknown) => failure);

			expect(redeemed).toBeNull();
			expectOneRefusal("token_redemption", userId);
		},
	);

	it("is answered the same through a driver that hands jsonb back as text", async () => {
		const textual = createOneTimeTokens(
			createOneTimeTokenRepository({ driver: migrated.connection, schema }),
			{ keys, reportTokenBindingRefusal: report },
		);
		const userId = await createUser(migrated.connection, schema);
		const token = chosenToken();
		await insertedWithPayload(userId, token, '"not json"');
		refusals = [];

		const redeemed = await textual
			.redeem({ token: toSecretToken(token), purpose: "magic_link" })
			.catch((failure: unknown) => failure);

		expect(redeemed).toBeNull();
		expectOneRefusal("token_redemption", userId);
	});

	it("is refused, not thrown on, by the maintenance pass, which goes on past it", async () => {
		const ring = testKeyRing(2);
		const before = servicesUnder(ring.providerAt(1, [1]));
		const userId = await createUser(migrated.connection, schema);
		const genuine = await before.oneTimeTokens.issue({ purpose: "email_verify", userId });
		await insertedWithPayload(userId, chosenToken(), '"not json"');
		await sql(`UPDATE ${schema}.one_time_token SET token_mac_key_version = 1 WHERE user_id = $1`, [
			userId,
		]);
		refusals = [];

		const pass = await rebindTokenRowsUnderCurrentKey({
			driver: decodingJsonb(migrated.connection),
			schema,
			keys: ring.providerAt(2, [1, 2]),
			sealing: "migrating",
			table: "one_time_token",
			batchSize: 1,
			reportTokenBindingRefusal: report,
		});
		const redeemed = await servicesUnder(ring.providerAt(2, [2])).oneTimeTokens.redeem({
			token: genuine.token,
			purpose: "email_verify",
		});

		expect(refusals.filter((refusal) => refusal.userId === userId)).toHaveLength(1);
		expect(pass.refused).toBeGreaterThanOrEqual(1);
		expect(redeemed?.userId).toBe(userId);
	});
});

describe("an owner id in another spelling of the same uuid (S-INTEG-9)", () => {
	const SPELLINGS: readonly [string, (userId: string) => string][] = [
		["upper case", (userId) => userId.toUpperCase()],
		["braces", (userId) => `{${userId}}`],
		["no hyphens", (userId) => userId.replaceAll("-", "")],
	];

	it.each(SPELLINGS)("binds a session the account can still use, in %s", async (_name, spell) => {
		const userId = await createUser(migrated.connection, schema);

		const issued = await sessions.issue({
			userId: spell(userId),
			factors: ["password"],
			observed: NO_REQUEST,
		});

		expect((await sessions.resolve(issued.token))?.userId).toBe(userId);
	});

	it.each(SPELLINGS)(
		"binds a one-time token the account can still redeem, in %s",
		async (_name, spell) => {
			const userId = await createUser(migrated.connection, schema);

			const { token } = await oneTimeTokens.issue({ purpose: "magic_link", userId: spell(userId) });

			expect((await oneTimeTokens.redeem({ token, purpose: "magic_link" }))?.userId).toBe(userId);
		},
	);

	it.each(SPELLINGS)(
		"binds a pending authentication the account can still use, in %s",
		async (_name, spell) => {
			const userId = await createUser(migrated.connection, schema);

			const { token } = await pending.begin({
				userId: spell(userId),
				factorsCompleted: ["password"],
			});

			expect((await pending.resolve(token))?.userId).toBe(userId);
		},
	);

	it("still encodes two different owners apart", () => {
		const of = (ownerId: string) =>
			Buffer.from(
				encodeTokenBinding({
					purpose: "session",
					ownerId,
					tokenSha256: new Uint8Array(32),
					content: { factors: [], sessionEpoch: 1, createdAtMicros: 0 },
				}),
			).toString("hex");

		expect(of("0F0E0D0C-0B0A-4908-8706-050403020100")).toBe(
			of("0f0e0d0c-0b0a-4908-8706-050403020100"),
		);
		expect(of("0f0e0d0c-0b0a-4908-8706-050403020101")).not.toBe(
			of("0f0e0d0c-0b0a-4908-8706-050403020100"),
		);
	});
});

describe("a forged session row and the revocations that remove it (S-INTEG-9)", () => {
	async function forgedSessionOf(userId: string): Promise<void> {
		await sql(
			`INSERT INTO ${schema}.session
			   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors,
			    token_mac, token_mac_key_version)
			 VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days', '{password}', $3, 1)`,
			[userId, sha256Of(chosenToken()), randomBytes(32)],
		);
	}

	it("is removed by a mass revocation and not counted, with one report", async () => {
		const userId = await createUser(migrated.connection, schema);
		await issuedSession(userId);
		await forgedSessionOf(userId);
		refusals = [];

		const revoked = await createSessionRepository({
			driver: migrated.connection,
			schema,
			keys,
			sealing: "migrating",
			reportTokenBindingRefusal: report,
		}).deleteEverySessionOwnedBy({ actor: actorOfTestUser(userId) });
		const [left] = await migrated.connection.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM ${schema}.session WHERE user_id = $1`,
			[userId],
		);

		expect(revoked).toBe(1);
		expect(left?.n).toBe(0);
		expectOneRefusal("session_resolve", userId);
	});

	it("is not counted among the sessions a password change revoked", async () => {
		const mountedAuth = await mountAuth("integforgedcount", {
			keys,
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		});
		try {
			const PASSWORD = "correct-horse-battery-staple";
			const signedUp = await mountedAuth.handler(
				requestTo("/sign-up", { body: { email: "forged-count@example.com", password: PASSWORD } }),
			);
			const signedUpUserId = ((await signedUp.json()) as { user: { id: string } }).user.id;
			const cookie = /__Host-velve_session=[^;]*/.exec(
				signedUp.headers.get("Set-Cookie") ?? "",
			)?.[0];
			await mountedAuth.connection.query(
				`INSERT INTO ${mountedAuth.schema}.session
				   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors,
				    token_mac, token_mac_key_version)
				 VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days', '{password}', $3, 1)`,
				[signedUpUserId, sha256Of(chosenToken()), randomBytes(32)],
			);

			const answer = await mountedAuth.handler(
				requestTo("/password/change", {
					body: { currentPassword: PASSWORD, newPassword: "a-different-password-entirely" },
					...(cookie === undefined ? {} : { cookie }),
				}),
			);

			expect(answer.status).toBe(200);
			expect(
				((await answer.json()) as { revokedOtherSessionsCount: number }).revokedOtherSessionsCount,
			).toBe(0);
		} finally {
			await dropSchema(mountedAuth.connection, mountedAuth.schema);
			await mountedAuth.connection.close();
		}
	});

	it("names its owner but is no library row to a plugin's revocation", async () => {
		const userId = await createUser(migrated.connection, schema);
		await forgedSessionOf(userId);
		const [row] = await migrated.connection.query<{ id: string }>(
			`SELECT id FROM ${schema}.session WHERE user_id = $1`,
			[userId],
		);

		const owner = await createSessionRepository({
			driver: migrated.connection,
			schema,
			keys,
			sealing: "migrating",
		}).findOwnerOfSession({ sessionId: row?.id ?? "" });

		expect(owner).toStrictEqual({ userId, libraryRow: false });
	});
});

describe("a factor check that meets a broken state (section 3.18 point 3)", () => {
	class BrokenState extends Error {}

	it("books the attempt and removes the row at the budget, exactly as a rejected factor does", async () => {
		const userId = await createUser(migrated.connection, schema);
		const token = await issuedPending(userId);
		const answers: unknown[] = [];

		for (let attempt = 0; attempt < MAXIMUM_PENDING_ATTEMPTS; attempt += 1) {
			answers.push(
				await verifyUnderPendingAttemptLimit(pending, token, async () => {
					throw new BrokenState("the account's seal does not match");
				}).catch((failure: unknown) =>
					failure instanceof BrokenState ? "broken" : (failure as { code?: string }).code,
				),
			);
		}
		const [left] = await migrated.connection.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM ${schema}.pending_authentication WHERE user_id = $1`,
			[userId],
		);

		expect(answers).toStrictEqual([
			...Array.from({ length: MAXIMUM_PENDING_ATTEMPTS - 1 }, () => "broken"),
			"too_many_factor_attempts",
		]);
		expect(left?.n).toBe(0);
	});
});

describe("the creation time a session MAC binds (section 3.18 point 3)", () => {
	it("refuses a stale session whose created_at a writer moved forward, with one report", async () => {
		const userId = await createUser(migrated.connection, schema);
		const token = await issuedSession(userId);
		await sql(
			`UPDATE ${schema}.session SET created_at = created_at - interval '1 hour' WHERE token_sha256 = $1`,
			[sha256Of(token)],
		);
		await rebindSessionsOf(migrated.connection, schema, keys, { userId });
		expect((await sessions.resolve(token))?.userId).toBe(userId);
		await sql(`UPDATE ${schema}.session SET created_at = now() WHERE token_sha256 = $1`, [
			sha256Of(token),
		]);
		refusals = [];

		expect(await sessions.resolve(token)).toBeNull();
		expectOneRefusal("session_resolve", userId);
	});

	it("binds the creation time the row stores, to the microsecond", async () => {
		const userId = await createUser(migrated.connection, schema);
		const token = await issuedSession(userId);
		await sql(
			`UPDATE ${schema}.session SET created_at = created_at + interval '1 microsecond'
			 WHERE token_sha256 = $1`,
			[sha256Of(token)],
		);
		refusals = [];

		expect(await sessions.resolve(token)).toBeNull();
		expectOneRefusal("session_resolve", userId);
	});
});

describe("a one-time token row that names no account (S-TOKEN-4, S-INTEG-9)", () => {
	it("is answered as no row whether genuine or forged, and only the forged one is reported, without an owner", async () => {
		const cover = await oneTimeTokens.issue({
			purpose: "password_reset",
			userId: null,
			serialisedOn: "nobody@example.com",
		});
		const forged = chosenToken();
		await sql(
			`INSERT INTO ${schema}.one_time_token
			   (token_sha256, purpose, user_id, payload, expires_at, token_mac, token_mac_key_version)
			 VALUES ($1, 'password_reset', NULL, NULL, now() + interval '1 hour', $2, 1)`,
			[sha256Of(forged), randomBytes(32)],
		);
		refusals = [];

		expect(
			await oneTimeTokens.redeem({ token: cover.token, purpose: "password_reset" }),
		).toBeNull();
		expect(refusals).toStrictEqual([]);
		expect(
			await oneTimeTokens.redeem({ token: toSecretToken(forged), purpose: "password_reset" }),
		).toBeNull();
		expect(refusals).toStrictEqual([
			{
				userId: null,
				occasion: "token_redemption",
				reason: "token_binding_mismatch",
				verdict: "mismatch",
			},
		]);
	});
});

describe("a WebAuthn challenge row (section 3.18 point 3)", () => {
	function challengesUnder(provider: KeyProvider) {
		return createWebAuthnChallenges({
			driver: migrated.connection,
			schema,
			keys: provider,
			reportTokenBindingRefusal: report,
		});
	}

	async function savedChallenge(challengeToken: string) {
		const [row] = await migrated.connection.query<Record<string, unknown>>(
			`SELECT challenge_sha256, purpose, user_id, token_mac, token_mac_key_version
			 FROM ${schema}.webauthn_challenge WHERE challenge_sha256 = $1`,
			[sha256Of(challengeToken)],
		);
		return row;
	}

	it("is consumed once, and refused with one report when a writer inserts it again", async () => {
		const userId = await createUser(migrated.connection, schema);
		const challenges = challengesUnder(keys);
		const { challengeToken } = await challenges.issue({ purpose: "register", userId });
		const saved = await savedChallenge(challengeToken);
		expect(await challenges.consume({ challengeToken, purpose: "register", userId })).toBe(true);
		await sql(
			`INSERT INTO ${schema}.webauthn_challenge
			   (challenge_sha256, purpose, user_id, expires_at, token_mac, token_mac_key_version)
			 VALUES ($1, $2, $3, now() + interval '5 minutes', $4, $5)`,
			[saved?.challenge_sha256, saved?.purpose, saved?.user_id, randomBytes(32), 1],
		);
		refusals = [];

		expect(await challenges.consume({ challengeToken, purpose: "register", userId })).toBe(false);
		expectOneRefusal("factor_check", userId);
	});

	it("is refused when a writer moves it to the other ceremony, and reports no owner for a discoverable one", async () => {
		const challenges = challengesUnder(keys);
		const { challengeToken } = await challenges.issue({ purpose: "register", userId: null });
		await sql(
			`UPDATE ${schema}.webauthn_challenge SET purpose = 'authenticate' WHERE challenge_sha256 = $1`,
			[sha256Of(challengeToken)],
		);
		refusals = [];

		expect(
			await challenges.consume({ challengeToken, purpose: "authenticate", userId: null }),
		).toBe(false);
		expect(refusals).toStrictEqual([
			{
				userId: null,
				occasion: "factor_check",
				reason: "token_binding_mismatch",
				verdict: "mismatch",
			},
		]);
	});

	it("is refused when a writer inserts one for a challenge of their own choosing", async () => {
		const userId = await createUser(migrated.connection, schema);
		const challengeToken = chosenToken();
		await sql(
			`INSERT INTO ${schema}.webauthn_challenge
			   (challenge_sha256, purpose, user_id, expires_at, token_mac, token_mac_key_version)
			 VALUES ($1, 'authenticate', $2, now() + interval '5 minutes', $3, 1)`,
			[sha256Of(challengeToken), userId, randomBytes(32)],
		);
		refusals = [];

		expect(
			await challengesUnder(keys).consume({ challengeToken, purpose: "authenticate", userId }),
		).toBe(false);
		expectOneRefusal("factor_check", userId);
	});
});

describe("the anchor's place on a consuming path: after the consumption, before the account lock (section 3.18)", () => {
	async function lockIsFree(userId: string): Promise<boolean> {
		const probe = await openTestConnection();
		try {
			await probe.query("BEGIN", []);
			return await probe
				.query(`SELECT 1 FROM ${schema}.user WHERE id = $1 FOR NO KEY UPDATE NOWAIT`, [userId])
				.then(() => true)
				.catch(() => false);
		} finally {
			await probe.query("ROLLBACK", []).catch(() => undefined);
			await probe.close();
		}
	}

	it("tells a redemption's hook the owner once the row is consumed and before the account is locked", async () => {
		const userId = await createUser(migrated.connection, schema);
		const token = await issuedOneTime(userId);
		const told: { owner: string; free: boolean }[] = [];

		await migrated.connection.transaction(async (tx) => {
			const redeemed = await redeemOrRefuse(
				tx,
				{
					schema,
					keys,
					beforeLockingTheOwnerOf: async (owner) => {
						told.push({ owner, free: await lockIsFree(owner) });
					},
				},
				{ token, purpose: "email_verify" },
			);
			await lockAccountRow(tx, schema, redeemed.userId);
		});

		expect(told).toStrictEqual([{ owner: userId, free: true }]);
	});

	it("leaves the row redeemable when the hook refuses, since its transaction rolls back", async () => {
		const userId = await createUser(migrated.connection, schema);
		const token = await issuedOneTime(userId);

		await expect(
			migrated.connection.transaction((tx) =>
				redeemOrRefuse(
					tx,
					{
						schema,
						keys,
						beforeLockingTheOwnerOf: async () => {
							throw new Error("the anchor refuses this account");
						},
					},
					{ token, purpose: "email_verify" },
				),
			),
		).rejects.toThrow("the anchor refuses this account");
		expect(
			(await oneTimeTokens.redeem({ token: toSecretToken(token), purpose: "email_verify" }))
				?.userId,
		).toBe(userId);
	});

	it("tells the second-factor completion's hook the owner before the session takes the account lock", async () => {
		const userId = await createUser(migrated.connection, schema);
		const token = await issuedPending(userId);
		const told: { owner: string; free: boolean }[] = [];
		const completion = createSecondFactorCompletion({
			driver: migrated.connection,
			keys,
			sealing: "migrating",
			schema,
			beforeLockingTheOwnerOf: async (owner) => {
				told.push({ owner, free: await lockIsFree(owner) });
			},
		});

		await completion.complete({
			pendingToken: token,
			factor: "totp",
			presentedSessionToken: null,
			observed: NO_REQUEST,
		});

		expect(told).toStrictEqual([{ owner: userId, free: true }]);
	});
});
