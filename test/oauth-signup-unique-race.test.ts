import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth } from "../src/index.js";
import { TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { normalisedAnswer } from "./flows-fixtures.js";
import { backendPidOf, HeldDriver, waitUntilWaitingForALock } from "./lock-order-fixtures.js";
import { codeCarrying, createStubProvider, oauthConfigFor } from "./oauth-provider.js";

/**
 * Two provider accounts carrying one address sign up at the same time. Both find no account with
 * that address before their insert, and the second insert then meets `user_email_key` once the
 * first commits. Its answer has to be the one an address already taken gets without a race
 * (E-560), or a 500 tells the caller the address was claimed in that instant (S-ENUM-5).
 */

const CONTESTED = "contested-oauth@example.com";
const AFTER_THE_ACCOUNT_INSERT = /INSERT INTO \S*identity/;

type Handler = (request: Request) => Promise<Response>;

let schema: string;
let observer: TestConnection;
let firstConnection: TestConnection;
let secondConnection: TestConnection;
let held: HeldDriver;
let first: Handler;
let second: Handler;
const keys = testKeyProvider();

async function handlerOver(database: Driver, subject: string, address: string): Promise<Handler> {
	const provider = await createStubProvider({
		claims: { sub: subject, email: CONTESTED, email_verified: true },
	});
	const config = {
		identity: { mode: "email" },
		database,
		schema,
		keys,
		origins: [TEST_ORIGIN],
		email: { send: () => Promise.resolve() },
		oauth: oauthConfigFor({ openIdConnect: false }),
		fetch: provider.fetch,
	} as unknown as VelveAuthConfig<"email">;
	return toWebHandler(createVelveAuth(config), { connectionAddress: () => address });
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("oauthsignuprace");
	schema = migrated.schema;
	observer = migrated.connection;
	firstConnection = await openTestConnection();
	secondConnection = await openTestConnection();
	held = new HeldDriver(firstConnection);
	first = await handlerOver(held, "first-subject", "203.0.113.11");
	second = await handlerOver(secondConnection, "second-subject", "203.0.113.12");
}, 120_000);

afterAll(async () => {
	await dropSchema(observer, schema);
	await Promise.all([observer.close(), firstConnection.close(), secondConnection.close()]);
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

function callbackFor(started: Started): Request {
	return new Request(
		`https://api.example.com/sign-in/oauth/callback/stubby?code=${codeCarrying(null)}&state=${encodeURIComponent(started.state)}`,
		{ method: "GET", headers: { Cookie: `__Host-velve_oauth_state=${started.pointer}` } },
	);
}

describe("two OAuth sign-ups with one address at the same time (E-560, S-ENUM-5)", () => {
	it("answers the one that loses on the unique key as a taken address is answered without a race", async () => {
		const winnerFlow = await startFlow(first);
		const loserFlow = await startFlow(second);
		const pidOfSecond = await backendPidOf(secondConnection);

		const reachedAfterTheInsert = held.holdBefore(AFTER_THE_ACCOUNT_INSERT);
		const winning = first(callbackFor(winnerFlow));
		await reachedAfterTheInsert;
		const losing = second(callbackFor(loserFlow));
		await waitUntilWaitingForALock(observer, pidOfSecond, () => held.statements.join("\n"));
		held.release();

		const [won, lost] = await Promise.all([winning, losing]);
		const withoutARace = await second(callbackFor(await startFlow(second)));

		expect(won.status).toBe(302);
		expect(withoutARace.status).not.toBe(500);
		expect(await normalisedAnswer(lost)).toBe(await normalisedAnswer(withoutARace));
		const [row] = await observer.query<{ total: number }>(
			`SELECT count(*)::integer AS total FROM ${schema}.user WHERE email = $1`,
			[CONTESTED],
		);
		expect(row?.total).toBe(1);
	});
});
