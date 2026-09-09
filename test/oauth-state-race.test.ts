import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { createVelveAuth } from "../src/index.js";
import { TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { codeCarrying, createStubProvider, oauthConfigFor } from "./oauth-provider.js";

/**
 * Eight rather than S-RACE-1's fifty, for the reason `factor-pending-race.test.ts` measured: the
 * connection budget is shared across the concurrency files and cumulative, and eight is genuine
 * simultaneity across eight connections. What is proved is the statement, not the count — exactly
 * one callback spends the state.
 */
const RACERS = 8;

type Handler = (request: Request) => Promise<Response>;

let owner: TestConnection;
let schema: string;
let keys: KeyProvider;
let fetchProvider: typeof globalThis.fetch;

function configOver(connection: TestConnection): VelveAuthConfig<"email"> {
	return {
		identity: { mode: "email" },
		database: connection,
		schema,
		keys,
		origins: [TEST_ORIGIN],
		email: { send: () => Promise.resolve() },
		oauth: oauthConfigFor({ openIdConnect: false }),
		fetch: fetchProvider,
	} as unknown as VelveAuthConfig<"email">;
}

/**
 * The token buckets live in the schema, so every instance over it shares them; each test is given
 * an address of its own so that one test's attempts do not spend the next one's capacity of ten.
 */
function handlerOver(connection: TestConnection, address: string): Handler {
	return toWebHandler(createVelveAuth(configOver(connection)), {
		connectionAddress: () => address,
	});
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("oauthstaterace");
	owner = migrated.connection;
	schema = migrated.schema;
	keys = testKeyProvider();
	fetchProvider = (
		await createStubProvider({
			claims: { sub: "raced-subject", email: "raced@example.com", email_verified: true },
		})
	).fetch;
});

afterAll(async () => {
	await dropSchema(owner, schema);
	await owner.close();
});

interface Started {
	readonly pointer: string;
	readonly state: string;
}

async function startFlow(handler: Handler): Promise<Started> {
	const response = await handler(
		new Request("https://api.example.com/sign-in/oauth/start", {
			method: "POST",
			headers: { Origin: TEST_ORIGIN, "Content-Type": "application/json" },
			body: JSON.stringify({ provider: "stubby" }),
		}),
	);
	const body = (await response.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	return {
		pointer: body.stateCookie.value,
		state: new URL(body.authorizationUrl).searchParams.get("state") ?? "",
	};
}

function callbackFor(started: Started, pointer: string | null): Request {
	const headers = new Headers();
	if (pointer !== null) {
		headers.set("Cookie", `__Host-velve_oauth_state=${pointer}`);
	}
	return new Request(
		`https://api.example.com/sign-in/oauth/callback/stubby?code=${codeCarrying(null)}&state=${encodeURIComponent(started.state)}`,
		{ method: "GET", headers },
	);
}

async function countRows(table: string): Promise<number> {
	const [row] = await owner.query<{ present: number }>(
		`SELECT count(*)::int AS present FROM ${schema}.${table}`,
		[],
	);
	return row?.present ?? -1;
}

async function clearFlowState(): Promise<void> {
	for (const table of ["session", "identity", "user", "oauth_flow"]) {
		await owner.query(`DELETE FROM ${schema}.${table}`, []);
	}
}

describe("S-CSRF-5 and S-RACE-1: a state is spendable once, under simultaneity", () => {
	it("lets exactly one of eight simultaneous callbacks through", async () => {
		await clearFlowState();
		const started = await startFlow(handlerOver(owner, "203.0.113.1"));
		const racers: TestConnection[] = [];
		for (let opened = 0; opened < RACERS; opened += 1) {
			racers.push(await openTestConnection());
		}

		try {
			const answers = await Promise.all(
				racers.map((racer) =>
					handlerOver(racer, "203.0.113.1")(callbackFor(started, started.pointer)),
				),
			);
			const statuses = answers.map((answer) => answer.status);

			expect(new Set(racers).size).toBe(RACERS);
			expect(statuses.filter((status) => status === 302)).toHaveLength(1);
			expect(statuses.filter((status) => status !== 302)).toHaveLength(RACERS - 1);
			expect(await countRows("oauth_flow")).toBe(0);
			expect(await countRows("identity")).toBe(1);
			expect(await countRows("session")).toBe(1);
			expect(await countRows("user")).toBe(1);
		} finally {
			await Promise.all(racers.map((racer) => racer.close()));
		}
	});

	it("writes no row for a callback presented with no cookie or with a foreign one", async () => {
		await clearFlowState();
		const handler = handlerOver(owner, "203.0.113.2");
		const started = await startFlow(handler);
		const foreign = await startFlow(handler);

		const withoutCookie = await handler(callbackFor(started, null));
		const withForeignPointer = await handler(callbackFor(started, foreign.pointer));

		expect([withoutCookie.status, withForeignPointer.status]).toStrictEqual([400, 400]);
		expect(await countRows("session")).toBe(0);
		expect(await countRows("identity")).toBe(0);
	});

	/**
	 * The pointer is checked before the row is consumed, so an attacker who has only the `state` —
	 * which travels in a URL and in a `Referer` — cannot burn a flow the victim has not finished.
	 */
	it("leaves the flow row spendable after a callback that failed the cookie check", async () => {
		await clearFlowState();
		const handler = handlerOver(owner, "203.0.113.3");
		const started = await startFlow(handler);
		const foreign = await startFlow(handler);

		await handler(callbackFor(started, null));
		await handler(callbackFor(started, foreign.pointer));
		const flowsBefore = await countRows("oauth_flow");
		const legitimate = await handler(callbackFor(started, started.pointer));

		expect(flowsBefore).toBe(2);
		expect(legitimate.status).toBe(302);
		expect(await countRows("session")).toBe(1);
	});
});
