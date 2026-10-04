import { describe, expect, it } from "vitest";
import { type AnyRoute, defineRoute, type RequestContext } from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { toWebHandler } from "../src/http/index.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, TEST_ORIGIN } from "./auth-fixtures.js";
import { widestVelveAuth } from "./client-fixtures.js";
import { unreachableDriver } from "./plugin-fixtures.js";

/**
 * The edges of E-2390 that T-CSRF-1's procedure names and the writer's test leaves open: every
 * checked route that is not reading, under every `Sec-Fetch-Site` form without an `Origin`, and a
 * plugin `GET` route however the plugins are ordered and whenever the route joins the table.
 */

const BASE_PATH = "/api/auth";

const ORIGIN_REJECTION = [
	"403",
	"cache-control: no-store",
	"content-type: application/json",
	"vary: Cookie",
	'{"error":{"code":"origin_not_allowed","message":"The request origin is not allowed."}}',
].join("\n");

const READING_ROUTES = [
	"session.read",
	"session.list",
	"username.isAvailable",
	"factor.webauthn.list",
	"factor.recovery.remaining",
	"identity.list",
	"pending.read",
];

const EXEMPT_ROUTES = ["signIn.oauth.callback", "signIn.oauth.callbackFormPost"];

const SITE_FORMS = ["same-origin", "same-site", "cross-site", "none", null] as const;

function requestTo(
	path: string,
	headers: Readonly<Record<string, string>>,
	method: string = "GET",
): Request {
	return new Request(`https://app.example.com${BASE_PATH}${path}`, {
		method,
		headers,
		...(method === "GET" ? {} : { body: "{}" }),
	});
}

function siteHeader(site: (typeof SITE_FORMS)[number]): Record<string, string> {
	return site === null ? {} : { "Sec-Fetch-Site": site };
}

async function serialised(response: Response): Promise<string> {
	const headers = [...response.headers]
		.map(([name, value]) => `${name}: ${value}`)
		.sort()
		.join("\n");
	return `${response.status}\n${headers}\n${await response.text()}`;
}

function filledPath(route: AnyRoute): string {
	const filled = route.path
		.split("/")
		.map((segment) => (segment.startsWith(":") ? "placeholder" : segment))
		.join("/");
	return route.name === "username.isAvailable" ? `${filled}?username=someone` : filled;
}

describe("T-CSRF-1 without an Origin, every route of the widest mount", () => {
	const auth = widestVelveAuth();
	const handler = toWebHandler(auth, { basePath: BASE_PATH });

	it("refuses every Sec-Fetch-Site form, and its absence, on every checked route that is not reading", async () => {
		const others = auth.routes.filter(
			(route) => route.originCheck === "checked" && !READING_ROUTES.includes(route.name),
		);

		expect(others.length).toBeGreaterThan(0);
		for (const route of others) {
			for (const site of SITE_FORMS) {
				const answer = await handler(requestTo(filledPath(route), siteHeader(site), route.method));
				expect([route.name, site, await serialised(answer)]).toStrictEqual([
					route.name,
					site,
					ORIGIN_REJECTION,
				]);
			}
		}
	});

	it("leaves exactly the two callbacks outside the check, so the matrix above covers the rest", () => {
		const exempt = auth.routes.filter((route) => route.originCheck !== "checked");

		expect(exempt.map((route) => route.name).sort()).toStrictEqual([...EXEMPT_ROUTES].sort());
	});

	it("refuses a Sec-Fetch-Site that only resembles same-origin on a reading route", async () => {
		for (const site of ["Same-Origin", "same-origin, same-origin", "same-origin;", "sameorigin"]) {
			const answer = await handler(requestTo("/session", { "Sec-Fetch-Site": site }));
			expect([site, await serialised(answer)]).toStrictEqual([site, ORIGIN_REJECTION]);
		}
	});

	it("refuses an empty Origin beside Sec-Fetch-Site same-origin, because a present Origin is compared", async () => {
		const answer = await handler(
			requestTo("/session", { Origin: "", "Sec-Fetch-Site": "same-origin" }),
		);

		expect(await serialised(answer)).toBe(ORIGIN_REJECTION);
	});
});

function recordingRoute<Id extends string>(id: Id, reached: string[]): PluginRoute<Id> {
	return {
		name: `${id}.read`,
		method: "GET",
		path: `/x/${id}/read`,
		input: object({}),
		errors: [] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: "none", perAccount: "none" },
		handler: (_input: unknown, _context: RequestContext) => {
			reached.push(`${id}.read`);
			return Promise.resolve({ seen: true });
		},
	} as PluginRoute<Id>;
}

function pluginOf<Id extends string>(id: Id, reached: string[]): VelvePlugin<Id> {
	return { id, routes: [recordingRoute(id, reached)] } as VelvePlugin<Id>;
}

describe("a plugin GET route is never reading (S-CSRF-6)", () => {
	for (const order of [
		["alpha", "beta"],
		["beta", "alpha"],
	] as const) {
		it(`refuses the same-origin form on every plugin route with the plugins in order ${order.join(", ")}`, async () => {
			const reached: string[] = [];
			const handler = toWebHandler(
				createVelveAuth(
					configFor({
						database: unreachableDriver(),
						plugins: order.map((id) => pluginOf(id, reached)),
					}),
				),
				{ basePath: BASE_PATH },
			);

			for (const id of order) {
				const answer = await handler(
					requestTo(`/x/${id}/read`, { "Sec-Fetch-Site": "same-origin" }),
				);
				expect([id, await serialised(answer)]).toStrictEqual([id, ORIGIN_REJECTION]);
			}
			expect(reached).toStrictEqual([]);

			for (const id of order) {
				const answer = await handler(requestTo(`/x/${id}/read`, { Origin: TEST_ORIGIN }));
				expect([id, answer.status]).toStrictEqual([id, 200]);
			}
			expect([...reached].sort()).toStrictEqual(["alpha.read", "beta.read"]);
		});
	}

	it("refuses the same-origin form on a GET route added to the table after the instance exists", async () => {
		const reached: string[] = [];
		const auth = createVelveAuth(configFor({ database: unreachableDriver() }));
		const handler = toWebHandler(auth, { basePath: BASE_PATH });
		const late = defineRoute({
			...recordingRoute("late", reached),
			name: "late.read",
			path: "/x/late/read",
		});
		(auth.http.routes as AnyRoute[]).push(late as unknown as AnyRoute);

		const refused = await handler(requestTo("/x/late/read", { "Sec-Fetch-Site": "same-origin" }));
		expect(await serialised(refused)).toBe(ORIGIN_REJECTION);
		expect(reached).toStrictEqual([]);

		const admitted = await handler(requestTo("/x/late/read", { Origin: TEST_ORIGIN }));
		expect(admitted.status).toBe(200);
		expect(reached).toStrictEqual(["late.read"]);
	});
});
