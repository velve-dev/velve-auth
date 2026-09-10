import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createPasswordCredentialRepository } from "../src/core/password/credential.js";
import { createVelveAuth } from "../src/index.js";
import {
	configFor,
	createLogSink,
	type LogSink,
	type MountedAuth,
	mountAuth,
	TEST_ORIGIN,
	testKeyProvider,
} from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { difference, normalisedAnswer, postTo } from "./flows-fixtures.js";
import { storedHashesFor } from "./password-fixtures.js";

type Handler = (request: Request) => Promise<Response>;

let mounted: MountedAuth;

const PASSWORD = "correct-horse-battery-staple";
const OTHER_PASSWORD = "a-different-password-entirely";

beforeAll(async () => {
	// The buckets are not the subject of this file, and a shared per-route bucket refuses the
	// eleventh sign-up before any of it runs; the one test that is about them mounts its own.
	mounted = await mountAuth("passwordroutes", {
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

function cookieIn(answer: Response, name: string): string | null {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === name) {
			return pair.slice(separator + 1);
		}
	}
	return null;
}

function sessionCookieOf(answer: Response): string | null {
	return cookieIn(answer, DEFAULT_COOKIE_NAMES.session);
}

async function codeOf(answer: Response): Promise<string> {
	return ((await answer.json()) as { error: { code: string } }).error.code;
}

function asCookieHeader(token: string): string {
	return `${DEFAULT_COOKIE_NAMES.session}=${token}`;
}

let accounts = 0;

function nextAddress(): string {
	accounts += 1;
	return `account${accounts}@example.com`;
}

interface Account {
	readonly email: string;
	readonly userId: string;
	readonly sessionToken: string;
}

/**
 * `web-handler.ts` moves `sessionToken` and `pendingToken` out of the body and into the cookies, so
 * over HTTP the token is only ever read from `Set-Cookie` — never from the answer (E-1186).
 */
async function accountFrom(answer: Response, email: string): Promise<Account> {
	expect(answer.status).toBe(200);
	const body = (await answer.json()) as { user: { id: string } };
	const token = sessionCookieOf(answer);
	expect(token).not.toBeNull();
	return { email, userId: body.user.id, sessionToken: token ?? "" };
}

async function signUpWithPassword(password: string = PASSWORD): Promise<Account> {
	const email = nextAddress();
	return accountFrom(await mounted.handler(postTo("/sign-up", { email, password })), email);
}

async function signUpWithoutPassword(): Promise<Account> {
	const email = nextAddress();
	return accountFrom(await mounted.handler(postTo("/sign-up/passwordless", { email })), email);
}

function signInWith(email: string, password: string): Promise<Response> {
	return mounted.handler(postTo("/sign-in/password", { email, password }));
}

async function sessionCount(userId: string): Promise<number> {
	const rows = await mounted.connection.query<{ count: string }>(
		`SELECT count(*)::text AS count FROM ${mounted.schema}.session WHERE user_id = $1`,
		[userId],
	);
	return Number(rows[0]?.count ?? "0");
}

async function ageBeyondFreshness(userId: string): Promise<void> {
	await mounted.connection.query(
		`UPDATE ${mounted.schema}.session SET created_at = created_at - interval '16 minutes'
		 WHERE user_id = $1`,
		[userId],
	);
}

async function enrolATotpFactor(userId: string): Promise<void> {
	// The sign-in handshake reads only whether a confirmed row exists; the secret is never opened
	// here, so the bytes stand in for one rather than being derived.
	await mounted.connection.query(
		`INSERT INTO ${mounted.schema}.totp_credential (user_id, secret_enc, key_version, confirmed_at)
		 VALUES ($1, $2, 1, now())`,
		[userId, Buffer.from("a stand-in for an encrypted secret")],
	);
}

/**
 * The defect this file exists for: `test/limit-fixtures.ts` declared a route named `signIn.password`
 * of its own and the rate-limit suite tested real limiting against it, so for eight waves the path
 * read as though the library served it. Every request below goes through `mounted.handler`, and
 * this test states the premise the others rely on rather than leaving it assumed (E-1180).
 */
describe("the rows are served by the instance and not by the test", () => {
	it("declares all three in the table the assembled instance carries", () => {
		const served = mounted.auth.routes.map(
			(route) => `${route.name} ${route.method} ${route.path}`,
		);

		expect(served).toEqual(
			expect.arrayContaining([
				"signIn.password POST /sign-in/password",
				"password.set POST /password/set",
				"password.change POST /password/change",
			]),
		);
	});

	/**
	 * B.9 gives both writing rows `Frisch: ja`. The behavioural tests below cannot hold this on
	 * their own: `listEveryIdOwnedBy` refuses a stale resolution in the service too, so they stay
	 * green with the declaration flipped. The declaration is therefore read directly (E-1191).
	 */
	it("declares the freshness B.9 requires of the two writing rows", () => {
		const freshnessOf = (name: string) =>
			mounted.auth.routes.find((route) => route.name === name)?.freshness;

		expect([freshnessOf("password.set"), freshnessOf("password.change")]).toEqual([
			"required",
			"required",
		]);
		expect(freshnessOf("signIn.password")).toBe("not_required");
	});

	it("answers each of them with something other than the router's 404", async () => {
		for (const path of ["/sign-in/password", "/password/set", "/password/change"]) {
			expect((await mounted.handler(postTo(path, {}))).status).not.toBe(404);
		}
	});
});

describe("signing in with a password (3.15 D.3, B.1)", () => {
	it("issues a session for the credentials sign-up wrote", async () => {
		const account = await signUpWithPassword();

		const answer = await signInWith(account.email, PASSWORD);
		const body = (await answer.json()) as { status: string };
		const issued = sessionCookieOf(answer);

		expect(answer.status).toBe(200);
		expect(body.status).toBe("signed_in");
		expect(issued).not.toBeNull();
		expect(issued).not.toBe(account.sessionToken);
		expect(
			await mounted.auth.session.resolve({ origin: TEST_ORIGIN, sessionToken: issued ?? "" }),
		).not.toBeNull();
	});

	it("records the factor the sign-in actually used", async () => {
		const account = await signUpWithPassword();
		const answer = await signInWith(account.email, PASSWORD);
		const body = (await answer.json()) as { session: { factors: string[] } };

		expect(body.session.factors).toEqual(["password"]);
	});

	it("refuses a wrong password with invalid_credentials", async () => {
		const account = await signUpWithPassword();

		const answer = await signInWith(account.email, OTHER_PASSWORD);

		expect(answer.status).toBe(401);
		expect(await codeOf(answer)).toBe("invalid_credentials");
		expect(sessionCookieOf(answer)).toBeNull();
	});

	/** S-ENUM-1: an identifier that names an account and one that does not answer alike. */
	it("answers an unknown identifier exactly as it answers a wrong password", async () => {
		const account = await signUpWithPassword();

		const known = await signInWith(account.email, OTHER_PASSWORD);
		const unknown = await signInWith("nobody.at.all@example.com", OTHER_PASSWORD);

		expect(await difference(known, unknown)).toEqual([]);
	});

	/** S-ENUM-1 again, for the account that exists and has no password at all. */
	it("answers an account without a credential exactly as it answers a wrong password", async () => {
		const withCredential = await signUpWithPassword();
		const without = await signUpWithoutPassword();

		const known = await signInWith(withCredential.email, OTHER_PASSWORD);
		const credentialless = await signInWith(without.email, OTHER_PASSWORD);

		expect(await difference(known, credentialless)).toEqual([]);
	});

	/**
	 * S-ENUM-2: a disabled account answers a *correct* password as a wrong one, and the code
	 * `account_disabled` reaches no sign-in — it belongs to the resolution of a session (L-4).
	 */
	it("answers a disabled account with the right password as it answers a wrong one", async () => {
		const disabled = await signUpWithPassword();
		const ordinary = await signUpWithPassword();
		await mounted.auth.user.disable({ userId: disabled.userId, reason: "a test" });

		const refused = await signInWith(disabled.email, PASSWORD);
		const wrong = await signInWith(ordinary.email, OTHER_PASSWORD);
		const refusedText = await refused.clone().text();

		expect(await difference(refused, wrong)).toEqual([]);
		expect(refusedText).not.toContain("account_disabled");
	});

	/**
	 * S-DOS-2: the length check depends only on the input and runs before the account is resolved,
	 * so an unusable password is not an oracle either.
	 */
	it("answers an unusable password alike whether or not the identifier names an account", async () => {
		const account = await signUpWithPassword();
		const tooLong = "x".repeat(5000);

		const known = await signInWith(account.email, tooLong);
		const unknown = await signInWith("nobody.at.all@example.com", tooLong);

		expect(await difference(known, unknown)).toEqual([]);
		expect(known.status).toBe(401);
	});

	/**
	 * 3.6 and T-FIX-4: a correct password against an account with a second factor is not a session.
	 * It writes a pending row, sets `__Host-velve_pending`, and sets no session cookie.
	 */
	it("stops at the intermediate state when the account offers a second factor", async () => {
		const account = await signUpWithPassword();
		await enrolATotpFactor(account.userId);
		const before = await sessionCount(account.userId);

		const answer = await signInWith(account.email, PASSWORD);
		const body = (await answer.json()) as {
			status: string;
			pending: { availableFactors: string[] };
		};

		expect(body.status).toBe("second_factor_required");
		expect(body.pending.availableFactors).toEqual(["totp"]);
		expect(cookieIn(answer, DEFAULT_COOKIE_NAMES.pending)).not.toBeNull();
		expect(sessionCookieOf(answer)).toBeNull();
		expect(await sessionCount(account.userId)).toBe(before);
	});

	it("refuses a request whose Origin is not configured", async () => {
		const account = await signUpWithPassword();

		const answer = await mounted.handler(
			postTo(
				"/sign-in/password",
				{ email: account.email, password: PASSWORD },
				{
					Origin: "https://elsewhere.example.com",
				},
			),
		);

		expect(answer.status).toBe(403);
		expect(await codeOf(answer)).toBe("origin_not_allowed");
	});
});

describe("password.set — the account that had none (3.15 B.4)", () => {
	it("writes a credential the sign-in path then accepts", async () => {
		const account = await signUpWithoutPassword();

		const answer = await mounted.handler(
			postTo(
				"/password/set",
				{ newPassword: PASSWORD },
				{ Cookie: asCookieHeader(account.sessionToken) },
			),
		);
		expect(answer.status).toBe(200);

		const signedIn = await signInWith(account.email, PASSWORD);
		expect(((await signedIn.json()) as { status: string }).status).toBe("signed_in");
	});

	it("returns a new session token and invalidates the one that called it (S-FIX-1, S-FIX-3)", async () => {
		const account = await signUpWithoutPassword();

		const answer = await mounted.handler(
			postTo(
				"/password/set",
				{ newPassword: PASSWORD },
				{ Cookie: asCookieHeader(account.sessionToken) },
			),
		);
		const reissued = sessionCookieOf(answer);

		expect(answer.status).toBe(200);
		expect(reissued).not.toBeNull();
		expect(reissued).not.toBe(account.sessionToken);
		expect(
			await mounted.auth.session.resolve({
				origin: TEST_ORIGIN,
				sessionToken: account.sessionToken,
			}),
		).toBeNull();
	});

	/** B.4: `set` is for accounts without a credential and fails when one is already there. */
	it("refuses an account that already has a credential", async () => {
		const account = await signUpWithPassword();

		const answer = await mounted.handler(
			postTo(
				"/password/set",
				{ newPassword: OTHER_PASSWORD },
				{ Cookie: asCookieHeader(account.sessionToken) },
			),
		);

		expect(answer.status).toBe(409);
		expect(await codeOf(answer)).toBe("factor_already_enrolled");
	});

	it("requires a session", async () => {
		const answer = await mounted.handler(postTo("/password/set", { newPassword: PASSWORD }));

		expect(answer.status).toBe(401);
		expect(await codeOf(answer)).toBe("session_required");
	});

	it("requires a fresh session (B.9)", async () => {
		const account = await signUpWithoutPassword();
		await ageBeyondFreshness(account.userId);

		const answer = await mounted.handler(
			postTo(
				"/password/set",
				{ newPassword: PASSWORD },
				{ Cookie: asCookieHeader(account.sessionToken) },
			),
		);

		expect(answer.status).toBe(403);
		expect(await codeOf(answer)).toBe("freshness_required");
	});
});

describe("password.change — the account that had one (3.15 B.4)", () => {
	it("replaces the credential, so the old password stops working and the new one starts", async () => {
		const account = await signUpWithPassword();

		const answer = await mounted.handler(
			postTo(
				"/password/change",
				{ currentPassword: PASSWORD, newPassword: OTHER_PASSWORD },
				{ Cookie: asCookieHeader(account.sessionToken) },
			),
		);
		expect(answer.status).toBe(200);

		expect((await signInWith(account.email, PASSWORD)).status).toBe(401);
		expect((await signInWith(account.email, OTHER_PASSWORD)).status).toBe(200);
	});

	/** S-FIX-6 and T-FIX-6: every other session goes, and the count says how many did. */
	it("revokes every other session of the account and counts them", async () => {
		const account = await signUpWithPassword();
		await signInWith(account.email, PASSWORD);
		await signInWith(account.email, PASSWORD);
		expect(await sessionCount(account.userId)).toBe(3);

		const answer = await mounted.handler(
			postTo(
				"/password/change",
				{ currentPassword: PASSWORD, newPassword: OTHER_PASSWORD },
				{ Cookie: asCookieHeader(account.sessionToken) },
			),
		);
		const body = (await answer.json()) as { revokedOtherSessionsCount: number };

		expect(body.revokedOtherSessionsCount).toBe(2);
		expect(await sessionCount(account.userId)).toBe(1);
	});

	it("refuses a wrong current password with invalid_credentials", async () => {
		const account = await signUpWithPassword();

		const answer = await mounted.handler(
			postTo(
				"/password/change",
				{ currentPassword: OTHER_PASSWORD, newPassword: "yet-another-password" },
				{ Cookie: asCookieHeader(account.sessionToken) },
			),
		);

		expect(answer.status).toBe(401);
		expect(await codeOf(answer)).toBe("invalid_credentials");
		expect((await signInWith(account.email, PASSWORD)).status).toBe(200);
	});

	it("refuses a new password the policy will not take", async () => {
		const account = await signUpWithPassword();

		const answer = await mounted.handler(
			postTo(
				"/password/change",
				{ currentPassword: PASSWORD, newPassword: "short" },
				{ Cookie: asCookieHeader(account.sessionToken) },
			),
		);

		expect(answer.status).toBe(400);
		expect(await codeOf(answer)).toBe("password_unacceptable");
	});

	it("requires a fresh session (B.9)", async () => {
		const account = await signUpWithPassword();
		await ageBeyondFreshness(account.userId);

		const answer = await mounted.handler(
			postTo(
				"/password/change",
				{ currentPassword: PASSWORD, newPassword: OTHER_PASSWORD },
				{ Cookie: asCookieHeader(account.sessionToken) },
			),
		);

		expect(answer.status).toBe(403);
		expect(await codeOf(answer)).toBe("freshness_required");
	});
});

/**
 * The rate limit on `signIn.password` had never been exercised against the route the library
 * serves: `test/limit-fixtures.ts` declares a route of the same name and path, and the limit suite
 * measured that one. This mounts its own instance because the bucket is the subject here (E-1180).
 */
describe("the bucket on the route the library actually serves (S-RATE-5)", () => {
	let limited: MountedAuth;

	beforeAll(async () => {
		limited = await mountAuth("passwordlimit", {
			rateLimit: {
				perIpAddress: { capacity: 3, refillPerSecond: 0 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		});
	});

	afterAll(async () => {
		await dropSchema(limited.connection, limited.schema);
		await limited.connection.close();
	});

	it("refuses with rate_limited once the address bucket is empty", async () => {
		const attempt = () =>
			limited.handler(
				postTo("/sign-in/password", { email: "nobody@example.com", password: PASSWORD }),
			);

		const statuses: number[] = [];
		for (let count = 0; count < 5; count += 1) {
			statuses.push((await attempt()).status);
		}

		expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
		expect(statuses.slice(3)).toEqual([429, 429]);
		expect(await codeOf(await attempt())).toBe("rate_limited");
	});
});

/**
 * S-ENUM-6: the caller is told `invalid_credentials` for all four refusals, and the log is told
 * which one it was. Without this the route could flatten every refusal to one reason and every
 * visible-response test in this file would still pass (E-1189).
 */
describe("the reason the log is told (S-ENUM-6)", () => {
	async function reasonLoggedFor(email: string, password: string): Promise<unknown> {
		const before = mounted.log.lines.length;
		await signInWith(email, password);
		return mounted.log.lines
			.slice(before)
			.map((line) => line.fields.reason)
			.at(-1);
	}

	it("names the refusal that actually happened, not the one the caller is shown", async () => {
		const withCredential = await signUpWithPassword();
		const without = await signUpWithoutPassword();
		const disabled = await signUpWithPassword();
		await mounted.auth.user.disable({ userId: disabled.userId, reason: "a test" });

		expect(await reasonLoggedFor("nobody.at.all@example.com", OTHER_PASSWORD)).toBe(
			"user_not_found",
		);
		expect(await reasonLoggedFor(withCredential.email, OTHER_PASSWORD)).toBe("password_mismatch");
		expect(await reasonLoggedFor(without.email, OTHER_PASSWORD)).toBe("no_password_credential");
		expect(await reasonLoggedFor(disabled.email, PASSWORD)).toBe("user_disabled_on_sign_in");
	});
});

/**
 * S-DOS-2 and T-DOS-1: the length check depends only on the input, so a password the policy cannot
 * take is refused before the account is looked up. Comparing the two answers cannot see this — both
 * are 401 whichever order the route uses — so the statements are counted instead (E-1190).
 */
describe("what an unusable password costs (S-DOS-2)", () => {
	let counted: {
		connection: TestConnection;
		schema: string;
		handler: Handler;
		statements: string[];
	};

	beforeAll(async () => {
		const { connection, schema } = await openMigratedSchema("passworddos");
		const statements: string[] = [];
		const driver: Driver = {
			query: (sql, params) => {
				statements.push(sql);
				return connection.query(sql, params);
			},
			transaction: (work) => connection.transaction(work),
		};
		const auth = createVelveAuth(configFor({ database: driver, schema }));
		counted = { connection, schema, handler: toWebHandler(auth), statements };
	});

	afterAll(async () => {
		await dropSchema(counted.connection, counted.schema);
		await counted.connection.close();
	});

	/**
	 * S-DOS-5 puts the address bucket before the handler, so one statement against `rate_bucket`
	 * is expected and required; what may not happen is the account being resolved.
	 */
	function accountLookups(statements: readonly string[]): readonly string[] {
		return statements.filter((sql) => /password_credential|FROM \w+\.user\b/.test(sql));
	}

	it("never resolves the account", async () => {
		counted.statements.length = 0;

		const answer = await counted.handler(
			postTo("/sign-in/password", { email: "someone@example.com", password: "x".repeat(5000) }),
		);

		expect(answer.status).toBe(401);
		expect(accountLookups(counted.statements)).toEqual([]);
	});

	it("resolves it when the password is one the policy takes, so the count above means something", async () => {
		counted.statements.length = 0;

		await counted.handler(
			postTo("/sign-in/password", { email: "someone@example.com", password: PASSWORD }),
		);

		expect(accountLookups(counted.statements).length).toBeGreaterThan(0);
	});
});

/**
 * S-ENUM-1 and S-ENUM-2 over the **mounted** route, across every account state that produces a
 * distinct internal reason. `http-enumeration.test.ts` holds the same property over a synthetic
 * route, and a synthetic route cannot reach a legacy stored hash — which is exactly where an
 * oracle confined to `legacy_scheme_rejected` sat undetected through the whole suite (E-1198).
 */
describe("every refusal of the real sign-in answers alike (S-ENUM-1)", () => {
	let uniform: {
		connection: TestConnection;
		schema: string;
		handler: Handler;
		auth: ReturnType<typeof createVelveAuth<"email">>;
		log: LogSink;
	};

	async function accountWith(email: string, password?: string): Promise<string> {
		const answer = await uniform.handler(
			postTo(password === undefined ? "/sign-up/passwordless" : "/sign-up", {
				email,
				...(password === undefined ? {} : { password }),
			}),
		);
		expect(answer.status).toBe(200);
		return ((await answer.json()) as { user: { id: string } }).user.id;
	}

	beforeAll(async () => {
		const { connection, schema } = await openMigratedSchema("passworduniform");
		const keys = testKeyProvider();
		const log = createLogSink();
		const auth = createVelveAuth(
			configFor({
				database: connection,
				schema,
				keys,
				log: log.write,
				// The refusal needs a stored scheme the configuration will not read.
				password: { acceptLegacy: [] },
				rateLimit: {
					perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
					perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
				},
			}),
		);
		uniform = { connection, schema, handler: toWebHandler(auth), auth, log };

		await accountWith("present@example.com", PASSWORD);
		await accountWith("credentialless@example.com");
		const disabled = await accountWith("disabled@example.com", PASSWORD);
		await auth.user.disable({ userId: disabled, reason: "a test" });

		const legacy = await accountWith("legacy@example.com");
		await createPasswordCredentialRepository({ driver: connection, keys, schema }).write({
			userId: legacy,
			phc: (await storedHashesFor(PASSWORD)).byScheme.bcrypt,
			scheme: "bcrypt",
			setBySessionId: null,
		});
	});

	afterAll(async () => {
		await dropSchema(uniform.connection, uniform.schema);
		await uniform.connection.close();
	});

	const REFUSALS: readonly {
		readonly state: string;
		readonly email: string;
		readonly password: string;
	}[] = [
		{ state: "no such account", email: "absent@example.com", password: PASSWORD },
		{ state: "wrong password", email: "present@example.com", password: OTHER_PASSWORD },
		{ state: "no credential", email: "credentialless@example.com", password: PASSWORD },
		{ state: "disabled, right password", email: "disabled@example.com", password: PASSWORD },
		{ state: "legacy scheme refused", email: "legacy@example.com", password: PASSWORD },
	];

	async function refuse(email: string, password: string): Promise<Response> {
		return uniform.handler(postTo("/sign-in/password", { email, password }));
	}

	it("answers all five states with one byte-identical response", async () => {
		const answers = new Map<string, string>();
		for (const { state, email, password } of REFUSALS) {
			const answer = await refuse(email, password);
			expect([state, answer.status]).toEqual([state, 401]);
			answers.set(state, await normalisedAnswer(answer));
		}

		expect(answers.size).toBe(REFUSALS.length);
		expect(new Set(answers.values()).size).toBe(1);
	});

	/**
	 * Without this the test above is vacuous: five states that reach one internal reason would be
	 * byte-identical for a reason that has nothing to do with the requirement.
	 */
	it("reaches five distinct internal reasons to get there", async () => {
		const reasons: string[] = [];
		for (const { email, password } of REFUSALS) {
			const before = uniform.log.lines.length;
			await refuse(email, password);
			reasons.push(
				String(
					uniform.log.lines
						.slice(before)
						.map((line) => line.fields.reason)
						.at(-1),
				),
			);
		}

		expect(reasons).toEqual([
			"user_not_found",
			"password_mismatch",
			"no_password_credential",
			"user_disabled_on_sign_in",
			"legacy_scheme_rejected",
		]);
	});
});
