import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import { VelveStartupError } from "../src/core/auth/startup.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import {
	type AnyRoute,
	type OAuthStateCookieAccess,
	readsOAuthStateCookie,
	readsPendingCookie,
} from "../src/core/http/route.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, type MountedAuth, mountAuth, requestTo, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { asJavaScriptPlugin, unreachableDriver } from "./plugin-fixtures.js";

const POINTER = "s".repeat(43);
const PENDING = "p".repeat(43);

/** Hoisted with the mock factory, which is lifted above every other statement in this file. */
const { DECLARES, SILENT } = vi.hoisted(() => ({
	DECLARES: { name: "seam.pointer.declares", path: "/seam/pointer/declares" },
	SILENT: { name: "seam.pointer.silent", path: "/seam/pointer/silent" },
}));

/**
 * E-769: the route that declares the pointer readable has to be a **core** route — 3.6 and S-CSRF-5 keep
 * both cookie declarations away from a plugin, so the seam module the OAuth callback will be
 * written in is the only place the mechanism can be exercised before wave 5 writes it.
 */
async function seamRoute(
	name: string,
	path: string,
	declared: OAuthStateCookieAccess | undefined,
): Promise<AnyRoute> {
	const { defineRoute } = await import("../src/core/http/route.js");
	const { object } = await import("../src/core/http/validators.js");
	return defineRoute({
		name,
		method: "GET",
		path,
		input: object({}),
		errors: [] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: "none", perAccount: "none" },
		...(declared === undefined ? {} : { oauthStateCookie: declared }),
		// `moveTokensIntoCookies` strips an output field called `pendingToken`, so the probe renames both.
		handler: async (_input, context) => ({
			pointer: context.oauthStateToken,
			pending: context.pendingToken,
		}),
	});
}

vi.mock("../src/core/oauth/routes.js", async () => {
	const declares = await seamRoute(DECLARES.name, DECLARES.path, "readable");
	const silent = await seamRoute(SILENT.name, SILENT.path, undefined);
	return { oauthRoutes: () => [declares, silent] };
});

/** A plugin with routes, so every reader set below is measured on the table that ships (E-763). */
const MOUNTED_PLUGIN: VelvePlugin<"demo"> = {
	id: "demo",
	routes: [
		{
			name: "demo.plain",
			method: "POST",
			path: "/x/demo/plain",
			input: { fields: [], parse: () => ({}) },
			errors: [] as const,
			caller: "anonymous",
			freshness: "not_required",
			originCheck: "checked",
			rateLimit: { perIpAddress: "none", perAccount: "none" },
			handler: () => Promise.resolve(null),
		} as PluginRoute<"demo">,
	],
};

let mounted: MountedAuth;

beforeAll(async () => {
	mounted = await mountAuth("statepointer", { plugins: [MOUNTED_PLUGIN] });
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

interface Seen {
	readonly pointer: string | null;
	readonly pending: string | null;
}

async function callOverHttp(path: string, cookie?: string): Promise<Seen> {
	const answer = await mounted.handler(
		requestTo(path, { method: "GET", ...(cookie === undefined ? {} : { cookie }) }),
	);
	expect(answer.status).toBe(200);
	return (await answer.json()) as Seen;
}

function serverMethodOf(name: string): (input: Record<string, unknown>) => Promise<Seen> {
	const found = name
		.split(".")
		.reduce<unknown>(
			(node, segment) => (node as Record<string, unknown> | undefined)?.[segment],
			mounted.auth,
		);
	if (typeof found !== "function") {
		throw new Error(`the instance carries no server method ${name}`);
	}
	return found as (input: Record<string, unknown>) => Promise<Seen>;
}

/**
 * S-CSRF-5 makes the pointer one half of a check whose other half is the row in `velve.oauth_flow`,
 * so no `caller` value implies it and a route that reads it says so in its declaration (E-736).
 */
describe("the state pointer reaches only the core route that declares it (S-CSRF-5)", () => {
	it("names one reader in the whole mounted table, and it is the declaring core route", () => {
		const readers = mounted.auth.routes.filter(readsOAuthStateCookie).map((route) => route.name);

		expect(mounted.auth.routes.map((route) => route.name)).toContain("demo.plain");
		expect(readers).toStrictEqual([DECLARES.name]);
	});

	it("hands the value to the route that declares it readable", async () => {
		const observed = await callOverHttp(
			DECLARES.path,
			`${DEFAULT_COOKIE_NAMES.oauthState}=${POINTER}`,
		);

		expect(observed.pointer).toBe(POINTER);
	});

	it("answers a route that does not declare it exactly as if the cookie were absent", async () => {
		const withCookie = await callOverHttp(
			SILENT.path,
			`${DEFAULT_COOKIE_NAMES.oauthState}=${POINTER}`,
		);
		const withoutCookie = await callOverHttp(SILENT.path);

		expect(withCookie.pointer).toBeNull();
		expect(withoutCookie.pointer).toBeNull();
	});

	it("passes the pointer on the direct server call only where it is declared", async () => {
		const declares = await serverMethodOf(DECLARES.name)({
			origin: TEST_ORIGIN,
			oauthStateToken: POINTER,
		});
		const silent = await serverMethodOf(SILENT.name)({
			origin: TEST_ORIGIN,
			oauthStateToken: POINTER,
		});

		expect(declares.pointer).toBe(POINTER);
		expect(silent.pointer).toBeNull();
	});

	it("shows the pending cookie to no route that only declares the pointer", async () => {
		const both = `${DEFAULT_COOKIE_NAMES.oauthState}=${POINTER}; ${DEFAULT_COOKIE_NAMES.pending}=${PENDING}`;

		const observed = await callOverHttp(DECLARES.path, both);

		expect(observed.pointer).toBe(POINTER);
		expect(observed.pending).toBeNull();
	});
});

/**
 * 3.6 names the four routes that accept `__Host-velve_pending` and says every other route ignores
 * it completely. A plugin route is one of the others, and this is the assertion
 * `test/auth-route-table.test.ts` cannot make: it mounts no plugins, so the rule it holds is the
 * rule in the core table and not the rule in the table that ships.
 */
describe("a plugin route cannot become a reader of either core cookie (3.6, S-CSRF-5)", () => {
	function routeCarrying(
		extra: Readonly<Record<string, unknown>>,
	): Readonly<Record<string, unknown>> {
		return {
			name: "attacker.peek",
			method: "POST",
			path: "/x/attacker/peek",
			input: { fields: [], parse: () => ({}) },
			errors: [],
			caller: "anonymous",
			freshness: "not_required",
			originCheck: "checked",
			rateLimit: { perIpAddress: "none", perAccount: "none" },
			handler: () => Promise.resolve(null),
			...extra,
		};
	}

	function codeOfRefusal(extra: Readonly<Record<string, unknown>>): string {
		const plugin = asJavaScriptPlugin({ id: "attacker", routes: [routeCarrying(extra)] });
		try {
			createVelveAuth(configFor({ database: unreachableDriver(), plugins: [plugin] }));
		} catch (cause) {
			return cause instanceof VelveStartupError
				? cause.code
				: `not a start error: ${String(cause)}`;
		}
		return "the configuration started";
	}

	it("refuses a plugin route declaring either cookie field, readable or hidden", () => {
		const declarations = [
			{ pendingCookie: "readable" },
			{ pendingCookie: "hidden" },
			{ oauthStateCookie: "readable" },
			{ oauthStateCookie: "hidden" },
			{ caller: "pending" },
		];

		expect(declarations.map((extra) => codeOfRefusal(extra))).toStrictEqual(
			declarations.map(() => "plugin_route_reads_a_core_cookie"),
		);
	});

	it("starts when the plugin route declares neither", () => {
		expect(codeOfRefusal({})).toBe("the configuration started");
	});

	it("refuses both fields and the pending caller at the type as well", () => {
		expectTypeOf<
			Extract<keyof PluginRoute<"demo">, "pendingCookie" | "oauthStateCookie">
		>().toEqualTypeOf<never>();
		expectTypeOf<PluginRoute<"demo">["caller"]>().toEqualTypeOf<
			"anonymous" | "session" | "server_only"
		>();
	});

	/**
	 * The assertion the review missed, in the form that survives the check being removed: whichever
	 * way the refusal is built, the mounted table must hold no plugin route among the readers.
	 */
	it("never becomes a reader of the mounted table, by refusal or by declaration", () => {
		const outcomes = [
			{ pendingCookie: "readable" },
			{ oauthStateCookie: "readable" },
			{ caller: "pending" },
		].map((extra) => {
			const plugin = asJavaScriptPlugin({ id: "attacker", routes: [routeCarrying(extra)] });
			try {
				const auth = createVelveAuth(
					configFor({ database: unreachableDriver(), plugins: [plugin] }),
				);
				return auth.routes
					.filter((route) => readsPendingCookie(route) || readsOAuthStateCookie(route))
					.map((route) => route.name)
					.filter((name) => name.startsWith("attacker."));
			} catch (cause) {
				return cause instanceof VelveStartupError ? [] : [`not a start error: ${String(cause)}`];
			}
		});

		expect(outcomes).toStrictEqual([[], [], []]);
	});

	it("leaves the pending-cookie readers of the mounted table exactly the six the core names", () => {
		const readers = mounted.auth.routes.filter(readsPendingCookie).map((route) => route.name);

		expect(mounted.auth.routes.map((route) => route.name)).toContain("demo.plain");
		expect(readers.filter((name) => name.startsWith("demo."))).toStrictEqual([]);
		expect(readers.length).toBeGreaterThanOrEqual(2);
	});

	it("answers a plugin route carrying only the pending cookie exactly as one carrying no cookie", async () => {
		const withPending = await mounted.handler(
			requestTo("/x/demo/plain", {
				body: {},
				cookie: `${DEFAULT_COOKIE_NAMES.pending}=${PENDING}`,
			}),
		);
		const withoutCookie = await mounted.handler(requestTo("/x/demo/plain", { body: {} }));

		expect(`${withPending.status} ${await withPending.text()}`).toBe(
			`${withoutCookie.status} ${await withoutCookie.text()}`,
		);
	});
});
