import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { PluginActor, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, TEST_ORIGIN } from "./auth-fixtures.js";
import { openConnectionPool } from "./connection-pool-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { CALLBACK_BASE_URL, codeCarrying, oauthConfigFor } from "./oauth-provider.js";

/**
 * An OAuth sign-up creates its account inside the callback's transaction and tells
 * `beforeUserCreate` and `afterUserCreate` there (3.11, 3.15 G). A pool, as every real driver has,
 * shows what a plugin meets: E-2584 settled that a hook told inside a transaction must not ask the
 * pool for a second connection, and E-2795 moved the password sign-up onto a connection lent from
 * its transaction for that reason. The same two properties hold for the OAuth path: the account
 * `afterUserCreate` names is one the plugin's own repositories can find, and as many concurrent
 * OAuth sign-ups as the pool has connections all finish when their hooks read.
 */

const POOL_SIZE = 3;
const ACQUIRE_TIMEOUT_MS = 10_000;
const BARRIER_TIMEOUT_MS = 5_000;
const PROVIDER_ORIGIN = "https://provider.example";
const ACTOR: PluginActor = { pluginId: "reader", reason: "the test reads the created account" };
const AN_ACCOUNT_THAT_DOES_NOT_EXIST = "00000000-0000-0000-0000-000000000000";

type Behaviour =
	| "find_the_created_account"
	| "wait_for_every_sign_up_then_read_after"
	| "wait_for_every_sign_up_then_read_before";
let behaviour: Behaviour = "find_the_created_account";
const foundOnCreate: (string | null)[] = [];

let arrived = 0;
let releaseBarrier: () => void = () => undefined;
let barrier = Promise.resolve();

function resetTheBarrier(): void {
	arrived = 0;
	barrier = new Promise<void>((resolve) => {
		releaseBarrier = resolve;
	});
}

function waitForEverySignUp(): Promise<void> {
	arrived += 1;
	if (arrived >= POOL_SIZE) {
		releaseBarrier();
	}
	return Promise.race([
		barrier,
		new Promise<void>((resolve) => setTimeout(resolve, BARRIER_TIMEOUT_MS)),
	]);
}

const READER: VelvePlugin<"reader"> = {
	id: "reader",
	hooks: {
		beforeUserCreate: async (_event, context) => {
			if (behaviour === "wait_for_every_sign_up_then_read_before") {
				await waitForEverySignUp();
				await context.repositories.findUserById({
					userId: AN_ACCOUNT_THAT_DOES_NOT_EXIST,
					actor: ACTOR,
				});
			}
		},
		afterUserCreate: async (event, context) => {
			if (behaviour === "wait_for_every_sign_up_then_read_after") {
				await waitForEverySignUp();
			}
			const found = await context.repositories.findUserById({ userId: event.userId, actor: ACTOR });
			foundOnCreate.push(found?.id ?? null);
		},
	},
};

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** A provider whose access token is the code it was handed, and whose subject is that token. */
const provider: typeof globalThis.fetch = async (input, init) => {
	const url = typeof input === "string" ? input : String(input);
	if (url.startsWith(`${PROVIDER_ORIGIN}/token`)) {
		const code = new URLSearchParams(String(init?.body ?? "")).get("code") ?? "";
		return json({ access_token: code, token_type: "Bearer", expires_in: 3600, scope: "email" });
	}
	if (url.startsWith(`${PROVIDER_ORIGIN}/userinfo`)) {
		const authorization = new Headers(init?.headers).get("Authorization") ?? "";
		const subject = authorization.replace(/^Bearer /, "");
		return json({ sub: subject, email: `${subject}@example.com`, email_verified: true });
	}
	return new Response("not found", { status: 404 });
};

let connection: TestConnection;
let pool: Awaited<ReturnType<typeof openConnectionPool>>;
let schema: string;
let handler: (request: Request) => Promise<Response>;

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("oauthsignuppool"));
	pool = await openConnectionPool(POOL_SIZE, { acquireTimeoutMs: ACQUIRE_TIMEOUT_MS });
	handler = toWebHandler(
		createVelveAuth(
			configFor({
				database: pool,
				schema,
				plugins: [READER],
				oauth: oauthConfigFor({ openIdConnect: false }),
				fetch: provider,
				rateLimit: {
					perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
					perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
				},
			}),
		),
	);
}, 120_000);

afterAll(async () => {
	await pool.close();
	await dropSchema(connection, schema);
	await connection.close();
});

beforeEach(() => {
	foundOnCreate.length = 0;
	resetTheBarrier();
});

/** Starts a flow and answers its callback with a code that is also the provider subject. */
async function oauthSignUp(): Promise<{ readonly answer: Response; readonly subject: string }> {
	const started = await handler(
		new Request("https://api.example.com/sign-in/oauth/start", {
			method: "POST",
			headers: { Origin: TEST_ORIGIN, "Content-Type": "application/json" },
			body: JSON.stringify({ provider: "stubby" }),
		}),
	);
	expect(started.status, await started.clone().text()).toBe(200);
	const body = (await started.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const state = new URL(body.authorizationUrl).searchParams.get("state") ?? "";
	const subject = codeCarrying(null);
	const answer = await handler(
		new Request(`${CALLBACK_BASE_URL}/stubby?code=${subject}&state=${encodeURIComponent(state)}`, {
			method: "GET",
			headers: { Cookie: `__Host-velve_oauth_state=${body.stateCookie.value}` },
		}),
	);
	return { answer, subject };
}

async function userIdOf(email: string): Promise<string | null> {
	const [row] = await connection.query<{ id: string }>(
		`SELECT id FROM ${schema}.user WHERE email = $1`,
		[email],
	);
	return row?.id ?? null;
}

describe("an OAuth sign-up's hooks reach a plugin as an after point promises (3.11, 3.15 G)", () => {
	it("lets afterUserCreate find the account it is told was created", async () => {
		behaviour = "find_the_created_account";

		const { answer, subject } = await oauthSignUp();

		expect(answer.status, await answer.clone().text()).toBe(302);
		expect(foundOnCreate).toStrictEqual([await userIdOf(`${subject}@example.com`)]);
	}, 60_000);

	it.each([
		"wait_for_every_sign_up_then_read_after",
		"wait_for_every_sign_up_then_read_before",
	] as const)(
		"completes as many concurrent OAuth sign-ups as the pool has connections (%s, E-2584)",
		async (reading) => {
			behaviour = reading;

			const signUps = await Promise.all(Array.from({ length: POOL_SIZE }, () => oauthSignUp()));

			expect(signUps.map(({ answer }) => answer.status)).toStrictEqual(
				Array.from({ length: POOL_SIZE }, () => 302),
			);
		},
		120_000,
	);
});
