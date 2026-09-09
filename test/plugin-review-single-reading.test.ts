import { afterEach, describe, expect, it } from "vitest";
import { object } from "../src/core/http/validators.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { type MountedAuth, mountAuth } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { asJavaScriptPlugin } from "./plugin-fixtures.js";

const mounted: MountedAuth[] = [];

async function mount(plugins: readonly VelvePlugin[]): Promise<MountedAuth> {
	const instance = await mountAuth("pluginonereading", { plugins });
	mounted.push(instance);
	return instance;
}

afterEach(async () => {
	for (const instance of mounted.splice(0)) {
		await dropSchema(instance.connection, instance.schema);
		await instance.connection.close();
	}
});

function routeNamedTwice(names: readonly [string, string]): Readonly<Record<string, unknown>> {
	let reads = 0;
	return {
		method: "POST",
		path: "/x/probe/slow",
		input: object({}),
		errors: [],
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: "none", perAccount: "none" },
		handler: () => Promise.resolve({ seen: true }),
		get name() {
			reads += 1;
			return reads === 1 ? names[0] : names[1];
		},
	};
}

function routeNamed(name: string, path: string): Readonly<Record<string, unknown>> {
	return {
		name,
		method: "POST",
		path,
		input: object({}),
		errors: [],
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: "none", perAccount: "none" },
		handler: () => Promise.resolve({ seen: true }),
	};
}

/**
 * E-900 stopped the declaration being read twice for nine of its ten fields. `name` was read a
 * second time — once to look the rate-limit rule up and once to copy it — so a route could mount
 * under one name carrying the bucket declared for another.
 */
describe("a route name that answers differently to the rule lookup and to the table (3.15 G)", () => {
	it("gives the mounted route the bucket declared for the name it mounted under", async () => {
		const instance = await mount([
			asJavaScriptPlugin({
				id: "probe",
				routes: [
					routeNamedTwice(["probe.loose", "probe.slow"]),
					routeNamed("probe.loose", "/x/probe/loose"),
				],
				rateLimitRules: { "probe.slow": { perIpAddress: { capacity: 1, refillPerSecond: 0.01 } } },
			}),
		]);

		const slow = instance.auth.routes.find((route) => route.name === "probe.slow");

		expect(slow?.rateLimit.perIpAddress).toStrictEqual({ capacity: 1, refillPerSecond: 0.01 });
	});
});

/**
 * The list of plugins is a JavaScript value too, and `assertNoFieldOutsideTheInterface` walked it
 * before the reading copied it — so an index answering a clean object and then one carrying a
 * middleware kept the S-CSRF-6 warning the check exists to give.
 */
describe("a plugin list that answers differently to the check and to the reading (S-CSRF-6)", () => {
	it("refuses a list whose second reading carries a field the interface does not enumerate", async () => {
		let reads = 0;
		const plugins = new Proxy([{ id: "probe" }] as unknown as VelvePlugin[], {
			get(target, property, receiver) {
				if (property !== "0") {
					return Reflect.get(target, property, receiver) as unknown;
				}
				reads += 1;
				return reads === 1
					? { id: "probe" }
					: { id: "probe", securityMiddleware: () => Promise.resolve() };
			},
		});

		await expect(mount(plugins)).rejects.toMatchObject({ code: "plugin_field_unknown" });
	});
});
