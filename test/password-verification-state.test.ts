import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { normalisedAnswer, postTo } from "./flows-fixtures.js";

const PASSWORD = "correct-horse-battery-staple";
const WRONG_PASSWORD = "a-different-password-entirely";
const EMAIL = "verification.state@example.com";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

interface Attempt {
	readonly statements: readonly string[];
	readonly answer: Response;
}

let connection: TestConnection;
let schema: string;
let handler: (request: Request) => Promise<Response>;
let statements: string[];
let userId: string;

beforeAll(async () => {
	const opened = await openMigratedSchema("passwordverificationstate");
	connection = opened.connection;
	schema = opened.schema;
	statements = [];
	const driver: Driver = {
		query: (sql, params) => {
			statements.push(sql);
			return connection.query(sql, params);
		},
		transaction: (work) => connection.transaction(work),
	};
	const auth = createVelveAuth(
		configFor({
			database: driver,
			schema,
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		}),
	);
	handler = toWebHandler(auth);

	const signedUp = await handler(postTo("/sign-up", { email: EMAIL, password: PASSWORD }));
	expect(signedUp.status).toBe(200);
	userId = ((await signedUp.json()) as { user: { id: string } }).user.id;
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

async function signIn(password: string): Promise<Attempt> {
	statements.length = 0;
	const answer = await handler(postTo("/sign-in/password", { email: EMAIL, password }));
	return { statements: [...statements], answer };
}

async function markTheAddressVerified(): Promise<void> {
	await connection.query(`UPDATE ${schema}.user SET email_verified_at = now() WHERE id = $1`, [
		userId,
	]);
}

async function storedVerificationState(): Promise<Date | null> {
	const [row] = await connection.query<{ email_verified_at: Date | null }>(
		`SELECT email_verified_at FROM ${schema}.user WHERE id = $1`,
		[userId],
	);
	return row?.email_verified_at ?? null;
}

function sessionCookieOf(answer: Response): string | null {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === DEFAULT_COOKIE_NAMES.session) {
			return pair.slice(separator + 1);
		}
	}
	return null;
}

/**
 * The threshold compares two answers that must differ in one field, so everything that identifies
 * the *account* has to be held equal — which one account read twice does and two accounts cannot.
 */
interface SignedIn {
	readonly status: number;
	readonly body: { status?: string; user?: Record<string, unknown> };
	readonly sessionToken: string | null;
}

/** Collected rather than asserted, so a violation fails a named test instead of skipping four. */
async function attemptToSignIn(): Promise<SignedIn> {
	const { answer } = await signIn(PASSWORD);
	return {
		status: answer.status,
		body: (await answer.json()) as SignedIn["body"],
		sessionToken: sessionCookieOf(answer),
	};
}

function keysWhoseValuesDiffer(
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): string[] {
	const names = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...names]
		.filter((name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]))
		.sort();
}

describe("T-TIM-7: an unverified address changes nothing about signing in (S-TIM-7)", () => {
	let unverifiedRefusal: Attempt;
	let unverifiedSuccess: SignedIn;
	let verifiedRefusal: Attempt;
	let verifiedSuccess: SignedIn;

	let verificationBefore: Date | null = null;
	let verificationAfter: Date | null = null;

	beforeAll(async () => {
		verificationBefore = await storedVerificationState();
		unverifiedRefusal = await signIn(WRONG_PASSWORD);
		unverifiedSuccess = await attemptToSignIn();

		await markTheAddressVerified();

		verificationAfter = await storedVerificationState();
		verifiedRefusal = await signIn(WRONG_PASSWORD);
		verifiedSuccess = await attemptToSignIn();
	});

	it("reads the two states it means to compare", () => {
		expect(verificationBefore).toBeNull();
		expect(verificationAfter).not.toBeNull();
	});

	it("issues the same sequence of statements for a wrong password either way", () => {
		expect(verifiedRefusal.statements).toEqual(unverifiedRefusal.statements);
		expect(unverifiedRefusal.statements.length).toBeGreaterThan(0);
	});

	it("answers a wrong password with byte-identical responses either way", async () => {
		const unverified = await normalisedAnswer(unverifiedRefusal.answer);
		const verified = await normalisedAnswer(verifiedRefusal.answer);

		expect(verified).toBe(unverified);
		expect(unverified).toContain("status 401");
	});

	it("issues a session for a correct password either way, and a different one each time", () => {
		expect([unverifiedSuccess.status, verifiedSuccess.status]).toEqual([200, 200]);
		expect([unverifiedSuccess.body.status, verifiedSuccess.body.status]).toEqual([
			"signed_in",
			"signed_in",
		]);
		expect(unverifiedSuccess.sessionToken).not.toBeNull();
		expect(verifiedSuccess.sessionToken).not.toBeNull();
		expect(verifiedSuccess.sessionToken).not.toBe(unverifiedSuccess.sessionToken);
	});

	it("returns a user that differs in emailVerifiedAt and in nothing else", () => {
		const unverified = unverifiedSuccess.body.user ?? {};
		const verified = verifiedSuccess.body.user ?? {};

		expect(keysWhoseValuesDiffer(unverified, verified)).toEqual(["emailVerifiedAt"]);
		expect(unverified.emailVerifiedAt).toBeNull();
		expect(verified.emailVerifiedAt).not.toBeNull();
	});

	/**
	 * Without this the comparison above is vacuous: two users that carry one field each would also
	 * differ in exactly one key, and two absent users in none.
	 */
	it("compares a user with more than one field, so the one difference means something", () => {
		const unverified = unverifiedSuccess.body.user ?? {};

		expect(Object.keys(unverified).length).toBeGreaterThan(4);
		expect(Object.keys(unverified)).toContain("emailVerifiedAt");
	});
});

describe("no option withholds a session from an unverified address (S-TIM-7)", () => {
	const FORBIDDEN = "requireEmailVerification";

	function everySourceFile(directory: string): string[] {
		return readdirSync(directory, { recursive: true, encoding: "utf8" })
			.filter((entry) => entry.endsWith(".ts"))
			.map((entry) => `${directory}/${entry}`);
	}

	it("names it in no source file of the library, over a set that is not empty", () => {
		const files = everySourceFile(sourceRoot);
		const carrying = files.filter((path) => readFileSync(path, "utf8").includes(FORBIDDEN));

		expect(files.length).toBeGreaterThan(20);
		expect(carrying).toEqual([]);
	});

	/**
	 * `tsc --noEmit` is what fails here; `pnpm test` cannot, because a type that widens is still a
	 * value-level no-op. An earlier form of this assertion declared an empty array of the extracted
	 * key type and passed with the key present (E-1288).
	 */
	it("is not a key of the configuration type", () => {
		expectTypeOf<
			Extract<keyof VelveAuthConfig<"email">, "requireEmailVerification">
		>().toEqualTypeOf<never>();

		expect(FORBIDDEN).toBe("requireEmailVerification");
	});

	it("finds the file set it scans, so an empty scan is a failure and not a pass", () => {
		const files = everySourceFile(sourceRoot);

		expect(files.filter((path) => path.endsWith("src/index.ts"))).toHaveLength(1);
	});
});

describe("the sign-in path reads no verification state at all (S-TIM-7)", () => {
	it("names the column in no file of the password module", () => {
		const passwordModule = `${sourceRoot}/core/password`;
		const files = readdirSync(passwordModule, { recursive: true, encoding: "utf8" })
			.filter((entry) => entry.endsWith(".ts"))
			.map((entry) => `${passwordModule}/${entry}`);
		const carrying = files.filter((path) =>
			/email_verified|emailVerified/.test(readFileSync(path, "utf8")),
		);

		expect(files.length).toBeGreaterThan(5);
		expect(carrying).toEqual([]);
	});

	it("answers an origin the configuration allows, so the responses above were the route's", async () => {
		const answer = await handler(
			new Request("https://api.example.com/sign-in/password", {
				method: "POST",
				headers: { Origin: TEST_ORIGIN, "Content-Type": "application/json" },
				body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
			}),
		);

		expect(answer.status).toBe(200);
	});
});
