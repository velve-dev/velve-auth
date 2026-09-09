import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createPendingAuthenticationRepository,
	createPendingAuthenticationService,
	createPendingToken,
	hashPendingToken,
	MAXIMUM_PENDING_ATTEMPTS,
	PENDING_CALLER_ROUTES,
	PENDING_LIFETIME_IN_SECONDS,
	type PendingAuthenticationService,
	type PendingToken,
	toPendingToken,
} from "../src/core/factor/pending/index.js";
import { ConcealedError } from "../src/core/http/error-map.js";
import { decodeBase64Url } from "../src/core/keys/base64url.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

let connection: TestConnection;
let schema: string;
let pending: PendingAuthenticationService;
let userId: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("pending");
	connection = migrated.connection;
	schema = migrated.schema;
	pending = createPendingAuthenticationService({ driver: connection, schema });
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

beforeEach(async () => {
	userId = await createUser(connection, schema);
});

async function countRows(): Promise<number> {
	const [row] = await connection.query<{ present: number }>(
		`SELECT count(*)::int AS present FROM ${schema}.pending_authentication WHERE user_id = $1`,
		[userId],
	);
	return row?.present ?? -1;
}

async function enrolTotp(confirmed: boolean): Promise<void> {
	await connection.query(
		`INSERT INTO ${schema}.totp_credential (user_id, secret_enc, key_version, confirmed_at)
		 VALUES ($1, $2, 1, ${confirmed ? "now()" : "NULL"})`,
		[userId, randomBytes(48)],
	);
}

async function enrolWebauthn(): Promise<void> {
	await connection.query(
		`INSERT INTO ${schema}.webauthn_credential
		   (user_id, credential_id, public_key, backup_eligible, backup_state, user_verified_at_registration)
		 VALUES ($1, $2, $3, false, false, true)`,
		[userId, randomBytes(32), randomBytes(64)],
	);
}

async function enrolRecoveryCodes(count: number): Promise<void> {
	for (let index = 0; index < count; index += 1) {
		await connection.query(
			`INSERT INTO ${schema}.recovery_code (user_id, code_hmac) VALUES ($1, $2)`,
			[userId, randomBytes(32)],
		);
	}
}

async function begin(): Promise<PendingToken> {
	const issued = await pending.begin({
		userId,
		factorsCompleted: ["password"],
	});
	return issued.token;
}

describe("the state between password and second factor (3.6, S-FIX-4)", () => {
	it("writes exactly one row and hands back a 43-character token", async () => {
		const issued = await pending.begin({
			userId,
			factorsCompleted: ["password"],
		});

		expect(await countRows()).toBe(1);
		expect(issued.token).toHaveLength(43);
		expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(issued.pending.attemptsRemaining).toBe(MAXIMUM_PENDING_ATTEMPTS);
		expect(issued.pending.factorsCompleted).toStrictEqual(["password"]);
	});

	it("stores the hash and never the token (S-REST-2)", async () => {
		const token = await begin();

		const [row] = await connection.query<{ token_sha256: Buffer }>(
			`SELECT token_sha256 FROM ${schema}.pending_authentication WHERE user_id = $1`,
			[userId],
		);
		expect(row).toBeDefined();
		expect(new Uint8Array(row?.token_sha256 ?? new Uint8Array())).toStrictEqual(
			hashPendingToken(token),
		);

		const [found] = await connection.query<{ hits: number }>(
			`SELECT count(*)::int AS hits FROM ${schema}.pending_authentication
			 WHERE encode(token_sha256, 'escape') LIKE $1`,
			[`%${token}%`],
		);
		expect(found?.hits).toBe(0);
	});

	it("gives the row the five minutes the pending cookie gets (S-COOKIE-3)", async () => {
		const issued = await pending.begin({
			userId,
			factorsCompleted: ["password"],
		});

		const [row] = await connection.query<{ lifetime: string }>(
			`SELECT (expires_at - created_at)::text AS lifetime
			 FROM ${schema}.pending_authentication WHERE user_id = $1`,
			[userId],
		);
		expect(row?.lifetime).toBe("00:05:00");
		expect(PENDING_LIFETIME_IN_SECONDS).toBe(300);
		expect(issued.pending.expiresAt).toBeInstanceOf(Date);
	});
});

describe("what resolution reports", () => {
	it("names only the factors the account has actually enrolled", async () => {
		await enrolTotp(true);
		await enrolRecoveryCodes(2);
		const token = await begin();

		const resolved = await pending.resolve(token);

		expect(resolved?.pending.availableFactors).toStrictEqual(["totp", "recovery"]);
	});

	it("counts an unconfirmed enrolment attempt as no factor (3.6)", async () => {
		await enrolTotp(false);
		await enrolWebauthn();
		const token = await begin();

		const resolved = await pending.resolve(token);

		expect(resolved?.pending.availableFactors).toStrictEqual(["webauthn"]);
	});

	/** S-FIX-4: three keys, and none of them is a session or a token that could become one. */
	it("carries nothing a session could be built from", async () => {
		const token = await begin();

		const resolved = await pending.resolve(token);

		expect(resolved === null ? [] : Object.keys(resolved).sort()).toStrictEqual([
			"observedAt",
			"pending",
			"userId",
		]);
		expect(Object.keys(resolved?.pending ?? {}).sort()).toStrictEqual([
			"attemptsRemaining",
			"availableFactors",
			"expiresAt",
			"factorsCompleted",
		]);
	});

	it("refuses an expired row, a cancelled row and a token nobody issued", async () => {
		const expired = await begin();
		await connection.query(
			`UPDATE ${schema}.pending_authentication SET expires_at = now() - interval '1 second'
			 WHERE token_sha256 = $1`,
			[hashPendingToken(expired)],
		);
		const cancelled = await begin();
		await pending.cancel({ token: cancelled });
		const invented = toPendingToken("v".repeat(43));

		const answers = await Promise.all([
			pending.resolve(expired),
			pending.resolve(cancelled),
			pending.resolve(invented),
		]);

		expect(answers).toStrictEqual([null, null, null]);
	});

	// L-4 reserves its code for the resolution of an existing session; this is a sign-in in progress.
	it("refuses a disabled account without naming the account", async () => {
		const token = await begin();
		await connection.query(`UPDATE ${schema}.user SET disabled_at = now() WHERE id = $1`, [userId]);

		expect(await pending.resolve(token)).toBeNull();
	});
});

describe("the attempt budget (L-8)", () => {
	it("counts five failures down and then removes the row", async () => {
		const token = await begin();

		const outcomes = [];
		for (let attempt = 0; attempt < MAXIMUM_PENDING_ATTEMPTS; attempt += 1) {
			outcomes.push(await pending.registerFailedAttempt(token));
		}

		expect(outcomes).toStrictEqual([
			{ outcome: "attempts_remain", attemptsRemaining: 4 },
			{ outcome: "attempts_remain", attemptsRemaining: 3 },
			{ outcome: "attempts_remain", attemptsRemaining: 2 },
			{ outcome: "attempts_remain", attemptsRemaining: 1 },
			{ outcome: "exhausted" },
		]);
		expect(await countRows()).toBe(0);
		expect(await pending.resolve(token)).toBeNull();
	});

	it("reports a token it cannot find as exhausted, not as a fresh budget", async () => {
		expect(await pending.registerFailedAttempt(toPendingToken("w".repeat(43)))).toStrictEqual({
			outcome: "exhausted",
		});
	});
});

describe("consumption", () => {
	it("removes the row and hands the completed factors on", async () => {
		const token = await begin();

		const consumed = await pending.consume(token);

		expect(consumed).toStrictEqual({ userId, factorsCompleted: ["password"] });
		expect(await countRows()).toBe(0);
	});

	it("refuses the second attempt with the same token", async () => {
		const token = await begin();
		await pending.consume(token);

		await expect(pending.consume(token)).rejects.toThrow(ConcealedError);
	});
});

describe("the token and the repository underneath the service", () => {
	// S-RAND-2: the pending token is drawn the way every other 256-bit secret of the library is.
	it("draws a thousand tokens without a repeat", () => {
		const drawn = new Set<string>();
		for (let index = 0; index < 1000; index += 1) {
			const token = createPendingToken();
			expect(decodeBase64Url(token)).toHaveLength(32);
			drawn.add(token);
		}

		expect(drawn.size).toBe(1000);
	});

	it("reports a missing row rather than inventing an attempt count", async () => {
		const repository = createPendingAuthenticationRepository({ driver: connection, schema });

		const counted = await repository.countFailedAttempt({
			tokenHash: hashPendingToken(toPendingToken("x".repeat(43))),
			maximumAttempts: MAXIMUM_PENDING_ATTEMPTS,
		});

		expect(counted).toBeNull();
	});
});

describe("the four routes that read the pending cookie (S-CACHE-4)", () => {
	it("names exactly the four from 3.6", () => {
		expect(PENDING_CALLER_ROUTES).toHaveLength(4);
		expect([...PENDING_CALLER_ROUTES].sort()).toStrictEqual([
			"factor.recovery.verify",
			"factor.totp.verify",
			"factor.webauthn.authenticate.finish",
			"factor.webauthn.authenticate.start",
		]);
	});
});
