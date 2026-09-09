import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PENDING_CALLER_ROUTES } from "../src/core/factor/pending/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { type AnyRoute, readsPendingCookie } from "../src/core/http/route.js";
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
 * E-342 named the seven routes exactly, so that a route added or lost showed up as a name rather
 * than as a number nobody reads — and called the file a merge conflict waiting for four branches.
 * What replaces it is a property over whatever the table holds, plus a floor that an empty table
 * fails: the floor carries no meaning of its own, it exists because a wave-3 gate found eight of
 * eleven assertions here passing on an empty list.
 */
const MINIMUM_ROUTES = 7;
const MINIMUM_GET_ROUTES = 2;
const MINIMUM_PENDING_READERS = 2;

/**
 * S-CACHE-4 counts **readers**, not authorities: the four routes with `caller: "pending"` evaluate
 * `__Host-velve_pending` and every other route ignores it completely. `PENDING_CALLER_ROUTES`
 * bounds the authorities, and until `pendingCookie` existed that bounded the readers too. It no
 * longer does, so the reader set is named here and the count is what holds it (E-530).
 */
const ROUTES_THAT_MAY_READ_THE_PENDING_COOKIE = new Set<string>([
	...PENDING_CALLER_ROUTES,
	"pending.read",
	"pending.cancel",
]);

/**
 * 3.15 D.3 names one route without an origin check, the provider's redirection back. It is two:
 * a provider answering with `responseMode: form_post` — which Apple requires once the e-mail scope
 * is asked for (section 1, C50 and C70) — posts the code to the same callback instead, and a
 * cross-site POST carries no `Origin` the library may compare either. Both are named here, and
 * T-CSRF-1's threshold is that these two are the whole of it (E-541).
 */
const ROUTES_THAT_MAY_BE_EXEMPT = new Set([
	"signIn.oauth.callback",
	"signIn.oauth.callbackFormPost",
]);

/** S-CSRF-4: the reading routes, plus the callback, are the whole of what may answer a GET. */
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

/** A GET whose declared input is not optional needs one, or it answers 400 before anything else. */
const QUERY_BY_ROUTE: Readonly<Record<string, string>> = {
	"username.isAvailable": "?username=x",
};

function pathFor(route: AnyRoute): string {
	const filled = route.path
		.split("/")
		.map((segment) => (segment.startsWith(":") ? "placeholder" : segment))
		.join("/");
	return `${filled}${QUERY_BY_ROUTE[route.name] ?? ""}`;
}

function requestFor(route: AnyRoute, cookie?: string): Request {
	return requestTo(pathFor(route), {
		method: route.method,
		...(cookie === undefined ? {} : { cookie }),
		...(route.method === "POST" ? { body: {} } : {}),
	});
}

function namesOf(subset: readonly AnyRoute[]): readonly string[] {
	return subset.map((route) => route.name);
}

describe("the origin check over the whole table (S-CSRF-1)", () => {
	it("names the two routes that may be exempt, and exempts exactly the ones in the table", () => {
		const exempt = namesOf(routes.filter((route) => route.originCheck !== "checked"));
		const permittedAndDeclared = namesOf(
			routes.filter((route) => ROUTES_THAT_MAY_BE_EXEMPT.has(route.name)),
		);

		expect(routes.length).toBeGreaterThanOrEqual(MINIMUM_ROUTES);
		expect([...ROUTES_THAT_MAY_BE_EXEMPT]).toStrictEqual([
			"signIn.oauth.callback",
			"signIn.oauth.callbackFormPost",
		]);
		expect(exempt).toStrictEqual(permittedAndDeclared);
	});

	it("refuses every checked route on the HTTP path when the origin is foreign", async () => {
		const checked = routes.filter((route) => route.originCheck === "checked");
		const codes = await Promise.all(
			checked.map(async (route) => {
				const answer = await mounted.handler(
					requestTo(pathFor(route), {
						method: route.method,
						origin: "https://evil.example.com",
						...(route.method === "POST" ? { body: {} } : {}),
					}),
				);
				const body = (await answer.json()) as { error?: { code?: string } };
				return `${answer.status} ${body.error?.code ?? ""}`;
			}),
		);

		expect(checked.length).toBeGreaterThanOrEqual(MINIMUM_ROUTES);
		expect(codes).toHaveLength(checked.length);
		expect(codes).toStrictEqual(checked.map(() => "403 origin_not_allowed"));
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
		const gets = namesOf(routes.filter((route) => route.method === "GET"));

		expect(routes.length).toBeGreaterThanOrEqual(MINIMUM_ROUTES);
		expect(gets.length).toBeGreaterThanOrEqual(MINIMUM_GET_ROUTES);
		expect(gets.filter((name) => !READING_GET_ROUTES.has(name))).toStrictEqual([]);
	});

	it("changes no row through a reading GET", async () => {
		const before = await countEveryRow();
		const gets = routes.filter((route) => route.method === "GET");

		expect(gets.length).toBeGreaterThanOrEqual(MINIMUM_GET_ROUTES);
		for (const route of gets) {
			await mounted.handler(requestFor(route));
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
	it("declares caller `pending` for exactly the four of 3.6 that are in the table", () => {
		const four: readonly string[] = PENDING_CALLER_ROUTES;
		const declaredPending = namesOf(routes.filter((route) => route.caller === "pending"));
		const namedAndDeclared = namesOf(routes.filter((route) => four.includes(route.name)));

		expect(PENDING_CALLER_ROUTES).toHaveLength(4);
		expect(routes.length).toBeGreaterThanOrEqual(MINIMUM_ROUTES);
		expect(declaredPending).toStrictEqual(namedAndDeclared);
	});

	it("lets exactly the routes named for it read the cookie, and no sixth", () => {
		const readers = namesOf(routes.filter(readsPendingCookie));
		const namedAndDeclared = namesOf(
			routes.filter((route) => ROUTES_THAT_MAY_READ_THE_PENDING_COOKIE.has(route.name)),
		);

		expect(ROUTES_THAT_MAY_READ_THE_PENDING_COOKIE.size).toBe(6);
		expect(routes.length).toBeGreaterThanOrEqual(MINIMUM_ROUTES);
		expect(readers.length).toBeGreaterThanOrEqual(MINIMUM_PENDING_READERS);
		expect(readers).toStrictEqual(namedAndDeclared);
	});

	/**
	 * The set is taken from the names rather than from `readsPendingCookie`, because a route that
	 * declares itself readable is excluded by the predicate and would leave this measuring the
	 * predicate against itself.
	 */
	it("answers a request carrying only the pending cookie exactly as one carrying no cookie", async () => {
		const mustIgnore = routes.filter(
			(route) => !ROUTES_THAT_MAY_READ_THE_PENDING_COOKIE.has(route.name),
		);
		const withPending = await Promise.all(
			mustIgnore.map((route) =>
				answerFor(route, `${DEFAULT_COOKIE_NAMES.pending}=${"p".repeat(43)}`),
			),
		);
		const withoutCookie = await Promise.all(mustIgnore.map((route) => answerFor(route, undefined)));

		expect(routes.length).toBeGreaterThanOrEqual(MINIMUM_ROUTES);
		expect(mustIgnore.length).toBeGreaterThanOrEqual(MINIMUM_ROUTES - MINIMUM_PENDING_READERS);
		expect(withPending).toHaveLength(mustIgnore.length);
		expect(withPending).toStrictEqual(withoutCookie);
	});
});

async function answerFor(route: AnyRoute, cookie: string | undefined): Promise<string> {
	const answer = await mounted.handler(requestFor(route, cookie));
	return `${answer.status} ${await answer.text()}`;
}

describe("the table as a table", () => {
	it("names every route once, over a table that is not empty", () => {
		const names = namesOf(routes);

		expect(names.length).toBeGreaterThanOrEqual(MINIMUM_ROUTES);
		expect(new Set(names).size).toBe(names.length);
	});

	it("answers a distinct path for every route", () => {
		const folded = routes.map((route) => `${route.method} ${route.path}`);

		expect(folded.length).toBeGreaterThanOrEqual(MINIMUM_ROUTES);
		expect(new Set(folded).size).toBe(folded.length);
	});
});

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
	 * The three names are the whole set the library can express, and
	 * `assertCookieNamesAreEnumerated` makes a fourth a 500. The routes that issue a session, a
	 * pending state or a state pointer belong to other features, so nothing here sets one — the
	 * count of names seen is zero and says so.
	 */
	it("sets no name outside the enumerated three", async () => {
		const seen = new Set<string>();
		let swept = 0;
		for (const route of routes) {
			swept += 1;
			const answer = await mounted.handler(requestFor(route));
			for (const header of answer.headers.getSetCookie()) {
				seen.add(header.slice(0, header.indexOf("=")));
			}
		}

		const enumerated = new Set<string>(Object.values(DEFAULT_COOKIE_NAMES));
		expect(swept).toBe(routes.length);
		expect(swept).toBeGreaterThanOrEqual(MINIMUM_ROUTES);
		expect(enumerated.size).toBe(3);
		expect([...seen].filter((name) => !enumerated.has(name))).toStrictEqual([]);
	});
});

describe("what the answers carry (S-REDIR-3, S-REDIR-7, S-CACHE-1)", () => {
	it("sets no Location, answers only JSON, and marks every answer uncacheable", async () => {
		const answers = await Promise.all(routes.map((route) => mounted.handler(requestFor(route))));

		expect(answers).toHaveLength(routes.length);
		expect(answers.length).toBeGreaterThanOrEqual(MINIMUM_ROUTES);
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
