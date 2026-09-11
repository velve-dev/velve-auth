import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { createTotpRepository } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { OAuthConfig } from "../src/core/oauth/config.js";
import { createVelveAuth } from "../src/index.js";
import { withoutComments } from "../tools/source-text.mjs";
import { configFor, TEST_ORIGIN } from "./auth-fixtures.js";
import {
	actorOfTestUser,
	dropSchema,
	openMigratedSchema,
	readUserOwnedTables,
} from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { accountLockAudit, HeldDriver } from "./lock-order-fixtures.js";
import {
	CALLBACK_BASE_URL,
	codeCarrying,
	createStubProvider,
	type StubProvider,
} from "./oauth-provider.js";

const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";
const PROVIDER = "stub";
const PROVIDER_ORIGIN = "https://provider.example";

type Handler = (request: Request) => Promise<Response>;

let connection: TestConnection;
let schema: string;
let owned: Set<string>;
let provider: StubProvider;

const coreDirectory = fileURLToPath(new URL("../src/core", import.meta.url));

beforeAll(async () => {
	const migrated = await openMigratedSchema("lockdecl");
	connection = migrated.connection;
	schema = migrated.schema;
	owned = new Set((await readUserOwnedTables(connection, schema)).map((table) => table.table));
	provider = await createStubProvider({
		claims: { sub: "linked-subject", email: "linked@example.com", email_verified: true },
	});
}, 120_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function oauthConfig(): OAuthConfig {
	return {
		providers: {
			[PROVIDER]: {
				clientId: "velve-test-client",
				clientSecret: "client-secret",
				authorizationEndpoint: `${PROVIDER_ORIGIN}/authorize`,
				tokenEndpoint: `${PROVIDER_ORIGIN}/token`,
				userInfoEndpoint: `${PROVIDER_ORIGIN}/userinfo`,
				subjectClaim: "sub",
				emailClaim: "email",
				emailVerifiedClaim: "email_verified",
			},
		},
		callbackBaseUrl: CALLBACK_BASE_URL,
		trustedProviders: [],
	} as unknown as OAuthConfig;
}

function handlerOn(database: Driver): Handler {
	return toWebHandler(
		createVelveAuth(
			configFor({
				database,
				schema,
				// A bucket that refused the second request would be measuring itself.
				rateLimit: {
					perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
					perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
				},
				fetch: provider.fetch,
				oauth: oauthConfig(),
			}),
		),
	);
}

function post(handler: Handler, path: string, body: unknown, cookie?: string): Promise<Response> {
	return handler(
		new Request(`https://api.example.com${path}`, {
			method: "POST",
			headers: {
				Origin: TEST_ORIGIN,
				"Content-Type": "application/json",
				...(cookie === undefined ? {} : { Cookie: cookie }),
			},
			body: JSON.stringify(body),
		}),
	);
}

function sessionCookieOf(answer: Response): string {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		if (pair.slice(0, pair.indexOf("=")) === DEFAULT_COOKIE_NAMES.session) {
			return pair;
		}
	}
	throw new Error("the answer carried no session cookie");
}

async function signUp(handler: Handler, address: string): Promise<string> {
	const answer = await post(handler, "/sign-up", { email: address, password: PASSWORD });
	if (answer.status !== 200) {
		throw new Error(`the sign-up answered ${answer.status}`);
	}
	return sessionCookieOf(answer);
}

/**
 * The audit reads the statements a transaction ran, so a transaction has only to be **driven** —
 * no second connection, no held statement, no interleaving. That is what makes these three sites
 * reachable in one file at unit cost, where `E-1625` put them at a wave of work (E-1657).
 */
async function auditOf(
	drive: (handler: Handler, held: HeldDriver) => Promise<void>,
): Promise<{ readonly late: string[]; readonly considered: number }> {
	const held = new HeldDriver(connection);
	await drive(handlerOn(held), held);
	return accountLockAudit(held.transactions, schema, owned);
}

/**
 * The three statements `E-1625` measured as deletable with the whole suite green. Each case reads
 * exactly one transaction and says so, so it cannot pass for having driven nothing, and a lock
 * deleted from the flow it drives reports the two tables that were left unordered.
 */
describe("every account lock outside the interleavings is declared before the tables it orders", () => {
	it("takes the account row before a password change writes the session and the credential", async () => {
		const { late, considered } = await auditOf(async (handler) => {
			const cookie = await signUp(handler, "change@example.com");
			const changed = await post(
				handler,
				"/password/change",
				{ currentPassword: PASSWORD, newPassword: REPLACEMENT },
				cookie,
			);
			expect(changed.status).toBe(200);
		});

		expect(late, late.join("\n")).toEqual([]);
		expect(considered).toBe(1);
	}, 60_000);

	it("takes the account row before a link writes the identity and re-issues the session", async () => {
		const { late, considered } = await auditOf(async (handler) => {
			const cookie = await signUp(handler, "link@example.com");
			const started = await post(handler, "/identity/link/start", { provider: PROVIDER }, cookie);
			expect(started.status).toBe(200);
			const body = (await started.json()) as {
				authorizationUrl: string;
				stateCookie: { value: string };
			};
			const url = new URL(body.authorizationUrl);
			const state = url.searchParams.get("state") ?? "";
			const code = codeCarrying(url.searchParams.get("nonce"));
			const back = await handler(
				new Request(
					`https://api.example.com/sign-in/oauth/callback/${PROVIDER}?code=${code}&state=${encodeURIComponent(state)}`,
					{
						method: "GET",
						headers: {
							Origin: TEST_ORIGIN,
							Cookie: `__Host-velve_oauth_state=${body.stateCookie.value}; ${cookie}`,
						},
					},
				),
			);
			expect(back.status).toBe(302);
		});

		expect(late, late.join("\n")).toEqual([]);
		expect(considered).toBe(1);
	}, 60_000);

	it("takes the account row before a TOTP removal deletes the credential and the used steps", async () => {
		const { late, considered } = await auditOf(async (handler, held) => {
			const cookie = await signUp(handler, "totp@example.com");
			const [account] = await connection.query<{ id: string }>(
				`SELECT id FROM ${schema}.user WHERE email = $1`,
				["totp@example.com"],
			);
			expect(cookie).not.toBe("");
			// The removal is a repository transaction; the route in front of it demands a current
			// code, which decides nothing about the order the transaction takes its locks in.
			await createTotpRepository({ driver: held, schema }).removeCredential({
				actor: actorOfTestUser(account?.id ?? ""),
			});
		});

		expect(late, late.join("\n")).toEqual([]);
		expect(considered).toBe(1);
	}, 60_000);

	/**
	 * The reach, counted rather than described. Eight statements take the account lock; this file
	 * drives three of them, `test/lock-order-race.test.ts` drives two, and the remaining three write
	 * fewer than two of the account's own tables, so the audit skips them by construction (E-1617).
	 * A ninth site added anywhere reddens this and has to be placed in that account.
	 */
	it("counts the statements that take the account lock, so the reach cannot drift unnoticed", () => {
		const CALL = /\blockAccountRow(?:Statement)?\s*\(/g;
		const sites = readdirSync(coreDirectory, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
			.map((entry) => `${entry.parentPath}/${entry.name}`)
			.sort()
			.map((path) => ({
				path: path.replace(`${coreDirectory}/`, ""),
				text: readFileSync(path, "utf8"),
			}))
			.filter((source) => source.path !== "db/lock.ts")
			.map((source) => ({
				path: source.path,
				count: (
					withoutComments(source.text)
						.split("\n")
						.filter((line) => !/^\s*import\b/.test(line))
						.join("\n")
						.match(CALL) ?? []
				).length,
			}))
			.filter((source) => source.count > 0);
		const total = sites.reduce((sum, source) => sum + source.count, 0);
		const listing = sites.map((source) => `${source.path}: ${source.count}`).join("\n");

		expect(sites.length, listing).toBeGreaterThan(5);
		expect(total, listing).toBe(8);
	});
});
