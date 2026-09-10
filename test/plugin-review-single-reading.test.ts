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

const DECLARED_ROUTE_FIELDS: readonly string[] = [
	"name",
	"method",
	"path",
	"input",
	"errors",
	"caller",
	"freshness",
	"originCheck",
	"rateLimit",
	"handler",
];

function routeCountingItsReads(counts: Map<string, number>): Readonly<Record<string, unknown>> {
	const answers: Readonly<Record<string, unknown>> = {
		name: "probe.open",
		method: "POST",
		path: "/x/probe/open",
		input: object({}),
		errors: [],
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: "none", perAccount: "none" },
		handler: () => Promise.resolve({ seen: true }),
	};
	const spied: Record<string, unknown> = {};
	for (const field of DECLARED_ROUTE_FIELDS) {
		Object.defineProperty(spied, field, {
			enumerable: true,
			get: () => {
				counts.set(field, (counts.get(field) ?? 0) + 1);
				return answers[field];
			},
		});
	}
	return spied;
}

/**
 * E-900's claim about itself, as a measurement: a declaration read twice can answer twice, and the
 * defence is that nothing reads it a second time. Nine of the ten fields held; `name` was read once
 * for the rate-limit lookup and once for the copy, so a route could mount under one name carrying
 * the bucket declared for another.
 */
describe("what the start reads of a route declaration, counted (3.15 G)", () => {
	it("reads each of the ten declared fields exactly once", async () => {
		const counts = new Map<string, number>();

		await mount([asJavaScriptPlugin({ id: "probe", routes: [routeCountingItsReads(counts)] })]);

		expect([...counts].filter(([, reads]) => reads !== 1)).toStrictEqual([]);
		expect([...counts.keys()].sort()).toStrictEqual([...DECLARED_ROUTE_FIELDS].sort());
	});

	it("gives the mounted route the bucket declared for the name it was read under", async () => {
		const counts = new Map<string, number>();
		const instance = await mount([
			asJavaScriptPlugin({
				id: "probe",
				routes: [routeCountingItsReads(counts)],
				rateLimitRules: { "probe.open": { perIpAddress: { capacity: 1, refillPerSecond: 0.01 } } },
			}),
		]);

		const route = instance.auth.routes.find((mountedRoute) => mountedRoute.name === "probe.open");

		expect(route?.rateLimit.perIpAddress).toStrictEqual({ capacity: 1, refillPerSecond: 0.01 });
		expect(counts.get("name")).toBe(1);
	});
});

/**
 * The list of plugins is a value the application wrote too, and it was indexed twice inside the
 * registry: once by the field check and once by the reading, so an index answering a clean object
 * and then one carrying a `securityMiddleware` mounted the second while the first was checked.
 * Nothing escalates through it, because the reading carries only the fields the interface
 * enumerates — what is lost is the S-CSRF-6 warning the check exists to give.
 */
describe("what the start reads of the plugin list (S-CSRF-6)", () => {
	function listAnsweringTwice(
		answers: readonly [unknown, unknown],
		count: { reads: number },
	): readonly VelvePlugin[] {
		return new Proxy([answers[0]] as unknown as VelvePlugin[], {
			get(target, property, receiver) {
				if (property !== "0") {
					return Reflect.get(target, property, receiver) as unknown;
				}
				count.reads += 1;
				return count.reads === 1 ? answers[0] : answers[1];
			},
		});
	}

	it("mounts no route from a plugin the field check did not inspect", async () => {
		const count = { reads: 0 };
		const route = {
			name: "probe.open",
			method: "POST",
			path: "/x/probe/open",
			input: object({}),
			errors: [],
			caller: "anonymous",
			freshness: "not_required",
			originCheck: "checked",
			rateLimit: { perIpAddress: "none", perAccount: "none" },
			handler: () => Promise.resolve({ seen: true }),
		};

		const instance = await mount(
			listAnsweringTwice(
				[{ id: "probe" }, { id: "probe", routes: [route], securityMiddleware: () => undefined }],
				count,
			),
		);

		expect(
			instance.auth.routes.filter((mounted_) => mounted_.name.startsWith("probe.")),
		).toStrictEqual([]);
	});

	/**
	 * One reading for the check and the route table together. The second is the warning line that
	 * names the configured plugins, which reads `id` alone, decides nothing and lives in a file this
	 * feature does not own.
	 */
	it("indexes each configured plugin once for the check and the reading together", async () => {
		const count = { reads: 0 };

		await mount(listAnsweringTwice([{ id: "probe" }, { id: "probe" }], count));

		expect(count.reads).toBe(2);
	});
});
