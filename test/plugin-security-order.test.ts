import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { type MountedAuth, mountAuth, requestTo, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

const reached: string[] = [];
let frozenWhenReached: boolean | null = null;

function probeRoute(name: string, path: string, capacity: number): PluginRoute<"demo"> {
	return {
		name,
		method: "POST",
		path,
		input: object({}),
		errors: ["rate_limited", "origin_not_allowed"] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: { capacity, refillPerSecond: 0 }, perAccount: "none" },
		handler: (_input: unknown, context: RequestContext) => {
			reached.push(name);
			frozenWhenReached = Object.isFrozen(context.plugin);
			return Promise.resolve({ seen: true });
		},
	} as PluginRoute<"demo">;
}

const PLUGIN: VelvePlugin<"demo"> = {
	id: "demo",
	routes: [
		probeRoute("demo.open", "/x/demo/open", 100),
		probeRoute("demo.scarce", "/x/demo/scarce", 1),
	],
};

let mounted: MountedAuth;

/**
 * 3.15 D.2 folds a route's dotted name into an object path but only the core's tuples reach the
 * type, so a plugin's server method is read out of the surface at run time (E-743's first price).
 */
function serverMethodOf(name: string): (input: Record<string, unknown>) => Promise<unknown> {
	const found = name
		.split(".")
		.reduce<unknown>(
			(node, segment) => (node as Record<string, unknown> | undefined)?.[segment],
			mounted.auth,
		);
	if (typeof found !== "function") {
		throw new Error(`the instance carries no server method ${name}`);
	}
	return found as (input: Record<string, unknown>) => Promise<unknown>;
}

beforeAll(async () => {
	mounted = await mountAuth("pluginorder", { plugins: [PLUGIN] });
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

async function codeOf(answer: Response): Promise<string> {
	const body = (await answer.json()) as { error?: { code?: string } };
	return `${answer.status} ${body.error?.code ?? ""}`;
}

describe("a plugin route is a route of the table (3.11)", () => {
	it("joins the route table and the instance surface under its own namespace", () => {
		expect(mounted.auth.routes.map((route) => route.name)).toContain("demo.open");
		expect(typeof serverMethodOf("demo.open")).toBe("function");
	});

	it("answers a well-formed call", async () => {
		reached.length = 0;

		const answer = await mounted.handler(requestTo("/x/demo/open", { body: {} }));

		expect(answer.status).toBe(200);
		expect(reached).toStrictEqual(["demo.open"]);
	});

	/** T-CSRF-6: the context reaching plugin code is frozen. */
	it("hands the handler a frozen context", async () => {
		frozenWhenReached = null;

		await mounted.handler(requestTo("/x/demo/open", { body: {} }));

		expect(frozenWhenReached).toBe(true);
	});
});

describe("the origin check lies in front of plugin code (S-CSRF-6)", () => {
	it("refuses a foreign origin over HTTP without reaching the handler", async () => {
		reached.length = 0;

		const answer = await mounted.handler(
			requestTo("/x/demo/open", { body: {}, origin: "https://evil.example.com" }),
		);

		expect(await codeOf(answer)).toBe("403 origin_not_allowed");
		expect(reached).toStrictEqual([]);
	});

	it("refuses a missing origin over HTTP without reaching the handler", async () => {
		reached.length = 0;

		const answer = await mounted.handler(requestTo("/x/demo/open", { body: {}, origin: null }));

		expect(await codeOf(answer)).toBe("403 origin_not_allowed");
		expect(reached).toStrictEqual([]);
	});

	/** 3.11: "auch bei direkten Serveraufrufen" — the direct call is the path that must not skip it. */
	it("refuses a foreign origin on the direct server method without reaching the handler", async () => {
		reached.length = 0;

		await expect(
			serverMethodOf("demo.open")({ origin: "https://evil.example.com" }),
		).rejects.toMatchObject({ code: "origin_not_allowed" });
		await expect(serverMethodOf("demo.open")({ origin: null })).rejects.toMatchObject({
			code: "origin_not_allowed",
		});

		expect(reached).toStrictEqual([]);
	});

	it("reaches the handler on the direct server method when the origin is allowed", async () => {
		reached.length = 0;

		await serverMethodOf("demo.open")({ origin: TEST_ORIGIN });

		expect(reached).toStrictEqual(["demo.open"]);
	});
});

describe("the rate limiter lies in front of plugin code (S-CSRF-6)", () => {
	it("spends the bucket over HTTP and refuses the next call before the handler", async () => {
		reached.length = 0;

		const first = await mounted.handler(requestTo("/x/demo/scarce", { body: {} }));
		const second = await mounted.handler(requestTo("/x/demo/scarce", { body: {} }));

		expect(first.status).toBe(200);
		expect(await codeOf(second)).toBe("429 rate_limited");
		expect(reached).toStrictEqual(["demo.scarce"]);
	});

	it("counts the direct server call against the same bucket", async () => {
		reached.length = 0;

		await expect(serverMethodOf("demo.scarce")({ origin: TEST_ORIGIN })).rejects.toMatchObject({
			code: "rate_limited",
		});

		expect(reached).toStrictEqual([]);
	});
});
