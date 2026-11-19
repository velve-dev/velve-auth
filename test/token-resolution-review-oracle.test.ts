import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { createOneTimeTokens } from "../src/core/token/one-time-token.js";
import type { OneTimeTokenPurpose } from "../src/core/token/purpose.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { type MountedAuth, mountAuth, requestTo, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

/**
 * Review of S-TOKEN-7 against the requirement rather than against the build: the resolve may name
 * an account only where the redemption of the same token would take effect, so it is held side by
 * side with the redemption for every purpose and every refusal a redemption makes before its token
 * takes effect. A forged row must cost what a missing one costs and answer what a missing one
 * answers, and nothing the resolve does may write, lock or wait on a lock.
 */

const PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "another-correct-horse-battery";
const KEYS = testKeyProvider();
const PURPOSES: readonly OneTimeTokenPurpose[] = [
	"email_verify",
	"password_reset",
	"email_change",
	"magic_link",
];

let mounted: MountedAuth;
let alarms: SecurityStateAlarm[];
let accounts = 0;

beforeAll(async () => {
	alarms = [];
	mounted = await mountAuth("token_resolution_review", {
		keys: KEYS,
		securityState: { sealing: "required", alarm: (event) => alarms.push(event) },
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
	});
}, 60_000);

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
	return mounted.handler(requestTo(path, { body, ...(cookie === undefined ? {} : { cookie }) }));
}

function lastTokenMailed(kind: EmailMessage["kind"], to: string): string {
	const message = mounted.email.messages
		.filter((candidate) => candidate.kind === kind && candidate.to === to)
		.at(-1);
	if (message === undefined || !("token" in message)) {
		throw new Error(`no ${kind} message to ${to} carrying a token`);
	}
	return message.token;
}

interface Account {
	readonly userId: string;
	readonly email: string;
	readonly cookie: string;
}

async function newAccount(): Promise<Account> {
	accounts += 1;
	const email = `review${accounts}-${randomBytes(4).toString("hex")}@example.com`;
	const answer = await post("/sign-up", { email, password: PASSWORD });
	const userId = ((await answer.json()) as { user: { id: string } }).user.id;
	const cookie = /__Host-velve_session=[^;]*/.exec(answer.headers.get("Set-Cookie") ?? "")?.[0];
	if (cookie === undefined) {
		throw new Error("no session cookie");
	}
	return { userId, email, cookie };
}

/** mails a link of the purpose and answers its token, with where an address change was sent */
async function linkOf(account: Account, purpose: OneTimeTokenPurpose): Promise<string> {
	switch (purpose) {
		case "email_verify":
			return lastTokenMailed("email_verification", account.email);
		case "password_reset":
			await post("/password/request-reset", { email: account.email });
			return lastTokenMailed("password_reset", account.email);
		case "magic_link":
			await post("/sign-in/magic-link/request", { email: account.email });
			return lastTokenMailed("magic_link", account.email);
		case "email_change": {
			const target = `changed-${account.email}`;
			await post("/email/request-change", { newEmail: target }, account.cookie);
			return lastTokenMailed("email_change", target);
		}
	}
}

/** redeems the link through its route and answers whether it took effect */
async function redeemed(purpose: OneTimeTokenPurpose, token: string): Promise<boolean> {
	const path = {
		email_verify: "/email/redeem-verification",
		password_reset: "/password/redeem-reset",
		email_change: "/email/redeem-change",
		magic_link: "/sign-in/magic-link/redeem",
	}[purpose];
	const body = purpose === "password_reset" ? { token, newPassword: NEW_PASSWORD } : { token };
	const answer = await post(path, body);
	if (answer.status === 200) {
		return true;
	}
	const code = ((await answer.json()) as { error: { code: string } }).error.code;
	expect(code, `${purpose} refused with ${code}`).toBe("invalid_token");
	return false;
}

function resolve(token: unknown): Promise<unknown> {
	return mounted.auth.oneTimeToken.resolve({ token } as { token: string });
}

async function alarmsOf(userId: string | null): Promise<readonly string[]> {
	await new Promise((resolved) => setTimeout(resolved, 25));
	return alarms
		.filter((alarm) => alarm.userId === userId)
		.map((alarm) => `${alarm.occasion} ${alarm.reason}`);
}

type Tamper = (account: Account) => Promise<void>;

const UNTOUCHED: Tamper = () => Promise.resolve();

const DISABLED: Tamper = (account) =>
	mounted.auth.user.disable({ userId: account.userId, reason: "review" });

//a sealed component changed by sql without a reseal is a broken seal
const SEAL_BROKEN: Tamper = async (account) => {
	await mounted.connection.query(
		`UPDATE ${mounted.schema}.user SET email_verified_at = now() - interval '1 day' WHERE id = $1`,
		[account.userId],
	);
};

const EXPIRED: Tamper = async (account) => {
	await mounted.connection.query(
		`UPDATE ${mounted.schema}.one_time_token SET expires_at = now() - interval '1 second'
		 WHERE user_id = $1`,
		[account.userId],
	);
};

describe("the resolve names an account exactly where the redemption takes effect (S-TOKEN-7)", () => {
	const cases: readonly (readonly [string, Tamper, boolean])[] = [
		["untouched", UNTOUCHED, true],
		["disabled", DISABLED, false],
		["seal broken by a writer", SEAL_BROKEN, false],
		["expired", EXPIRED, false],
	];

	for (const purpose of PURPOSES) {
		for (const [state, tamper, works] of cases) {
			it(`${purpose}, ${state}: resolve and redemption agree`, async () => {
				const account = await newAccount();
				const token = await linkOf(account, purpose);
				await tamper(account);

				const answer = await resolve(token);
				const again = await resolve(token);
				const tookEffect = await redeemed(purpose, token);

				expect(answer).toStrictEqual(again);
				expect(tookEffect).toBe(works);
				expect(answer).toStrictEqual(works ? { userId: account.userId, purpose } : null);
			}, 30_000);
		}
	}

	it("refuses a written-back link a later redemption overtook, raising no alarm, as the redemption does", async () => {
		const account = await newAccount();
		const first = await linkOf(account, "magic_link");
		const [saved] = await mounted.connection.query<{ saved: string }>(
			`SELECT to_jsonb(t)::text AS saved FROM ${mounted.schema}.one_time_token t
			 WHERE user_id = $1 AND purpose = 'magic_link'`,
			[account.userId],
		);
		expect(await redeemed("magic_link", first)).toBe(true);
		const second = await linkOf(account, "magic_link");
		expect(await redeemed("magic_link", second)).toBe(true);
		await mounted.connection.query(
			`INSERT INTO ${mounted.schema}.one_time_token
			 SELECT * FROM jsonb_populate_record(NULL::${mounted.schema}.one_time_token, $1::jsonb)`,
			[saved?.saved],
		);
		alarms.length = 0;

		expect(await resolve(first)).toBeNull();
		expect(await alarmsOf(account.userId)).toStrictEqual([]);
		expect(await redeemed("magic_link", first)).toBe(false);
	}, 30_000);

	it("names nothing but the account and the purpose", async () => {
		const account = await newAccount();
		const token = await linkOf(account, "password_reset");

		const answer = await resolve(token);

		expect(Object.keys(answer as object).sort()).toStrictEqual(["purpose", "userId"]);
	}, 30_000);
});

describe("a forged row answers and costs what a missing one does (S-TOKEN-7, S-INTEG-9)", () => {
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

	beforeAll(() => {
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

	async function statementsOf(token: string): Promise<{ answer: unknown; sent: string[] }> {
		recorded.length = 0;
		const answer = await watched.oneTimeToken.resolve({ token });
		return { answer, sent: [...recorded] };
	}

	async function forged(
		token: string,
		row: { userId: string | null; payload: string | null; keyVersion: number; purpose?: string },
	): Promise<void> {
		await mounted.connection.query(
			`INSERT INTO ${mounted.schema}.one_time_token
			 (token_sha256, purpose, user_id, payload, expires_at, token_mac, token_mac_key_version)
			 VALUES (sha256(convert_to($1, 'UTF8')), $5, $2, $3::jsonb, now() + interval '1 hour',
			         decode(repeat('ab', 32), 'hex'), $4)`,
			[token, row.userId, row.payload, row.keyVersion, row.purpose ?? "password_reset"],
		);
	}

	function freshToken(): string {
		return randomBytes(32).toString("base64url");
	}

	it("sends the one read and answers null for every kind of row a writer can plant", async () => {
		const victim = await newAccount();
		const missing = await statementsOf(freshToken());

		const plantedTokens: string[] = [];
		const plants = [
			{ userId: victim.userId, payload: null, keyVersion: 1 },
			{ userId: victim.userId, payload: `{"accountEmail": "${victim.email}"}`, keyVersion: 1 },
			{ userId: victim.userId, payload: `{"accountEmail": "${victim.email}"}`, keyVersion: 99 },
			{ userId: victim.userId, payload: '"a string"', keyVersion: 1 },
			{ userId: victim.userId, payload: "[1, 2]", keyVersion: 1 },
			{ userId: null, payload: null, keyVersion: 1 },
			{ userId: victim.userId, payload: null, keyVersion: 1, purpose: "magic_link" },
		];
		for (const plant of plants) {
			const token = freshToken();
			await forged(token, plant);
			plantedTokens.push(token);
		}

		const answers: unknown[] = [];
		for (const token of plantedTokens) {
			const { answer, sent } = await statementsOf(token);
			answers.push(answer);
			expect(sent).toStrictEqual(missing.sent);
		}

		expect(missing.answer).toBeNull();
		expect(missing.sent).toHaveLength(1);
		expect(answers).toStrictEqual(plants.map(() => null));
	}, 30_000);

	it("answers the cover row of an unknown address with the one read and no alarm", async () => {
		const tokens = createOneTimeTokens(
			createOneTimeTokenRepository({ driver: mounted.connection, schema: mounted.schema }),
			{ keys: KEYS },
		);
		const cover = await tokens.issue({
			userId: null,
			serialisedOn: "nobody-review@example.com",
			purpose: "password_reset",
			payload: { accountEmail: "nobody-review@example.com" },
		});
		const missing = await statementsOf(freshToken());
		alarms.length = 0;

		const covered = await statementsOf(cover.token);

		expect(covered.answer).toBeNull();
		expect(covered.sent).toStrictEqual(missing.sent);
		expect(await alarmsOf(null)).toStrictEqual([]);
	}, 30_000);

	it("raises one alarm for a planted row of an account, as a redemption of it would", async () => {
		const victim = await newAccount();
		const token = freshToken();
		await forged(token, { userId: victim.userId, payload: null, keyVersion: 1 });

		expect(await resolve(token)).toBeNull();
		expect(await alarmsOf(victim.userId)).toStrictEqual([
			"token_redemption token_binding_mismatch",
		]);
	}, 30_000);
});

describe("the resolve leaves every table as it found it and waits on no lock (S-TOKEN-7)", () => {
	let bystander: TestConnection;

	beforeAll(async () => {
		bystander = await openTestConnection();
	});

	afterAll(async () => {
		await bystander.close();
	});

	async function everyCoreTable(): Promise<string> {
		const tables = ["user", "security_state", "one_time_token", "session", "password_credential"];
		const dumps: string[] = [];
		for (const table of tables) {
			const rows = await mounted.connection.query<{ row: string }>(
				`SELECT to_jsonb(t)::text AS row FROM ${mounted.schema}.${table} t ORDER BY 1`,
				[],
			);
			dumps.push(`${table}: ${rows.map((row) => row.row).join("\n")}`);
		}
		return dumps.join("\n\n");
	}

	it("changes no row of any core table across valid, disabled and refused links", async () => {
		const live = await newAccount();
		const disabled = await newAccount();
		const links = [
			...(await Promise.all(PURPOSES.map((purpose) => linkOf(live, purpose)))),
			await linkOf(disabled, "magic_link"),
		];
		await mounted.auth.user.disable({ userId: disabled.userId, reason: "review" });
		const before = await everyCoreTable();

		for (const token of [...links, freshTokenOutside()]) {
			await resolve(token);
			await resolve(token);
		}

		expect(await everyCoreTable()).toBe(before);
	}, 60_000);

	it("answers while a redemption of the same link holds its removal uncommitted", async () => {
		const account = await newAccount();
		const token = await linkOf(account, "magic_link");
		let release = (): void => undefined;
		let removed = 0;
		const holding = bystander
			.transaction(async (tx) => {
				const rows = await tx.query(
					`DELETE FROM ${mounted.schema}.one_time_token
					 WHERE token_sha256 = sha256(convert_to($1, 'UTF8')) RETURNING 1`,
					[token],
				);
				removed = rows.length;
				await new Promise<void>((resolved) => {
					release = resolved;
				});
				throw new Error("roll the removal back");
			})
			.catch(() => undefined);
		await new Promise((resolved) => setTimeout(resolved, 100));

		const answer = await Promise.race([
			resolve(token),
			new Promise((resolved) => setTimeout(() => resolved("still waiting"), 3_000)),
		]);
		release();
		await holding;

		expect(removed).toBe(1);
		expect(answer).toStrictEqual({ userId: account.userId, purpose: "magic_link" });
	}, 30_000);
});

function freshTokenOutside(): string {
	return randomBytes(32).toString("base64url");
}
