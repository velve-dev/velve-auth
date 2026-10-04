import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import type { AnyRoute, RequestContext } from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { toWebHandler } from "../src/http/index.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, type MountedAuth, mountAuth, TEST_ORIGIN } from "./auth-fixtures.js";
import { widestVelveAuth } from "./client-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";

/**
 * A browser sends no `Origin` on a same-origin GET made with `fetch`, and sends
 * `Sec-Fetch-Site: same-origin` instead, which no page script can set. The reading routes S-CSRF-4
 * names are reached that way by the application's own pages; nothing else is (E-2390).
 */

const BASE_PATH = "/api/auth";

/** The rejection every origin failure answers, as `test/http-origin-hardening.test.ts` fixes it. */
const ORIGIN_REJECTION = [
	"403",
	"cache-control: no-store",
	"content-type: application/json",
	"vary: Cookie",
	'{"error":{"code":"origin_not_allowed","message":"The request origin is not allowed."}}',
].join("\n");

/** The seven reading routes of S-CSRF-4, which with the callback are every GET the core serves. */
const READING_ROUTES = [
	"session.read",
	"session.list",
	"username.isAvailable",
	"factor.webauthn.list",
	"factor.recovery.remaining",
	"identity.list",
	"pending.read",
];

const QUERY_BY_ROUTE: Readonly<Record<string, string>> = {
	"username.isAvailable": "?username=someone",
};

function readFrom(
	path: string,
	headers: Readonly<Record<string, string>>,
	method: "GET" | "POST" = "GET",
): Request {
	return new Request(`https://app.example.com${BASE_PATH}${path}`, {
		method,
		headers,
		...(method === "POST" ? { body: "{}" } : {}),
	});
}

async function serialised(response: Response): Promise<string> {
	const headers = [...response.headers]
		.map(([name, value]) => `${name}: ${value}`)
		.sort()
		.join("\n");
	return `${response.status}\n${headers}\n${await response.text()}`;
}

function sessionCookieOf(answer: Response): string {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === DEFAULT_COOKIE_NAMES.session) {
			return pair;
		}
	}
	throw new Error("the sign-up answered no session cookie");
}

let mounted: MountedAuth;
let handler: (request: Request) => Promise<Response>;
let cookie: string;
let userId: string;

beforeAll(async () => {
	mounted = await mountAuth("sameorigin");
	handler = toWebHandler(mounted.auth, { basePath: BASE_PATH });
	const answer = await mounted.handler(
		postTo("/sign-up", { email: "reader@example.com", password: "correct-horse-battery-staple" }),
	);
	expect(answer.status).toBe(200);
	cookie = sessionCookieOf(answer);
	userId = ((await answer.json()) as { user: { id: string } }).user.id;
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

describe("a reading GET from the application's own origin (S-CSRF-1, S-CSRF-4)", () => {
	it("answers GET /session with no Origin and Sec-Fetch-Site same-origin", async () => {
		const answer = await handler(
			readFrom("/session", { Cookie: cookie, "Sec-Fetch-Site": "same-origin" }),
		);

		expect(answer.status).toBe(200);
		const body = (await answer.json()) as { user?: { id?: string } } | null;
		expect(body?.user?.id).toBe(userId);
	});

	it("refuses every other Sec-Fetch-Site value, and its absence, byte-identically", async () => {
		const answers: string[] = [];
		for (const site of ["cross-site", "same-site", "none", "SAME-ORIGIN", "same-origin, none"]) {
			answers.push(
				await serialised(
					await handler(readFrom("/session", { Cookie: cookie, "Sec-Fetch-Site": site })),
				),
			);
		}
		answers.push(await serialised(await handler(readFrom("/session", { Cookie: cookie }))));

		expect(answers).toStrictEqual(answers.map(() => ORIGIN_REJECTION));
	});

	it("still compares an Origin that is present, whatever Sec-Fetch-Site says (S-CSRF-2)", async () => {
		for (const origin of ["https://evil.example.com", "null"]) {
			const answer = await handler(
				readFrom("/session", { Cookie: cookie, Origin: origin, "Sec-Fetch-Site": "same-origin" }),
			);
			expect([origin, await serialised(answer)]).toStrictEqual([origin, ORIGIN_REJECTION]);
		}
	});

	it("refuses a POST with no Origin even when Sec-Fetch-Site says same-origin", async () => {
		const answer = await handler(
			readFrom("/session/revoke-all", { Cookie: cookie, "Sec-Fetch-Site": "same-origin" }, "POST"),
		);

		expect(await serialised(answer)).toBe(ORIGIN_REJECTION);
		const still = await handler(
			readFrom("/session", {
				Cookie: cookie,
				Origin: TEST_ORIGIN,
				"Sec-Fetch-Site": "same-origin",
			}),
		);
		expect(((await still.json()) as { user?: { id?: string } } | null)?.user?.id).toBe(userId);
	});

	it("leaves the direct server method as strict as before", async () => {
		await expect(
			mounted.auth.session.resolve({ origin: null, sessionToken: cookie.split("=")[1] ?? "" }),
		).rejects.toMatchObject({ code: "origin_not_allowed" });
	});
});

describe("every reading GET of the widest mount", () => {
	const auth = widestVelveAuth();
	const widest = toWebHandler(auth, { basePath: BASE_PATH });
	const reading = auth.routes.filter(
		(route) => route.method === "GET" && route.originCheck === "checked",
	);

	function pathOf(route: AnyRoute): string {
		const filled = route.path
			.split("/")
			.map((segment) => (segment.startsWith(":") ? "placeholder" : segment))
			.join("/");
		return `${filled}${QUERY_BY_ROUTE[route.name] ?? ""}`;
	}

	it("is exactly the seven reading routes S-CSRF-4 names", () => {
		expect(reading.map((route) => route.name).sort()).toStrictEqual([...READING_ROUTES].sort());
	});

	it("answers the same-origin form exactly as it answers the configured Origin", async () => {
		for (const route of reading) {
			const withOrigin = await serialised(
				await widest(readFrom(pathOf(route), { Origin: TEST_ORIGIN })),
			);
			const sameOrigin = await serialised(
				await widest(readFrom(pathOf(route), { "Sec-Fetch-Site": "same-origin" })),
			);

			expect([route.name, sameOrigin]).toStrictEqual([route.name, withOrigin]);
			expect([route.name, sameOrigin]).not.toStrictEqual([route.name, ORIGIN_REJECTION]);
		}
	});

	it("refuses every other Sec-Fetch-Site form, and its absence, on every one of them", async () => {
		for (const route of reading) {
			for (const site of ["cross-site", "same-site", "none", null]) {
				const answer = await widest(
					readFrom(pathOf(route), site === null ? {} : { "Sec-Fetch-Site": site }),
				);
				expect([route.name, site, await serialised(answer)]).toStrictEqual([
					route.name,
					site,
					ORIGIN_REJECTION,
				]);
			}
		}
	});

	it("refuses the same-origin form without an Origin on every other checked route", async () => {
		const others = auth.routes.filter(
			(route) => route.originCheck === "checked" && !reading.includes(route),
		);

		expect(others.length).toBeGreaterThan(0);
		for (const route of others) {
			const answer = await widest(
				readFrom(pathOf(route), { "Sec-Fetch-Site": "same-origin" }, route.method),
			);
			expect([route.name, await serialised(answer)]).toStrictEqual([route.name, ORIGIN_REJECTION]);
		}
	});
});

describe("a plugin's GET route, which nothing proves is reading (S-CSRF-1)", () => {
	const reached: string[] = [];
	const route: PluginRoute<"demo"> = {
		name: "demo.read",
		method: "GET",
		path: "/x/demo/read",
		input: object({}),
		errors: [] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: { capacity: 1000, refillPerSecond: 10 }, perAccount: "none" },
		handler: (_input: unknown, _context: RequestContext) => {
			reached.push("demo.read");
			return Promise.resolve({ seen: true });
		},
	};
	const plugin: VelvePlugin<"demo"> = { id: "demo", routes: [route] };
	const pluginHandler = (request: Request) =>
		toWebHandler(
			createVelveAuth(
				configFor({ database: mounted.connection, schema: mounted.schema, plugins: [plugin] }),
			),
			{ basePath: BASE_PATH },
		)(request);

	it("refuses the same-origin form without an Origin, before the handler", async () => {
		const answer = await pluginHandler(
			readFrom("/x/demo/read", { "Sec-Fetch-Site": "same-origin" }),
		);

		expect(await serialised(answer)).toBe(ORIGIN_REJECTION);
		expect(reached).toStrictEqual([]);
	});

	it("reaches the handler with the configured Origin, so the refusal above refuses something reachable", async () => {
		const answer = await pluginHandler(readFrom("/x/demo/read", { Origin: TEST_ORIGIN }));

		expect(answer.status).toBe(200);
		expect(reached).toStrictEqual(["demo.read"]);
	});
});
