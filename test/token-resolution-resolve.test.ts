import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { createOneTimeTokens } from "../src/core/token/one-time-token.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { type MountedAuth, mountAuth, requestTo, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

/**
 * S-TOKEN-7: `oneTimeToken.resolve` reads which account and purpose a mailed link names after
 * checking its MAC and its deadline, and spends nothing. Every token a redemption would answer with
 * `invalid_token` — unknown, expired, spent, written by a database writer, moved to another purpose
 * or account, bound to an address or a generation the account has left, or belonging to a disabled
 * account — is answered with the same `null`, and the call writes nothing and takes no lock.
 */

const PASSWORD = "correct-horse-battery-staple";
const KEYS = testKeyProvider();

let mounted: MountedAuth;
let alarms: SecurityStateAlarm[];
let accounts = 0;

beforeAll(async () => {
	alarms = [];
	mounted = await mountAuth("token_resolution", {
		keys: KEYS,
		securityState: { sealing: "required", alarm: (event) => alarms.push(event) },
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
	});
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
	return mounted.handler(requestTo(path, { body, ...(cookie === undefined ? {} : { cookie }) }));
}

function tokenMailed(kind: EmailMessage["kind"], to: string): string {
	const message = mounted.email.messages
		.filter((candidate) => candidate.kind === kind && candidate.to === to)
		.at(-1);
	if (message === undefined || !("token" in message)) {
		throw new Error(`no ${kind} message to ${to} carrying a token`);
	}
	return message.token;
}

async function signedUp(): Promise<{ userId: string; email: string; cookie: string }> {
	accounts += 1;
	const email = `resolve${accounts}@example.com`;
	const answer = await post("/sign-up", { email, password: PASSWORD });
	const userId = ((await answer.json()) as { user: { id: string } }).user.id;
	const cookie = /__Host-velve_session=[^;]*/.exec(answer.headers.get("Set-Cookie") ?? "")?.[0];
	if (cookie === undefined) {
		throw new Error("no session cookie");
	}
	return { userId, email, cookie };
}

async function magicLinkFor(email: string): Promise<string> {
	await post("/sign-in/magic-link/request", { email });
	return tokenMailed("magic_link", email);
}

function resolveLink(token: unknown): Promise<unknown> {
	return mounted.auth.oneTimeToken.resolve({ token } as { token: string });
}

async function tokenRows(): Promise<string> {
	const rows = await mounted.connection.query<{ row: string }>(
		`SELECT to_jsonb(t)::text AS row FROM ${mounted.schema}.one_time_token t ORDER BY token_sha256`,
		[],
	);
	return rows.map((row) => row.row).join("\n");
}

async function stateRows(): Promise<string> {
	const rows = await mounted.connection.query<{ row: string }>(
		`SELECT to_jsonb(t)::text AS row FROM ${mounted.schema}.security_state t ORDER BY user_id`,
		[],
	);
	return rows.map((row) => row.row).join("\n");
}

/** the row as a writer keeps it, every column and its MAC included */
async function savedTokenRow(userId: string, purpose: string): Promise<string> {
	const [row] = await mounted.connection.query<{ saved: string }>(
		`SELECT to_jsonb(t)::text AS saved FROM ${mounted.schema}.one_time_token t
		 WHERE user_id = $1 AND purpose = $2`,
		[userId, purpose],
	);
	if (row === undefined) {
		throw new Error("no token row to save");
	}
	return row.saved;
}

async function writtenBack(saved: string): Promise<void> {
	await mounted.connection.query(
		`INSERT INTO ${mounted.schema}.one_time_token
		 SELECT * FROM jsonb_populate_record(NULL::${mounted.schema}.one_time_token, $1::jsonb)`,
		[saved],
	);
}

/** the alarm is delivered off the response path, one timer turn after the refusal */
async function alarmsFor(userId: string): Promise<readonly string[]> {
	await new Promise((resolve) => setTimeout(resolve, 20));
	return alarms
		.filter((alarm) => alarm.userId === userId)
		.map((alarm) => `${alarm.occasion} ${alarm.reason}`);
}

describe("a valid link is resolved to its account and purpose and stays valid (S-TOKEN-7)", () => {
	it("names the account and the purpose of each of the four purposes", async () => {
		const { userId, email, cookie } = await signedUp();
		const verification = tokenMailed("email_verification", email);
		await post("/password/request-reset", { email });
		const reset = tokenMailed("password_reset", email);
		const magic = await magicLinkFor(email);
		await post("/email/request-change", { newEmail: `moved-${email}` }, cookie);
		const change = tokenMailed("email_change", `moved-${email}`);

		expect(await resolveLink(verification)).toStrictEqual({ userId, purpose: "email_verify" });
		expect(await resolveLink(reset)).toStrictEqual({ userId, purpose: "password_reset" });
		expect(await resolveLink(magic)).toStrictEqual({ userId, purpose: "magic_link" });
		expect(await resolveLink(change)).toStrictEqual({ userId, purpose: "email_change" });
		expect(await alarmsFor(userId)).toStrictEqual([]);
	});

	it("writes nothing, so the same link resolves again and is then redeemed once", async () => {
		const { userId, email } = await signedUp();
		const magic = await magicLinkFor(email);
		const tokensBefore = await tokenRows();
		const statesBefore = await stateRows();

		for (let call = 0; call < 5; call += 1) {
			expect(await resolveLink(magic)).toStrictEqual({ userId, purpose: "magic_link" });
		}

		expect(await tokenRows()).toBe(tokensBefore);
		expect(await stateRows()).toBe(statesBefore);
		const redeemed = await post("/sign-in/magic-link/redeem", { token: magic });
		expect(redeemed.status).toBe(200);
		expect(await resolveLink(magic)).toBeNull();
	});
});

describe("every token a redemption refuses resolves to the one answer null (S-TOKEN-7)", () => {
	it("answers an unknown, a malformed and a non-string token with null", async () => {
		const answers = await Promise.all(
			["A".repeat(43), "", "not a token", 42, null, undefined, { token: "x" }].map(resolveLink),
		);

		expect(answers).toStrictEqual([null, null, null, null, null, null, null]);
	});

	it("answers an expired link with null", async () => {
		const { userId, email } = await signedUp();
		const magic = await magicLinkFor(email);
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.one_time_token SET expires_at = now() - interval '1 second'
			 WHERE user_id = $1`,
			[userId],
		);

		expect(await resolveLink(magic)).toBeNull();
	});

	it("answers a spent link with null", async () => {
		const { email } = await signedUp();
		await post("/password/request-reset", { email });
		const reset = tokenMailed("password_reset", email);
		const redeemed = await post("/password/redeem-reset", {
			token: reset,
			newPassword: "another-correct-horse-battery",
		});

		expect(redeemed.status).toBe(200);
		expect(await resolveLink(reset)).toBeNull();
	});

	it("answers a link a newer request of the same purpose replaced with null", async () => {
		const { email } = await signedUp();
		const first = await magicLinkFor(email);
		await magicLinkFor(email);

		expect(await resolveLink(first)).toBeNull();
	});

	it("answers a disabled account's link with null and resolves it again once the account is enabled", async () => {
		const { userId, email } = await signedUp();
		const magic = await magicLinkFor(email);

		await mounted.auth.user.disable({ userId, reason: "token-resolution test" });
		expect(await resolveLink(magic)).toBeNull();
		const refused = await post("/sign-in/magic-link/redeem", { token: magic });
		expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
			"invalid_token",
		);

		const again = await magicLinkFor(email);
		await mounted.auth.user.enable({ userId });
		expect(await resolveLink(again)).toStrictEqual({ userId, purpose: "magic_link" });
	});

	it("answers a link whose account was deleted with null", async () => {
		const { userId, email } = await signedUp();
		const magic = await magicLinkFor(email);
		const saved = await savedTokenRow(userId, "magic_link");
		await mounted.auth.user.delete({ userId });

		expect(await resolveLink(magic)).toBeNull();
		expect(saved).toContain(userId);
	});
});

describe("a row a database writer touched resolves to null like a missing one (S-TOKEN-7, S-INTEG-9)", () => {
	it("refuses a row inserted for a token of the writer's own choosing, with one alarm", async () => {
		const { userId } = await signedUp();
		const chosen = "w".repeat(43);
		await mounted.connection.query(
			`INSERT INTO ${mounted.schema}.one_time_token
			 (token_sha256, purpose, user_id, payload, expires_at, token_mac, token_mac_key_version)
			 VALUES (sha256(convert_to($1, 'UTF8')), 'magic_link', $2, NULL, now() + interval '1 hour',
			         decode(repeat('00', 32), 'hex'), 1)`,
			[chosen, userId],
		);

		expect(await resolveLink(chosen)).toBeNull();
		expect(await alarmsFor(userId)).toStrictEqual(["token_redemption token_binding_mismatch"]);
	});

	it("refuses a real row moved to another purpose or another account", async () => {
		const victim = await signedUp();
		const writer = await signedUp();
		const reset = await (async () => {
			await post("/password/request-reset", { email: victim.email });
			return tokenMailed("password_reset", victim.email);
		})();
		const magic = await magicLinkFor(victim.email);
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.one_time_token SET purpose = 'email_verify'
			 WHERE user_id = $1 AND purpose = 'password_reset'`,
			[victim.userId],
		);
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.one_time_token SET user_id = $2
			 WHERE user_id = $1 AND purpose = 'magic_link'`,
			[victim.userId, writer.userId],
		);

		expect(await resolveLink(reset)).toBeNull();
		expect(await resolveLink(magic)).toBeNull();
	});

	it("refuses a row whose payload was rewritten", async () => {
		const { userId, email } = await signedUp();
		const magic = await magicLinkFor(email);
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.one_time_token SET payload = payload || '{"extra": true}'::jsonb
			 WHERE user_id = $1`,
			[userId],
		);

		expect(await resolveLink(magic)).toBeNull();
		expect(await alarmsFor(userId)).toStrictEqual(["token_redemption token_binding_mismatch"]);
	});

	it("refuses a spent link written back with its MAC, with one alarm", async () => {
		const { userId, email } = await signedUp();
		await post("/password/request-reset", { email });
		const reset = tokenMailed("password_reset", email);
		const saved = await savedTokenRow(userId, "password_reset");
		await post("/password/redeem-reset", {
			token: reset,
			newPassword: "another-correct-horse-battery",
		});
		await writtenBack(saved);

		expect(await resolveLink(reset)).toBeNull();
		expect(await alarmsFor(userId)).toStrictEqual(["token_redemption token_binding_mismatch"]);
	});

	it("refuses a link mailed while a writer had moved the account's address, with one alarm", async () => {
		const { userId, email } = await signedUp();
		const attacker = `writer-${accounts}@example.com`;
		await mounted.connection.query(`UPDATE ${mounted.schema}.user SET email = $2 WHERE id = $1`, [
			userId,
			attacker,
		]);
		await mounted.reseal(userId);
		const magic = await magicLinkFor(attacker);
		await mounted.connection.query(`UPDATE ${mounted.schema}.user SET email = $2 WHERE id = $1`, [
			userId,
			email,
		]);
		await mounted.reseal(userId);

		expect(await resolveLink(magic)).toBeNull();
		expect(await alarmsFor(userId)).toStrictEqual(["token_redemption seal_mismatch"]);
	});

	it("refuses a link of an account whose sealed state a writer changed", async () => {
		const { userId, email } = await signedUp();
		const magic = await magicLinkFor(email);
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.user SET email_verified_at = now() WHERE id = $1`,
			[userId],
		);

		expect(await resolveLink(magic)).toBeNull();
		expect(await alarmsFor(userId)).toStrictEqual(["token_redemption seal_mismatch"]);
	});

	it("refuses the cover row an address naming no account is answered with", async () => {
		const tokens = createOneTimeTokens(
			createOneTimeTokenRepository({ driver: mounted.connection, schema: mounted.schema }),
			{ keys: KEYS },
		);
		const cover = await tokens.issue({
			userId: null,
			serialisedOn: "nobody@example.com",
			purpose: "magic_link",
			payload: { accountEmail: "nobody@example.com" },
		});

		expect(await resolveLink(cover.token)).toBeNull();
	});
});

describe("the resolve reads and does nothing else (S-TOKEN-7)", () => {
	let bystander: TestConnection;
	let recorded: string[];
	let watched: VelveAuth<"email">;

	function recording(driver: Driver, into: string[]): Driver {
		return {
			query: (sql, parameters) => {
				into.push(sql);
				return driver.query(sql, parameters);
			},
			transaction: (work) => {
				into.push("BEGIN");
				return driver.transaction((tx) => work(recording(tx, into)));
			},
		};
	}

	beforeAll(async () => {
		bystander = await openTestConnection();
		recorded = [];
		watched = createVelveAuth({
			identity: { mode: "email" },
			database: recording(mounted.connection, recorded),
			schema: mounted.schema,
			keys: KEYS,
			origins: ["https://app.example.com"],
			email: { send: () => Promise.resolve() },
		});
	});

	afterAll(async () => {
		await bystander.close();
	});

	it("sends only reading statements, opens no transaction and locks no row", async () => {
		const { userId, email } = await signedUp();
		const magic = await magicLinkFor(email);
		recorded.length = 0;

		expect(await watched.oneTimeToken.resolve({ token: magic })).toStrictEqual({
			userId,
			purpose: "magic_link",
		});
		expect(await watched.oneTimeToken.resolve({ token: "A".repeat(43) })).toBeNull();

		expect(recorded.length).toBeGreaterThanOrEqual(3);
		expect(recorded.filter((sql) => !/^\s*(SELECT|\(SELECT|WITH)\b/i.test(sql))).toStrictEqual([]);
		expect(
			recorded.filter((sql) => /\bFOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE)\b/i.test(sql)),
		).toStrictEqual([]);
		expect(
			recorded.filter((sql) => /\b(INSERT|UPDATE|DELETE)\b|pg_advisory/i.test(sql)),
		).toStrictEqual([]);
	});

	it("answers while another transaction holds the account lock", async () => {
		const { userId, email } = await signedUp();
		const magic = await magicLinkFor(email);
		let release = (): void => undefined;
		const holding = bystander.transaction(async (tx) => {
			await tx.query(
				`SELECT 1 FROM ${mounted.schema}.user WHERE id = $1 FOR NO KEY UPDATE /* locks: ${mounted.schema}.user */`,
				[userId],
			);
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		await new Promise((resolve) => setTimeout(resolve, 100));

		const answer = await Promise.race([
			resolveLink(magic),
			new Promise((resolve) => setTimeout(() => resolve("still waiting"), 3_000)),
		]);
		release();
		await holding;

		expect(answer).toStrictEqual({ userId, purpose: "magic_link" });
	});

	it("leaves a redemption racing it the one consumption of the link", async () => {
		const { userId, email } = await signedUp();
		const magic = await magicLinkFor(email);

		const resolving = Promise.all(Array.from({ length: 20 }, () => resolveLink(magic)));
		const redeemed = await post("/sign-in/magic-link/redeem", { token: magic });
		const resolved = await resolving;

		expect(redeemed.status).toBe(200);
		expect(
			resolved.filter(
				(answer) =>
					answer !== null &&
					JSON.stringify(answer) !== JSON.stringify({ userId, purpose: "magic_link" }),
			),
		).toStrictEqual([]);
		expect(await resolveLink(magic)).toBeNull();
	});
});
