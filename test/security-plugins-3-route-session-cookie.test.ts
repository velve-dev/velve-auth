import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { type MountedAuth, mountAuth, requestTo, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

/**
 * 3.15 G.1 closes on "the plugin writes only into its own table and has no access to session
 * tokens or passwords", and 3.11 forbids a plugin to replace the session resolution. A plugin
 * route is a handler the pipeline runs with the core's own `RequestContext`, and its output goes
 * through the same `moveTokensIntoCookies` the core's sign-in routes use.
 */

const SESSION_COOKIE = "__Host-velve_session";
const PLANTED = "planted-by-the-plugin-route";

const seenTokens: (string | null)[] = [];

function route(
	name: string,
	path: string,
	handler: (context: RequestContext) => unknown,
): PluginRoute<"probe"> {
	return {
		name,
		method: "POST",
		path,
		input: object({}),
		errors: [] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: { capacity: 1000, refillPerSecond: 10 }, perAccount: "none" },
		handler: (_input: unknown, context: RequestContext) => Promise.resolve(handler(context)),
	} as unknown as PluginRoute<"probe">;
}

const PROBE: VelvePlugin<"probe"> = {
	id: "probe",
	routes: [
		route("probe.read", "/x/probe/read", (context) => {
			seenTokens.push(context.sessionToken);
			return { seen: true };
		}),
		route("probe.answer", "/x/probe/answer", () => ({ sessionToken: PLANTED })),
		route("probe.pending", "/x/probe/pending", () => ({ pendingToken: PLANTED })),
		route("probe.write", "/x/probe/write", (context) => {
			//a context without a cookie writer answers the call with a TypeError
			try {
				context.cookies.setSession(PLANTED);
			} catch {
				return { written: false };
			}
			return { written: true };
		}),
	],
};

let mounted: MountedAuth;
let victimToken: string;

beforeAll(async () => {
	mounted = await mountAuth("secplugcookie", { plugins: [PROBE] });
	const signedUp = await mounted.auth.signUp.withPassword({
		email: "victim@example.com",
		password: "correct-horse-battery-staple",
		origin: TEST_ORIGIN,
	});
	victimToken = signedUp.sessionToken;
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

function sessionCookieSetBy(response: Response): string | null {
	for (const line of response.headers.getSetCookie()) {
		if (line.startsWith(`${SESSION_COOKIE}=`)) {
			return line.slice(SESSION_COOKIE.length + 1).split(";")[0] ?? "";
		}
	}
	return null;
}

describe("a plugin route has no access to the session token (3.15 G.1, 3.11)", () => {
	it("does not hand an anonymous plugin route the caller's plaintext session token", async () => {
		seenTokens.length = 0;
		const response = await mounted.handler(
			requestTo("/x/probe/read", { body: {}, cookie: `${SESSION_COOKIE}=${victimToken}` }),
		);

		expect(response.status).toBe(200);
		expect(seenTokens).toHaveLength(1);
		expect(seenTokens[0], "the plugin handler read the caller's session cookie").not.toBe(
			victimToken,
		);
	});

	it("does not turn a sessionToken field a plugin route answers with into the session cookie", async () => {
		const response = await mounted.handler(requestTo("/x/probe/answer", { body: {} }));

		expect(response.status).toBe(200);
		expect(sessionCookieSetBy(response), "a plugin route wrote the session cookie").toBeNull();
	});

	it("does not turn a pendingToken field a plugin route answers with into the pending cookie", async () => {
		const response = await mounted.handler(requestTo("/x/probe/pending", { body: {} }));

		expect(response.status).toBe(200);
		const pendingLines = response.headers
			.getSetCookie()
			.filter((line) => line.startsWith("__Host-velve_pending="));
		expect(pendingLines, "a plugin route wrote the pending cookie").toStrictEqual([]);
	});

	it("does not let a plugin route write the session cookie through the request context", async () => {
		const response = await mounted.handler(requestTo("/x/probe/write", { body: {} }));

		expect(response.status).toBe(200);
		expect(sessionCookieSetBy(response), "a plugin route wrote the session cookie").toBeNull();
	});
});
