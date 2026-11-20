import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { configFor, createLogSink, testKeyProvider } from "./auth-fixtures.js";
import { openConnectionPool } from "./connection-pool-fixtures.js";
import { dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { difference, postTo } from "./flows-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

/**
 * Review of S-ENUM-9 against someone who holds the victim's mailbox: whatever was mailed into the
 * account before the switch went on, or while it was going on, must answer like an unknown token
 * once the switch is on, and a request for the account must look exactly like a request for an
 * address without an account. Also an old recovery code presented at a sign-in that began before
 * the switch went on.
 */

const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";
const ONE_TOTP_STEP_IN_MILLISECONDS = 30_000;
const UNKNOWN = "nobody-here-either@example.com";

const keys = testKeyProvider();
const sent: EmailMessage[] = [];
const log = createLogSink();
let migrated: MigratedSchema;
let pool: Awaited<ReturnType<typeof openConnectionPool>>;
let auth: VelveAuth<"email">;
let bystander: VelveAuth<"email">;
let handler: (request: Request) => Promise<Response>;
let clock: TestClock;
let accounts = 0;
let beforeTheMint: (() => Promise<void>) | null = null;

//runs a hook once between a request's address lookup and its mint transaction
function interceptingTheMint(inner: Driver): Driver {
	return {
		query: (sql, parameters) => inner.query(sql, parameters),
		transaction: async (run) => {
			const hook = beforeTheMint;
			beforeTheMint = null;
			if (hook !== null) {
				await hook();
			}
			return inner.transaction(run);
		},
	};
}

const limits = {
	perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
	perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
};

beforeAll(async () => {
	clock = createTestClock();
	migrated = await openMigratedSchema("norecovery_review_mail");
	pool = await openConnectionPool(4);
	auth = createVelveAuth(
		configFor({
			database: interceptingTheMint(pool),
			schema: migrated.schema,
			keys,
			clock,
			log: log.write,
			email: {
				send: (message) => {
					sent.push(message);
					return Promise.resolve();
				},
			},
			rateLimit: limits,
		}),
	);
	bystander = createVelveAuth(
		configFor({ database: pool, schema: migrated.schema, keys, clock, rateLimit: limits }),
	);
	handler = toWebHandler(auth);
}, 60_000);

afterAll(async () => {
	await pool.close();
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

beforeEach(() => {
	sent.length = 0;
	beforeTheMint = null;
});

function cookieIn(answer: Response, name: string): string | null {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === name) {
			const value = pair.slice(separator + 1);
			return value === "" ? null : value;
		}
	}
	return null;
}

interface Account {
	readonly email: string;
	readonly userId: string;
	readonly sessionToken: string;
}

async function signUp(): Promise<Account> {
	accounts += 1;
	const email = `review-mail-${accounts}@example.com`;
	const answer = await handler(postTo("/sign-up", { email, password: PASSWORD }));
	const sessionToken = cookieIn(answer, DEFAULT_COOKIE_NAMES.session);
	const body = (await answer.json()) as { user: { id: string } };
	if (answer.status !== 200 || sessionToken === null) {
		throw new Error(`the sign-up answered ${answer.status}`);
	}
	return { email, userId: body.user.id, sessionToken };
}

async function enrolTotp(account: Account): Promise<string> {
	const session = { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${account.sessionToken}` };
	const started = await handler(postTo("/factor/totp/enroll/start", {}, session));
	const { secretBase32 } = (await started.json()) as { secretBase32: string };
	const finished = await handler(
		postTo("/factor/totp/enroll/finish", { code: codeNow(secretBase32) }, session),
	);
	expect([started.status, finished.status]).toStrictEqual([200, 204]);
	clock.advanceBy(2 * ONE_TOTP_STEP_IN_MILLISECONDS);
	return secretBase32;
}

function codeNow(secretBase32: string): string {
	return totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now()));
}

function tokenMailedFor(kind: "password_reset" | "magic_link"): string | null {
	const message = sent.find((candidate) => candidate.kind === kind);
	return message !== undefined && "token" in message ? message.token : null;
}

async function signInStatus(password: string, email: string): Promise<number> {
	return (await handler(postTo("/sign-in/password", { email, password }))).status;
}

describe("a reset held back for its second factor before the switch went on (S-ENUM-9)", () => {
	it("does not write its password once the switch has been on, even after it is off again", async () => {
		const account = await signUp();
		const secret = await enrolTotp(account);
		await handler(postTo("/password/request-reset", { email: account.email }));
		const token = tokenMailedFor("password_reset");
		if (token === null) {
			throw new Error("no reset was mailed");
		}
		const held = await handler(
			postTo("/password/redeem-reset", { token, newPassword: REPLACEMENT }),
		);
		const pendingToken = cookieIn(held, DEFAULT_COOKIE_NAMES.pending);
		if (pendingToken === null) {
			throw new Error("the reset was not held back");
		}

		await auth.user.disableRecovery({ userId: account.userId });
		await auth.user.enableRecovery({ userId: account.userId });
		const completed = await handler(
			postTo(
				"/factor/totp/verify",
				{ code: codeNow(secret) },
				{ Cookie: `${DEFAULT_COOKIE_NAMES.pending}=${pendingToken}` },
			),
		);

		expect(completed.status).toBe(401);
		expect(await signInStatus(REPLACEMENT, account.email)).toBe(401);
	});
});

describe("a request whose lookup ran just before the switch went on (S-ENUM-9)", () => {
	it("mails no link the account's mailbox can still redeem once recovery is on again", async () => {
		const account = await signUp();
		beforeTheMint = () => bystander.user.disableRecovery({ userId: account.userId });

		const requested = await handler(postTo("/password/request-reset", { email: account.email }));
		const token = tokenMailedFor("password_reset");
		await bystander.user.enableRecovery({ userId: account.userId });
		const redeemed =
			token === null
				? null
				: await handler(postTo("/password/redeem-reset", { token, newPassword: REPLACEMENT }));

		expect(requested.status).toBe(204);
		expect(redeemed?.status ?? 400).toBe(400);
		expect(await signInStatus(PASSWORD, account.email)).toBe(200);
	});
});

describe("a request for a switched-off account against one for an unknown address (S-ENUM-9)", () => {
	it.each(["/password/request-reset", "/sign-in/magic-link/request"])(
		"%s answers with the same status, headers and body",
		async (path) => {
			const account = await signUp();
			await auth.user.disableRecovery({ userId: account.userId });
			sent.length = 0;

			const switchedOff = await handler(postTo(path, { email: account.email }));
			const unknown = await handler(postTo(path, { email: UNKNOWN }));

			expect(await difference(switchedOff, unknown)).toStrictEqual([]);
			expect(sent.map((message) => message.kind)).toStrictEqual([
				"request_for_unknown_address",
				"request_for_unknown_address",
			]);
			expect(sent.map((message) => ("to" in message ? message.to : null))).toStrictEqual([
				account.email,
				UNKNOWN,
			]);
		},
	);
});

describe("an old recovery code at a sign-in that began before the switch went on (S-ENUM-9)", () => {
	it("answers as a wrong code and issues no session", async () => {
		const account = await signUp();
		await enrolTotp(account);
		const generated = await handler(
			postTo(
				"/factor/recovery/generate",
				{},
				{ Cookie: `${DEFAULT_COOKIE_NAMES.session}=${account.sessionToken}` },
			),
		);
		const { codes } = (await generated.json()) as { codes: readonly string[] };
		const signedIn = await handler(
			postTo("/sign-in/password", { email: account.email, password: PASSWORD }),
		);
		const pendingToken = cookieIn(signedIn, DEFAULT_COOKIE_NAMES.pending);
		if (pendingToken === null) {
			throw new Error("the sign-in asked for no second factor");
		}
		const pending = { Cookie: `${DEFAULT_COOKIE_NAMES.pending}=${pendingToken}` };

		await auth.user.disableRecovery({ userId: account.userId });
		const old = await handler(postTo("/factor/recovery/verify", { code: codes[0] }, pending));
		const wrong = await handler(
			postTo("/factor/recovery/verify", { code: "zzzz-zzzz-zzzz-zzzz" }, pending),
		);

		expect(cookieIn(old, DEFAULT_COOKIE_NAMES.session)).toBeNull();
		expect(await difference(old, wrong)).toStrictEqual([]);
	});
});
