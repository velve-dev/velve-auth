import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import {
	type RequestContext,
	readsOAuthStateCookie,
	readsPendingCookie,
} from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { type MountedAuth, mountAuth, requestTo, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

const POINTER = "s".repeat(43);
const PENDING = "p".repeat(43);

interface Seen {
	readonly route: string;
	readonly oauthStateToken: string | null;
	readonly pendingToken: string | null;
}

const seen: Seen[] = [];

function reader(name: string, path: string, declared: "hidden" | "readable"): PluginRoute<"demo"> {
	return {
		name,
		method: "POST",
		path,
		input: object({}),
		errors: [] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		oauthStateCookie: declared,
		rateLimit: { perIpAddress: "none", perAccount: "none" },
		handler: (_input: unknown, context: RequestContext) => {
			seen.push({
				route: name,
				oauthStateToken: context.oauthStateToken,
				pendingToken: context.pendingToken,
			});
			return Promise.resolve(null);
		},
	} as PluginRoute<"demo">;
}

const PLUGIN: VelvePlugin<"demo"> = {
	id: "demo",
	routes: [
		reader("demo.declares", "/x/demo/declares", "readable"),
		reader("demo.silent", "/x/demo/silent", "hidden"),
	],
};

let mounted: MountedAuth;

beforeAll(async () => {
	mounted = await mountAuth("statepointer", { plugins: [PLUGIN] });
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

async function callOverHttp(path: string, cookie: string): Promise<Seen> {
	seen.length = 0;
	const answer = await mounted.handler(requestTo(path, { body: {}, cookie }));
	expect(answer.status).toBe(200);
	const last = seen.at(-1);
	if (last === undefined) {
		throw new Error(`${path} did not reach its handler`);
	}
	return last;
}

/**
 * S-CSRF-5 makes the pointer one half of a check whose other half is the row in `velve.oauth_flow`,
 * so no `caller` value implies it and a route that reads it says so in its declaration (E-736).
 */
describe("the state pointer reaches only the routes that declare it (S-CSRF-5)", () => {
	it("declares no core route a reader of the pointer", () => {
		const readers = mounted.auth.routes.filter(readsOAuthStateCookie).map((route) => route.name);

		expect(mounted.auth.routes.length).toBeGreaterThan(7);
		expect(readers).toStrictEqual(["demo.declares"]);
	});

	it("hands the value to the route that declares it readable", async () => {
		const observed = await callOverHttp(
			"/x/demo/declares",
			`${DEFAULT_COOKIE_NAMES.oauthState}=${POINTER}`,
		);

		expect(observed.oauthStateToken).toBe(POINTER);
	});

	it("answers a route that does not declare it exactly as if the cookie were absent", async () => {
		const withCookie = await callOverHttp(
			"/x/demo/silent",
			`${DEFAULT_COOKIE_NAMES.oauthState}=${POINTER}`,
		);
		const withoutCookie = await callOverHttp("/x/demo/silent", "unrelated=1");

		expect(withCookie.oauthStateToken).toBeNull();
		expect(withoutCookie.oauthStateToken).toBeNull();
	});

	it("passes the pointer on the direct server call only where it is declared", async () => {
		seen.length = 0;
		const declares = mounted.auth as unknown as Record<
			string,
			Record<string, (input: Record<string, unknown>) => Promise<unknown>>
		>;

		await declares.demo?.declares?.({ origin: TEST_ORIGIN, oauthStateToken: POINTER });
		await declares.demo?.silent?.({ origin: TEST_ORIGIN, oauthStateToken: POINTER });

		expect(seen.map((entry) => entry.oauthStateToken)).toStrictEqual([POINTER, null]);
	});
});

/**
 * The two declarations are independent: 3.15 D.3 keeps `__Host-velve_pending` to the four routes of
 * 3.6, and widening access to the pointer may not widen access to the pending state.
 */
describe("the pointer declaration does not widen access to the pending cookie (S-CACHE-4)", () => {
	it("shows the pending cookie to no route that only declares the pointer", async () => {
		const both = `${DEFAULT_COOKIE_NAMES.oauthState}=${POINTER}; ${DEFAULT_COOKIE_NAMES.pending}=${PENDING}`;

		const observed = await callOverHttp("/x/demo/declares", both);

		expect(observed.oauthStateToken).toBe(POINTER);
		expect(observed.pendingToken).toBeNull();
	});

	it("leaves the set of pending-cookie readers untouched by the new declaration", () => {
		const pendingReaders = mounted.auth.routes
			.filter(readsPendingCookie)
			.map((route) => route.name);

		expect(pendingReaders).not.toContain("demo.declares");
		expect(pendingReaders).not.toContain("demo.silent");
		expect(pendingReaders.length).toBeGreaterThanOrEqual(2);
	});
});
