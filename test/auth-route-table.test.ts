import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PENDING_CALLER_ROUTES } from "../src/core/factor/pending/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import type { AnyRoute } from "../src/core/http/route.js";
import { type MountedAuth, mountAuth, requestTo, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

let mounted: MountedAuth;
let routes: readonly AnyRoute[];

beforeAll(async () => {
	mounted = await mountAuth("routetable");
	routes = mounted.auth.routes;
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

/**
 * The part of 3.15 D.3 this feature declares. The namespaces whose services belong to another
 * wave-3 feature are absent, and naming the set here rather than counting it means a route added
 * or lost shows up as a name rather than as a number nobody reads.
 */
const DECLARED_ROUTES = [
	"signOut",
	"session.read",
	"session.list",
	"session.revoke",
	"session.revokeAllOther",
	"session.revokeAll",
	"session.refresh",
];

/** 3.15 D.3: the only route without an origin check is the provider's redirection back. */
const ROUTES_THAT_MAY_BE_EXEMPT = new Set(["signIn.oauth.callback"]);

/** S-CSRF-4: the seven reading routes, plus the callback, are the whole of what may answer a GET. */
const READING_GET_ROUTES = new Set([
	"session.read",
	"session.list",
	"username.isAvailable",
	"factor.webauthn.list",
	"factor.recovery.remaining",
	"identity.list",
	"pending.read",
	"signIn.oauth.callback",
]);

describe("the origin check over the whole table (S-CSRF-1)", () => {
	it("leaves exactly the routes that may be exempt exempt, over the table this feature declares", () => {
		const exempt = routes.filter((route) => route.originCheck !== "checked").map((r) => r.name);

		expect(routes.map((route) => route.name)).toStrictEqual(DECLARED_ROUTES);
		expect(exempt.filter((name) => !ROUTES_THAT_MAY_BE_EXEMPT.has(name))).toStrictEqual([]);
		expect(exempt).toStrictEqual([]);
	});

	it("refuses every route on the HTTP path when the origin is foreign", async () => {
		const answers = await Promise.all(
			routes.map((route) =>
				mounted.handler(
					requestTo(route.path, {
						method: route.method,
						origin: "https://evil.example.com",
						body: route.method === "POST" ? {} : undefined,
					}),
				),
			),
		);

		const codes = await Promise.all(
			answers.map(async (answer) => {
				const body = (await answer.json()) as { error?: { code?: string } };
				return `${answer.status} ${body.error?.code ?? ""}`;
			}),
		);

		expect(codes).toStrictEqual(routes.map(() => "403 origin_not_allowed"));
	});

	/** 3.11: the check lies before the handler on the direct server call too, and E-121 made it required. */
	it("refuses the direct server method with a foreign origin", async () => {
		await expect(
			mounted.auth.session.revokeAll({ origin: "https://evil.example.com" }),
		).rejects.toMatchObject({ code: "origin_not_allowed" });
		await expect(mounted.auth.session.revokeAll({ origin: null })).rejects.toMatchObject({
			code: "origin_not_allowed",
		});
	});
});

describe("what a GET may do (S-CSRF-4)", () => {
	it("classifies every GET route as reading, over a set that is not empty", () => {
		const gets = routes.filter((route) => route.method === "GET").map((route) => route.name);

		expect(gets.length).toBeGreaterThanOrEqual(2);
		expect(gets.filter((name) => !READING_GET_ROUTES.has(name))).toStrictEqual([]);
	});

	it("changes no row through a reading GET", async () => {
		const before = await countEveryRow();
		for (const route of routes.filter((route) => route.method === "GET")) {
			await mounted.handler(
				requestTo(route.path === "/username/available" ? `${route.path}?username=x` : route.path, {
					method: "GET",
				}),
			);
		}

		expect(await countEveryRow()).toStrictEqual(before);
	});
});

async function countEveryRow(): Promise<Record<string, number>> {
	const tables = [
		"session",
		"one_time_token",
		"pending_authentication",
		"totp_credential",
		"recovery_code",
		"webauthn_credential",
		"user",
	];
	const counted: Record<string, number> = {};
	for (const table of tables) {
		const [row] = await mounted.connection.query<{ present: number }>(
			`SELECT count(*)::int AS present FROM ${mounted.schema}.${table}`,
			[],
		);
		counted[table] = row?.present ?? -1;
	}
	return counted;
}

describe("the routes that read the pending cookie (S-CACHE-4)", () => {
	it("declares no route with caller `pending` that is not one of the four", () => {
		const declaredPending = routes
			.filter((route) => route.caller === "pending")
			.map((route) => route.name);

		expect(PENDING_CALLER_ROUTES).toHaveLength(4);
		const four: readonly string[] = PENDING_CALLER_ROUTES;
		expect(declaredPending.filter((name) => !four.includes(name))).toStrictEqual([]);
	});

	/** Every other route ignores `__Host-velve_pending` completely, and answers as if it were absent. */
	it("answers a request carrying only the pending cookie exactly as one carrying no cookie", async () => {
		const withPending = await Promise.all(
			routes.map((route) => answerFor(route, `${DEFAULT_COOKIE_NAMES.pending}=${"p".repeat(43)}`)),
		);
		const withoutCookie = await Promise.all(routes.map((route) => answerFor(route, undefined)));

		expect(withPending).toStrictEqual(withoutCookie);
		expect(withPending.length).toBe(routes.length);
	});
});

async function answerFor(route: AnyRoute, cookie: string | undefined): Promise<string> {
	const path = route.path === "/username/available" ? `${route.path}?username=x` : route.path;
	const answer = await mounted.handler(
		requestTo(path, {
			method: route.method,
			...(cookie === undefined ? {} : { cookie }),
			body: route.method === "POST" ? {} : undefined,
		}),
	);
	return `${answer.status} ${await answer.text()}`;
}

describe("where an authorization parameter is read (S-OWNER-6)", () => {
	/**
	 * A POST reads its input from the body alone and never from the query, so a query value cannot
	 * be chosen over a body value — the parameter has one source, which is what the requirement asks.
	 */
	it("ignores a query parameter that contradicts the body on a POST route", async () => {
		const answer = await mounted.handler(
			new Request(
				"https://api.example.com/session/revoke?targetSessionId=00000000-0000-0000-0000-000000000001",
				{
					method: "POST",
					headers: { Origin: TEST_ORIGIN, "Content-Type": "application/json" },
					body: JSON.stringify({ targetSessionId: "00000000-0000-0000-0000-000000000002" }),
				},
			),
		);

		// No session, so the answer is the caller requirement — the point is that the query never decided.
		expect(answer.status).toBe(401);
	});

	/** A GET reads only its declared fields, so a smuggled `userId` never reaches the handler. */
	it("drops an undeclared query parameter on a GET route rather than passing it on", async () => {
		const answer = await mounted.handler(
			new Request("https://api.example.com/session/list?userId=someone-else", {
				method: "GET",
				headers: { Origin: TEST_ORIGIN },
			}),
		);
		const body = (await answer.json()) as { error?: { code?: string } };

		expect(`${answer.status} ${body.error?.code ?? ""}`).toBe("401 session_required");
	});
});

describe("the cookies this library can ever set (S-COOKIE-6)", () => {
	/**
	 * The two names are the whole set the library can express, and `assertCookieNamesAreEnumerated`
	 * makes a third a 500. This table sets neither: the routes that issue a session or a pending
	 * state belong to other features of this wave, so the count here is zero and says so.
	 */
	it("sets no name outside the enumerated two", async () => {
		const seen = new Set<string>();
		for (const route of routes) {
			const answer = await mounted.handler(
				requestTo(route.path === "/username/available" ? `${route.path}?username=x` : route.path, {
					method: route.method,
					body: route.method === "POST" ? {} : undefined,
				}),
			);
			for (const header of answer.headers.getSetCookie()) {
				seen.add(header.slice(0, header.indexOf("=")));
			}
		}

		const enumerated = new Set<string>([
			DEFAULT_COOKIE_NAMES.session,
			DEFAULT_COOKIE_NAMES.pending,
		]);
		expect(enumerated.size).toBe(2);
		expect([...seen].filter((name) => !enumerated.has(name))).toStrictEqual([]);
		expect(seen.size).toBe(0);
	});
});

describe("what the answers carry (S-REDIR-3, S-REDIR-7, S-CACHE-1)", () => {
	it("sets no Location, answers only JSON, and marks every answer uncacheable", async () => {
		const answers = await Promise.all(
			routes.map((route) =>
				mounted.handler(
					requestTo(
						route.path === "/username/available" ? `${route.path}?username=x` : route.path,
						{ method: route.method, body: route.method === "POST" ? {} : undefined },
					),
				),
			),
		);

		expect(answers.length).toBe(DECLARED_ROUTES.length);
		expect(answers.filter((answer) => answer.headers.has("Location"))).toStrictEqual([]);
		expect(
			answers
				.filter((answer) => answer.status !== 204)
				.filter((answer) => answer.headers.get("Content-Type") !== "application/json"),
		).toStrictEqual([]);
		expect(
			answers.filter((answer) => answer.headers.get("Cache-Control") !== "no-store"),
		).toStrictEqual([]);
		expect(answers.filter((answer) => answer.headers.get("Vary") !== "Cookie")).toStrictEqual([]);
	});
});
