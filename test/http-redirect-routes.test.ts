import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { type MountedAuth, mountAuth, requestTo, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { codeCarrying, createStubProvider, oauthConfigFor } from "./oauth-provider.js";

/* ------------------------------------------------------------------ *
 * S-REDIR-3 and T-REDIR-3. The only Location the library emits is the
 * OAuth callback's 302. A route that is not one of the two callbacks
 * answers its output as JSON even when that output carries a field
 * named redirectToPath, and a plugin route is never a callback (E-2241).
 * ------------------------------------------------------------------ */

const BASE = "https://api.example.com";
const CALLBACK_ROUTES = ["signIn.oauth.callback", "signIn.oauth.callbackFormPost"];

function redirectingPluginRoute(name: string, target: string): PluginRoute<"redirector"> {
	return {
		name: `redirector.${name}`,
		method: "POST",
		path: `/x/redirector/${name}`,
		input: object({}),
		errors: [] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: "none", perAccount: "none" },
		handler: () => Promise.resolve({ redirectToPath: target }),
	};
}

const redirector: VelvePlugin<"redirector"> = {
	id: "redirector",
	routes: [
		redirectingPluginRoute("somewhere", "/somewhere"),
		redirectingPluginRoute("elsewhere", "//evil.example"),
	],
};

let mounted: MountedAuth;
const withLocation: string[] = [];
const answeredRoutes = new Set<string>();

/** Every answer of this file passes through here, which is the interceptor T-REDIR-3 asks for. */
async function intercepted(routeName: string, request: Request): Promise<Response> {
	const response = await mounted.handler(request);
	answeredRoutes.add(routeName);
	if (response.headers.has("Location")) {
		withLocation.push(routeName);
	}
	return response;
}

beforeAll(async () => {
	const provider = await createStubProvider({
		claims: { sub: "redirect-routes", email: "redirect-routes@example.com", email_verified: true },
	});
	mounted = await mountAuth("redirectroutes", {
		oauth: oauthConfigFor({ openIdConnect: false }),
		fetch: provider.fetch,
		plugins: [redirector],
		rateLimit: { perIpAddress: { capacity: 100_000, refillPerSecond: 1_000 } },
	});
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

interface Started {
	readonly pointer: string;
	readonly state: string;
}

async function startFlow(): Promise<Started> {
	const response = await intercepted(
		"signIn.oauth.start",
		requestTo("/sign-in/oauth/start", { body: { provider: "stubby", redirectPath: "/app" } }),
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

describe("a plugin route cannot answer with a Location (S-REDIR-3)", () => {
	it("answers a redirectToPath field as JSON and sets no Location", async () => {
		const response = await intercepted(
			"redirector.somewhere",
			requestTo("/x/redirector/somewhere", { body: {} }),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Location")).toBeNull();
		expect(await response.json()).toStrictEqual({ redirectToPath: "/somewhere" });
	});

	it("answers a field naming a host as JSON as well, and not as a failure", async () => {
		const response = await intercepted(
			"redirector.elsewhere",
			requestTo("/x/redirector/elsewhere", { body: {} }),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Location")).toBeNull();
	});
});

describe("Location occurs only on the OAuth callback (T-REDIR-3)", () => {
	it("is set by the two callbacks and by no other route of the mounted table", async () => {
		const routes = mounted.auth.http.routes.filter((route) => route.caller !== "server_only");
		for (const route of routes) {
			if (CALLBACK_ROUTES.includes(route.name)) {
				continue;
			}
			const path = route.path.replace(/:[^/]+/g, "stubby");
			await intercepted(
				route.name,
				route.method === "GET" ? requestTo(path, { method: "GET" }) : requestTo(path, { body: {} }),
			);
		}

		const forQuery = await startFlow();
		await intercepted(
			"signIn.oauth.callback",
			new Request(
				`${BASE}/sign-in/oauth/callback/stubby?code=${codeCarrying(null)}&state=${encodeURIComponent(forQuery.state)}`,
				{ method: "GET", headers: { Cookie: `__Host-velve_oauth_state=${forQuery.pointer}` } },
			),
		);
		const forForm = await startFlow();
		await intercepted(
			"signIn.oauth.callbackFormPost",
			new Request(`${BASE}/sign-in/oauth/callback/stubby`, {
				method: "POST",
				headers: {
					Origin: TEST_ORIGIN,
					"Content-Type": "application/x-www-form-urlencoded",
					Cookie: `__Host-velve_oauth_state=${forForm.pointer}`,
				},
				body: new URLSearchParams({ code: codeCarrying(null), state: forForm.state }),
			}),
		);

		expect(answeredRoutes.size).toBe(routes.length);
		expect([...new Set(withLocation)].sort()).toStrictEqual(CALLBACK_ROUTES);
	});
});
