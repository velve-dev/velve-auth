import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AnyRoute } from "../src/core/http/route.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

/**
 * A scan for the three names in `instance.ts` would answer "is this written here", which is not the
 * question. The question is whether what the module returns reaches the route table, so each seam
 * returns a probe route and the table is read afterwards.
 */
async function probeRoute(name: string, path: string): Promise<AnyRoute> {
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
		handler: async () => ({ reached: name }),
	});
}

vi.mock("../src/core/oauth/routes.js", async () => {
	const probe = await probeRoute("seam.oauth.probe", "/seam/oauth");
	return { oauthRoutes: () => [probe] };
});

vi.mock("../src/core/flows/routes.js", async () => {
	const probe = await probeRoute("seam.flows.probe", "/seam/flows");
	return { emailFlowRoutes: () => [probe] };
});

vi.mock("../src/core/plugin/routes.js", async () => {
	const probe = await probeRoute("seam.plugin.probe", "/seam/plugin");
	return { pluginRoutes: () => [probe] };
});

const SEAMS = [
	{ name: "seam.oauth.probe", path: "/seam/oauth" },
	{ name: "seam.flows.probe", path: "/seam/flows" },
	{ name: "seam.plugin.probe", path: "/seam/plugin" },
];

let mounted: MountedAuth;

beforeAll(async () => {
	mounted = await mountAuth("routeseams");
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

describe("the assembly composes the route table from every feature module", () => {
	it("carries all three contributions into the table", () => {
		const names = mounted.auth.routes.map((route) => route.name);

		expect(SEAMS).toHaveLength(3);
		expect(names.filter((name) => name.startsWith("seam."))).toStrictEqual(
			SEAMS.map((seam) => seam.name),
		);
	});

	it("answers on the HTTP path for each of the three", async () => {
		const bodies = await Promise.all(
			SEAMS.map(async (seam) => {
				const answer = await mounted.handler(requestTo(seam.path, { method: "GET" }));
				return `${answer.status} ${await answer.text()}`;
			}),
		);

		expect(bodies).toHaveLength(3);
		expect(bodies).toStrictEqual(
			SEAMS.map((seam) => `200 ${JSON.stringify({ reached: seam.name })}`),
		);
	});
});
