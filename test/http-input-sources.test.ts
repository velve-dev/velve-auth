import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import type { AnyRoute } from "../src/core/http/route.js";
import { createSessionToken } from "../src/core/session/token.js";
import { type MountedAuth, mountAuth, TEST_ORIGIN } from "./auth-fixtures.js";
import { createUser, dropSchema } from "./db-fixtures.js";
import { createStubProvider, oauthConfigFor } from "./oauth-provider.js";

/* ------------------------------------------------------------------ *
 * S-OWNER-6 and T-OWNER-6. A parameter read from more than one source
 * of one request is refused with 400 and neither value is chosen. The
 * sources are the path, the query string and the body, on every
 * method; a name carried twice is refused even when both values agree
 * (E-2240).
 * ------------------------------------------------------------------ */

const BASE = "https://api.example.com";
const PATH_VALUE = "from-the-path";
const SECOND_VALUE = "from-a-second-source";

let mounted: MountedAuth;

beforeAll(async () => {
	const provider = await createStubProvider({
		claims: { sub: "sources-subject", email: "sources@example.com", email_verified: true },
	});
	mounted = await mountAuth("inputsources", {
		oauth: oauthConfigFor({ openIdConnect: false }),
		fetch: provider.fetch,
		rateLimit: { perIpAddress: { capacity: 100_000, refillPerSecond: 1_000 } },
	});
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

function pathParameterNames(route: AnyRoute): readonly string[] {
	return route.path
		.split("/")
		.filter((segment) => segment.startsWith(":"))
		.map((segment) => segment.slice(1));
}

function filledPath(route: AnyRoute): string {
	return route.path
		.split("/")
		.map((segment) => (segment.startsWith(":") ? PATH_VALUE : segment))
		.join("/");
}

function declaredFields(route: AnyRoute): readonly string[] {
	const input = (route as AnyRoute & { readonly input: { readonly fields: readonly string[] } })
		.input;
	return input.fields;
}

/** Every declared field given a string of its own, so a case whose body is otherwise acceptable is told apart from one that fails on its shape. */
function baseInput(route: AnyRoute): Record<string, string> {
	const paths = new Set(pathParameterNames(route));
	return Object.fromEntries(
		declaredFields(route)
			.filter((field) => !paths.has(field))
			.map((field) => [field, `value-of-${field}`]),
	);
}

interface Shape {
	readonly query: Readonly<Record<string, string>>;
	readonly body: Readonly<Record<string, string>> | null;
}

function requestFor(route: AnyRoute, shape: Shape): Request {
	const url = new URL(`${BASE}${filledPath(route)}`);
	for (const [name, value] of Object.entries(shape.query)) {
		url.searchParams.append(name, value);
	}
	const headers = new Headers({ Origin: TEST_ORIGIN });
	if (route.method === "GET" || shape.body === null) {
		return new Request(url, { method: route.method, headers });
	}
	if (route.requestBody === "form") {
		headers.set("Content-Type", "application/x-www-form-urlencoded");
		return new Request(url, {
			method: route.method,
			headers,
			body: new URLSearchParams(shape.body),
		});
	}
	headers.set("Content-Type", "application/json");
	return new Request(url, { method: route.method, headers, body: JSON.stringify(shape.body) });
}

interface Case {
	readonly label: string;
	readonly route: AnyRoute;
	readonly contradicting: Shape;
	readonly agreeing: Shape;
	readonly control: Shape;
}

/** For a GET the query is the only source besides the path; for a POST every declared field can sit in the query and the body, and a path parameter in either. */
function casesFor(route: AnyRoute): readonly Case[] {
	const base = baseInput(route);
	const cases: Case[] = [];
	const add = (label: string, contradicting: Shape, agreeing: Shape, control: Shape): void => {
		cases.push({ label: `${route.name} ${label}`, route, contradicting, agreeing, control });
	};

	for (const parameter of pathParameterNames(route)) {
		if (route.method === "GET") {
			add(
				`${parameter} in path and query`,
				{ query: { ...base, [parameter]: SECOND_VALUE }, body: null },
				{ query: { ...base, [parameter]: PATH_VALUE }, body: null },
				{ query: base, body: null },
			);
			continue;
		}
		add(
			`${parameter} in path and body`,
			{ query: {}, body: { ...base, [parameter]: SECOND_VALUE } },
			{ query: {}, body: { ...base, [parameter]: PATH_VALUE } },
			{ query: {}, body: base },
		);
		add(
			`${parameter} in path and query`,
			{ query: { [parameter]: SECOND_VALUE }, body: base },
			{ query: { [parameter]: PATH_VALUE }, body: base },
			{ query: {}, body: base },
		);
	}
	if (route.method === "POST") {
		for (const field of Object.keys(base)) {
			add(
				`${field} in query and body`,
				{ query: { [field]: SECOND_VALUE }, body: base },
				{ query: { [field]: base[field] ?? "" }, body: base },
				{ query: {}, body: base },
			);
		}
	}
	return cases;
}

interface Answer {
	readonly status: number;
	readonly code: string | null;
}

async function answerTo(request: Request): Promise<Answer> {
	const response = await mounted.handler(request);
	const text = await response.text();
	if (text === "") {
		return { status: response.status, code: null };
	}
	const parsed = JSON.parse(text) as { readonly error?: { readonly code?: string } };
	return { status: response.status, code: parsed.error?.code ?? null };
}

function routedRoutes(): readonly AnyRoute[] {
	return mounted.auth.http.routes.filter((route) => route.caller !== "server_only");
}

describe("a parameter in two sources is refused (S-OWNER-6, T-OWNER-6)", () => {
	it("has routes whose parameters can sit in more than one source", () => {
		const cases = routedRoutes().flatMap(casesFor);
		expect(cases.length).toBeGreaterThan(30);
	});

	it("answers 400 invalid_input on every route where the two values contradict", async () => {
		const refused: string[] = [];
		const chosen: string[] = [];
		let discriminating = 0;
		for (const one of routedRoutes().flatMap(casesFor)) {
			const control = await answerTo(requestFor(one.route, one.control));
			const answer = await answerTo(requestFor(one.route, one.contradicting));
			if (control.code !== "invalid_input") {
				discriminating += 1;
			}
			if (answer.status === 400 && answer.code === "invalid_input") {
				refused.push(one.label);
			} else {
				chosen.push(`${one.label} answered ${answer.status} ${answer.code ?? ""}`);
			}
		}

		expect(chosen).toStrictEqual([]);
		expect(refused.length).toBeGreaterThan(30);
		//a case whose control already fails on its shape proves nothing, so most must not
		expect(discriminating).toBeGreaterThan(20);
	});

	it("refuses the name carried twice even when both values agree (E-2240)", async () => {
		const accepted: string[] = [];
		for (const one of routedRoutes().flatMap(casesFor)) {
			const answer = await answerTo(requestFor(one.route, one.agreeing));
			if (answer.status !== 400 || answer.code !== "invalid_input") {
				accepted.push(`${one.label} answered ${answer.status} ${answer.code ?? ""}`);
			}
		}

		expect(accepted).toStrictEqual([]);
	});

	it("never takes the path's provider over a contradicting query on the callback", async () => {
		const answer = await answerTo(
			new Request(`${BASE}/sign-in/oauth/callback/stubby?provider=other&code=c&state=s`, {
				method: "GET",
			}),
		);

		expect(answer).toStrictEqual({ status: 400, code: "invalid_input" });
	});
});

describe("a signed-in revoke with the target in two sources changes nothing (S-OWNER-6)", () => {
	let userId: string;

	async function insertSession(): Promise<{ readonly token: string; readonly id: string }> {
		const issued = createSessionToken();
		const [row] = await mounted.connection.query<{ id: string }>(
			`INSERT INTO ${mounted.schema}.session
			   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors)
			 VALUES ($1, $2, now() + interval '7 days', now() + interval '30 days', '{password}'::text[])
			 RETURNING id`,
			[userId, issued.tokenHash],
		);
		return { token: issued.token, id: row?.id ?? "" };
	}

	async function sessionIds(): Promise<readonly string[]> {
		const rows = await mounted.connection.query<{ id: string }>(
			`SELECT id FROM ${mounted.schema}.session WHERE user_id = $1 ORDER BY id`,
			[userId],
		);
		return rows.map((row) => row.id);
	}

	beforeAll(async () => {
		userId = await createUser(mounted.connection, mounted.schema);
	});

	it("answers 400 and removes neither the query's session nor the body's", async () => {
		const caller = await insertSession();
		const inQuery = await insertSession();
		const inBody = await insertSession();
		const before = await sessionIds();

		const response = await mounted.handler(
			new Request(`${BASE}/session/revoke?targetSessionId=${inQuery.id}`, {
				method: "POST",
				headers: {
					Origin: TEST_ORIGIN,
					"Content-Type": "application/json",
					Cookie: `${DEFAULT_COOKIE_NAMES.session}=${caller.token}`,
				},
				body: JSON.stringify({ targetSessionId: inBody.id }),
			}),
		);

		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
			"invalid_input",
		);
		expect(await sessionIds()).toStrictEqual(before);
		expect(before).toContain(inQuery.id);
		expect(before).toContain(inBody.id);
	});

	it("still revokes when the target sits in the body alone", async () => {
		const caller = await insertSession();
		const target = await insertSession();

		const response = await mounted.handler(
			new Request(`${BASE}/session/revoke`, {
				method: "POST",
				headers: {
					Origin: TEST_ORIGIN,
					"Content-Type": "application/json",
					Cookie: `${DEFAULT_COOKIE_NAMES.session}=${caller.token}`,
				},
				body: JSON.stringify({ targetSessionId: target.id }),
			}),
		);

		expect(response.status).toBe(204);
		expect(await sessionIds()).not.toContain(target.id);
	});
});
