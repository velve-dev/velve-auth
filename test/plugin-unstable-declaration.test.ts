import { afterEach, describe, expect, it } from "vitest";
import { readsPendingCookie } from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { asJavaScriptPlugin } from "./plugin-fixtures.js";

const mounted: MountedAuth[] = [];
const reached: string[] = [];

async function mount(plugins: readonly VelvePlugin[]): Promise<MountedAuth> {
	const instance = await mountAuth("pluginunstable", { plugins });
	mounted.push(instance);
	return instance;
}

afterEach(async () => {
	for (const instance of mounted.splice(0)) {
		await dropSchema(instance.connection, instance.schema);
		await instance.connection.close();
	}
	reached.length = 0;
});

/**
 * A declaration is a JavaScript object a plugin wrote, so any of its fields may be an accessor that
 * answers differently each time it is read. The checks read it and the route table read it again,
 * and nothing obliged the two to agree (E-900).
 */
function routeAnsweringTwice(
	field: string,
	values: readonly [unknown, unknown],
): Readonly<Record<string, unknown>> {
	let reads = 0;
	return {
		name: "demo.open",
		method: "POST",
		path: "/x/demo/open",
		input: object({}),
		errors: [],
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: "none", perAccount: "none" },
		handler: () => {
			reached.push("demo.open");
			return Promise.resolve({ seen: true });
		},
		get [field]() {
			reads += 1;
			return reads === 1 ? values[0] : values[1];
		},
	};
}

describe("a declaration that answers one way to the check and another to the table (S-CSRF-6)", () => {
	it("keeps the origin check on a route whose originCheck turns exempt after it is read", async () => {
		const instance = await mount([
			asJavaScriptPlugin({
				id: "demo",
				routes: [routeAnsweringTwice("originCheck", ["checked", "exempt"])],
			}),
		]);

		const answer = await instance.handler(
			requestTo("/x/demo/open", { body: {}, origin: "https://evil.example.com" }),
		);

		expect(answer.status).toBe(403);
		expect(reached).toStrictEqual([]);
		expect(instance.auth.routes.map((route) => route.originCheck)).not.toContain("exempt");
	});

	/** 3.6 enumerates four routes that read `__Host-velve_pending`, and a plugin route is not one. */
	it("adds no reader of the pending cookie through a caller that turns pending after it is read", async () => {
		const instance = await mount([
			asJavaScriptPlugin({
				id: "demo",
				routes: [routeAnsweringTwice("caller", ["anonymous", "pending"])],
			}),
		]);

		const contributed = instance.auth.routes.filter((route) => route.name.startsWith("demo."));

		expect(contributed.map((route) => route.caller)).toStrictEqual(["anonymous"]);
		expect(contributed.filter(readsPendingCookie)).toStrictEqual([]);
	});

	it("answers the path the check read, not the one the table would have read second", async () => {
		const instance = await mount([
			asJavaScriptPlugin({
				id: "demo",
				routes: [routeAnsweringTwice("path", ["/x/demo/open", "/session/revoke"])],
			}),
		]);

		expect(instance.auth.routes.map((route) => route.path)).toContain("/x/demo/open");
		expect(instance.auth.routes.filter((route) => route.path === "/session/revoke")).toHaveLength(
			1,
		);
	});
});

/**
 * The most ordinary way to write a plugin is a class, and a class carries its methods on a
 * prototype. `Object.keys` saw none of them, so the field the check exists to refuse was accepted
 * (E-901).
 */
describe("a plugin written as a class instance", () => {
	class PluginWithAMiddleware {
		readonly id = "demo";
		securityMiddleware(): void {
			reached.push("middleware");
		}
	}

	class PluginWithNothingElse {
		readonly id = "demo";
	}

	class HooksWithAnExtraPoint {
		beforeSignIn(): Promise<void> {
			return Promise.resolve();
		}
		afterEverything(): Promise<void> {
			return Promise.resolve();
		}
	}

	it("refuses one carrying a field the interface does not enumerate on its prototype", async () => {
		await expect(
			mount([
				asJavaScriptPlugin(new PluginWithAMiddleware() as unknown as Record<string, unknown>),
			]),
		).rejects.toMatchObject({ code: "plugin_field_unknown" });
	});

	it("refuses hooks carrying a point that is not one of the seven on their prototype", async () => {
		await expect(
			mount([
				asJavaScriptPlugin({ id: "demo", hooks: new HooksWithAnExtraPoint() as unknown as never }),
			]),
		).rejects.toMatchObject({ code: "plugin_field_unknown" });
	});

	it("refuses a field the interface does not enumerate that is not enumerable", async () => {
		const plugin = { id: "demo" };
		Object.defineProperty(plugin, "securityMiddleware", { value: () => undefined });

		await expect(mount([asJavaScriptPlugin(plugin)])).rejects.toMatchObject({
			code: "plugin_field_unknown",
		});
	});

	it("starts one that carries nothing but what the interface names", async () => {
		const instance = await mount([
			asJavaScriptPlugin(new PluginWithNothingElse() as unknown as Record<string, unknown>),
		]);

		expect(instance.auth.routes.length).toBeGreaterThan(0);
	});
});

/** E-645 says a rule the map names replaces the route's own; a rule on a prototype did neither. */
describe("a rateLimitRules map carried on a prototype", () => {
	it("applies the rule it names, rather than passing it over in silence", async () => {
		const rules = Object.create({
			"demo.open": { perIpAddress: { capacity: 1, refillPerSecond: 0 }, perAccount: "none" },
		}) as Record<string, unknown>;
		const instance = await mount([
			asJavaScriptPlugin({
				id: "demo",
				rateLimitRules: rules,
				routes: [
					{
						name: "demo.open",
						method: "POST",
						path: "/x/demo/open",
						input: object({}),
						errors: ["rate_limited"],
						caller: "anonymous",
						freshness: "not_required",
						originCheck: "checked",
						rateLimit: { perIpAddress: { capacity: 100, refillPerSecond: 0 }, perAccount: "none" },
						handler: () => Promise.resolve({ seen: true }),
					},
				],
			}),
		]);

		const first = await instance.handler(requestTo("/x/demo/open", { body: {} }));
		const second = await instance.handler(requestTo("/x/demo/open", { body: {} }));

		expect(first.status).toBe(200);
		expect(second.status).toBe(429);
	});
});
