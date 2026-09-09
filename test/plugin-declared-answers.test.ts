import { afterEach, describe, expect, it } from "vitest";
import {
	forgetPluginErrorCodes,
	registerPluginErrorCodes,
	VelveError,
} from "../src/core/http/error-map.js";
import type { RateLimitRule } from "../src/core/http/rate-limit.js";
import type { RequestContext } from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { asJavaScriptPlugin } from "./plugin-fixtures.js";

const mounted: MountedAuth[] = [];

async function mount(plugins: readonly VelvePlugin[]): Promise<MountedAuth> {
	const instance = await mountAuth("plugindeclared", { plugins });
	mounted.push(instance);
	return instance;
}

afterEach(async () => {
	for (const instance of mounted.splice(0)) {
		await dropSchema(instance.connection, instance.schema);
		await instance.connection.close();
	}
	forgetPluginErrorCodes();
});

function throwingRoute(options: {
	readonly name: `quota.${string}`;
	readonly path: string;
	readonly thrown: string;
	readonly errors: readonly (`quota.${string}` | "rate_limited")[];
	readonly rateLimit?: RateLimitRule;
}): PluginRoute<"quota"> {
	return {
		name: options.name,
		method: "POST",
		path: `/x/quota/${options.path}`,
		input: object({}),
		errors: options.errors,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: options.rateLimit ?? { perIpAddress: "none", perAccount: "none" },
		handler: (_input: unknown, _context: RequestContext) =>
			Promise.reject(new VelveError(options.thrown as "internal_error")),
	} as PluginRoute<"quota">;
}

async function answerOf(instance: MountedAuth, path: string): Promise<string> {
	const response = await instance.handler(requestTo(`/x/quota/${path}`, { body: {} }));
	const body = (await response.json()) as { error?: { code?: string; message?: string } };
	return `${response.status} ${body.error?.code ?? ""} ${body.error?.message ?? ""}`.trim();
}

describe("a plugin's own error codes reach the caller (3.15 G, 3.15 F)", () => {
	it("answers a declared code with the code, a 400 and the library's own message", async () => {
		const instance = await mount([
			{
				id: "quota",
				errorCodes: ["quota.exceeded"],
				routes: [
					throwingRoute({
						name: "quota.spend",
						path: "spend",
						thrown: "quota.exceeded",
						errors: ["quota.exceeded"],
					}),
				],
			} satisfies VelvePlugin<"quota">,
		]);

		expect(await answerOf(instance, "spend")).toBe("400 quota.exceeded The request was refused.");
	});

	it("answers a code the plugin never declared as an internal error, and names it in nothing", async () => {
		const instance = await mount([
			{
				id: "quota",
				errorCodes: ["quota.exceeded"],
				routes: [
					throwingRoute({
						name: "quota.slip",
						path: "slip",
						thrown: "quota.never-declared",
						errors: ["quota.exceeded"],
					}),
				],
			} satisfies VelvePlugin<"quota">,
		]);

		expect(await answerOf(instance, "slip")).toBe(
			"500 internal_error The request could not be completed.",
		);
	});

	it("leaves an answer an application registered itself alone, in either order", async () => {
		registerPluginErrorCodes({ "quota.exceeded": { httpStatus: 429, message: "Slow down." } });
		const instance = await mount([
			{
				id: "quota",
				errorCodes: ["quota.exceeded"],
				routes: [
					throwingRoute({
						name: "quota.spend",
						path: "spend",
						thrown: "quota.exceeded",
						errors: ["quota.exceeded"],
					}),
				],
			} satisfies VelvePlugin<"quota">,
		]);

		expect(await answerOf(instance, "spend")).toBe("429 quota.exceeded Slow down.");
	});

	it("refuses a route naming an error code the plugin does not declare", async () => {
		await expect(
			mount([
				{
					id: "quota",
					routes: [
						throwingRoute({
							name: "quota.spend",
							path: "spend",
							thrown: "quota.exceeded",
							errors: ["quota.exceeded"],
						}),
					],
				} satisfies VelvePlugin<"quota">,
			]),
		).rejects.toMatchObject({ code: "plugin_error_code_undeclared" });
	});

	it("refuses an error code outside the plugin's own namespace (S-DEFAULT-5)", async () => {
		await expect(
			mount([asJavaScriptPlugin({ id: "quota", errorCodes: ["billing.exceeded"] })]),
		).rejects.toMatchObject({ code: "plugin_error_code_not_namespaced" });
	});
});

describe("a plugin's rateLimitRules replace the limit its own route declares (3.15 G)", () => {
	function countingRoute(): PluginRoute<"quota"> {
		return {
			name: "quota.spend",
			method: "POST",
			path: "/x/quota/spend",
			input: object({}),
			errors: ["rate_limited"] as const,
			caller: "anonymous",
			freshness: "not_required",
			originCheck: "checked",
			rateLimit: { perIpAddress: { capacity: 100, refillPerSecond: 0 }, perAccount: "none" },
			handler: () => Promise.resolve({ seen: true }),
		} as PluginRoute<"quota">;
	}

	it("spends the bucket the map names and not the one the route declares", async () => {
		const instance = await mount([
			{
				id: "quota",
				routes: [countingRoute()],
				rateLimitRules: {
					"quota.spend": { perIpAddress: { capacity: 1, refillPerSecond: 0 }, perAccount: "none" },
				},
			} satisfies VelvePlugin<"quota">,
		]);

		const first = await instance.handler(requestTo("/x/quota/spend", { body: {} }));
		const second = await instance.handler(requestTo("/x/quota/spend", { body: {} }));

		expect(first.status).toBe(200);
		expect(second.status).toBe(429);
	});

	it("refuses a rule keyed on a route the plugin does not contribute", async () => {
		await expect(
			mount([
				asJavaScriptPlugin({
					id: "quota",
					routes: [countingRoute()],
					rateLimitRules: {
						"session.revoke": {
							perIpAddress: { capacity: 1_000_000, refillPerSecond: 0 },
							perAccount: "none",
						},
					},
				}),
			]),
		).rejects.toMatchObject({ code: "plugin_rate_limit_rule_unmatched" });
	});
});

describe("a plugin route cannot exempt itself from the origin check (S-CSRF-6)", () => {
	function exemptRoute(originCheck: unknown): Readonly<Record<string, unknown>> {
		return {
			name: "quota.spend",
			method: "POST",
			path: "/x/quota/spend",
			input: object({}),
			errors: [],
			caller: "anonymous",
			freshness: "not_required",
			originCheck,
			rateLimit: { perIpAddress: "none", perAccount: "none" },
			handler: () => Promise.resolve({ seen: true }),
		};
	}

	it("refuses a route declaring itself exempt", async () => {
		await expect(
			mount([asJavaScriptPlugin({ id: "quota", routes: [exemptRoute("exempt")] })]),
		).rejects.toMatchObject({ code: "plugin_route_exempts_the_origin_check" });
	});

	it("refuses a route that declares no origin requirement at all", async () => {
		await expect(
			mount([asJavaScriptPlugin({ id: "quota", routes: [exemptRoute(undefined)] })]),
		).rejects.toMatchObject({ code: "plugin_route_exempts_the_origin_check" });
	});

	/**
	 * S-CSRF-1 over the table that ships. `test/auth-route-table.test.ts` reads the same property
	 * and mounts without plugins, so until here nothing read it over a table a plugin contributed to.
	 */
	it("leaves the OAuth callback as the only exempt route in a table mounted with a plugin", async () => {
		const instance = await mount([
			asJavaScriptPlugin({ id: "quota", routes: [exemptRoute("checked")] }),
		]);

		const exempt = instance.auth.routes
			.filter((route) => route.originCheck !== "checked")
			.map((route) => route.name);

		expect(exempt.filter((name) => name !== "signIn.oauth.callback")).toStrictEqual([]);
	});
});

/**
 * A route name folds into an object path (3.15 D.2), and `${Id}.${string}` admits a segment every
 * object already carries. The fold refuses these by name; it also builds the path out of own
 * properties, so neither half depends on the other (E-656).
 */
describe("a route name may not fold onto something every object has", () => {
	function namedRoute(name: string): Readonly<Record<string, unknown>> {
		return {
			name,
			method: "POST",
			path: "/x/quota/spend",
			input: object({}),
			errors: [],
			caller: "anonymous",
			freshness: "not_required",
			originCheck: "checked",
			rateLimit: { perIpAddress: "none", perAccount: "none" },
			handler: () => Promise.resolve({ seen: true }),
		};
	}

	it("refuses constructor as the last segment of a route name", async () => {
		await expect(
			mount([asJavaScriptPlugin({ id: "quota", routes: [namedRoute("quota.constructor")] })]),
		).rejects.toMatchObject({ code: "route_name_segment_reserved" });
	});

	it("refuses __proto__ as a segment in the middle of one", async () => {
		await expect(
			mount([asJavaScriptPlugin({ id: "quota", routes: [namedRoute("quota.__proto__.spend")] })]),
		).rejects.toMatchObject({ code: "route_name_segment_reserved" });
	});
});
