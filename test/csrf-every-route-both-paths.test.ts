import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import type { AnyRoute } from "../src/core/http/route.js";
import { createServerMethodOfAnyRoute } from "../src/core/http/server-method.js";
import { rowsServedUnder } from "./architecture-route-table.js";
import { type MountedAuth, mountAuthInMode, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";

/**
 * T-CSRF-1 over every row of 3.15 D.3: the widest configuration serves all of them, and each is
 * called with a foreign `Origin` on both paths, with no origin on the direct server method, and
 * without an `Origin` header on the HTTP path in every `Sec-Fetch-Site` form. Every call carries a
 * live session, so a handler the check let through would have something to change, and every
 * table of the schema but `rate_bucket` is compared by content before and after the refused calls
 * (E-2731). The admitted same-origin reads are not among those calls, and a rate limiter may write
 * its buckets before the origin check, which 3.11 does not forbid (E-2732).
 */

const FOREIGN_ORIGIN = "https://evil.example.com";
const PASSWORD = "correct-horse-battery-staple";

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

const QUERY_BY_ROUTE: Readonly<Record<string, string>> = {
	"username.isAvailable": "?username=someone",
};

let mounted: MountedAuth<"username_email">;
let sessionToken: string;

beforeAll(async () => {
	mounted = await mountAuthInMode<"username_email">(
		"csrfmatrix",
		{ mode: "username_email" },
		{
			oauth: {
				providers: { github: { clientId: "id", clientSecret: "secret" } },
				callbackBaseUrl: `${TEST_ORIGIN}/sign-in/oauth/callback`,
				trustedProviders: [],
			},
			webauthn: {
				relyingPartyId: "app.example.com",
				relyingPartyName: "Velve Auth tests",
				origins: [TEST_ORIGIN],
				userVerification: "required",
			},
		},
	);
	const signedUp = await mounted.handler(
		postTo("/sign-up", { email: "holder@example.com", username: "holder", password: PASSWORD }),
	);
	expect(signedUp.status, await signedUp.clone().text()).toBe(200);
	sessionToken = sessionTokenOf(signedUp);
}, 120_000);

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

function sessionTokenOf(answer: Response): string {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === DEFAULT_COOKIE_NAMES.session) {
			return pair.slice(separator + 1);
		}
	}
	throw new Error("the sign-up answered no session cookie");
}

function pathOf(route: AnyRoute): string {
	const filled = route.path
		.split("/")
		.map((segment) => (segment.startsWith(":") ? "placeholder" : segment))
		.join("/");
	return `${filled}${QUERY_BY_ROUTE[route.name] ?? ""}`;
}

function requestTo(route: AnyRoute, headers: Readonly<Record<string, string>>): Request {
	return new Request(`https://api.example.com${pathOf(route)}`, {
		method: route.method,
		headers: {
			Cookie: `${DEFAULT_COOKIE_NAMES.session}=${sessionToken}`,
			"Content-Type": "application/json",
			...headers,
		},
		...(route.method === "GET" ? {} : { body: "{}" }),
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

async function codeOfServerCall(route: AnyRoute, origin: string | null): Promise<string> {
	try {
		await createServerMethodOfAnyRoute(route, mounted.auth.http)({ origin, sessionToken });
		return "answered";
	} catch (cause) {
		const code = (cause as { code?: unknown }).code;
		return typeof code === "string" ? code : "thrown";
	}
}

async function codeOfHttpCall(answer: Response): Promise<string> {
	const text = await answer.text();
	try {
		const code = (JSON.parse(text) as { error?: { code?: unknown } } | null)?.error?.code;
		return typeof code === "string" ? code : `${answer.status}`;
	} catch {
		return `${answer.status}`;
	}
}

/**
 * Every table of the schema but `rate_bucket` by content, so an update shows up as well as an
 * insert or a delete.
 */
async function everyTableByContent(): Promise<Record<string, string>> {
	const tables = await mounted.connection.query<{ name: string }>(
		`SELECT table_name AS name FROM information_schema.tables
		  WHERE table_schema = $1 AND table_name <> 'rate_bucket' ORDER BY 1`,
		[mounted.schema],
	);
	const digests: Record<string, string> = {};
	for (const { name } of tables) {
		const [row] = await mounted.connection.query<{ digest: string }>(
			`SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS digest
			   FROM "${mounted.schema}"."${name}" t`,
			[],
		);
		digests[name] = row?.digest ?? "";
	}
	return digests;
}

/** Every call (a) to (c) of T-CSRF-1 makes to one checked route that did not answer the rejection. */
async function callsNotRefusedForTheirOrigin(route: AnyRoute): Promise<string[]> {
	const found: string[] = [];
	const foreign = await serialised(
		await mounted.handler(requestTo(route, { Origin: FOREIGN_ORIGIN })),
	);
	if (foreign !== ORIGIN_REJECTION) found.push(`${route.name} http foreign`);
	for (const origin of [FOREIGN_ORIGIN, null]) {
		const code = await codeOfServerCall(route, origin);
		if (code !== "origin_not_allowed")
			found.push(`${route.name} server ${origin ?? "none"}: ${code}`);
	}
	const sameOriginIsAdmitted = READING_ROUTES.includes(route.name);
	for (const site of SITE_FORMS.filter(
		(form) => !(sameOriginIsAdmitted && form === "same-origin"),
	)) {
		const answer = await serialised(await mounted.handler(requestTo(route, siteHeader(site))));
		if (answer !== ORIGIN_REJECTION) found.push(`${route.name} http no origin, ${site ?? "none"}`);
	}
	return found;
}

describe("T-CSRF-1 over every row of 3.15 D.3, on both paths", () => {
	it("serves every row of D.3 and exempts exactly the two callbacks", () => {
		const exempt = mounted.auth.routes.filter((route) => route.originCheck !== "checked");

		expect(mounted.auth.routes).toHaveLength(
			rowsServedUnder({ mode: "username_email", webauthn: true }).length,
		);
		expect(exempt.map((route) => route.name).sort()).toStrictEqual([...EXEMPT_ROUTES].sort());
	});

	it("refuses every checked route before its handler, identically, and changes no row", async () => {
		const checked = mounted.auth.routes.filter((route) => route.originCheck === "checked");
		const before = await everyTableByContent();
		expect(Object.keys(before).length).toBeGreaterThan(10);
		expect(before.session).not.toBe("");
		expect(Object.keys(before)).not.toContain("rate_bucket");

		const refusedOtherwise: string[] = [];
		for (const route of checked) {
			refusedOtherwise.push(...(await callsNotRefusedForTheirOrigin(route)));
		}

		expect(checked.length).toBe(mounted.auth.routes.length - EXEMPT_ROUTES.length);
		expect(refusedOtherwise).toStrictEqual([]);
		expect(await everyTableByContent()).toStrictEqual(before);
	}, 60_000);

	it("answers each reading route's same-origin form byte for byte as its allowed Origin", async () => {
		const reading = mounted.auth.routes.filter((route) => READING_ROUTES.includes(route.name));
		const pairs: string[][] = [];
		for (const route of reading) {
			const sameOrigin = await serialised(
				await mounted.handler(requestTo(route, { "Sec-Fetch-Site": "same-origin" })),
			);
			const allowed = await serialised(
				await mounted.handler(requestTo(route, { Origin: TEST_ORIGIN })),
			);
			pairs.push([route.name, sameOrigin, allowed]);
		}

		expect(reading.map((route) => route.name).sort()).toStrictEqual([...READING_ROUTES].sort());
		expect(pairs.filter(([, sameOrigin, allowed]) => sameOrigin !== allowed)).toStrictEqual([]);
		expect(pairs.filter(([, sameOrigin]) => sameOrigin === ORIGIN_REJECTION)).toStrictEqual([]);
		expect(pairs.filter(([, sameOrigin]) => sameOrigin?.startsWith("200\n"))).toHaveLength(
			READING_ROUTES.length,
		);
	});

	it("never answers origin_not_allowed on either callback, whatever the origin", async () => {
		const callbacks = mounted.auth.routes.filter((route) => EXEMPT_ROUTES.includes(route.name));
		const codes: string[] = [];
		for (const route of callbacks) {
			codes.push(
				await codeOfHttpCall(await mounted.handler(requestTo(route, { Origin: FOREIGN_ORIGIN }))),
			);
			for (const site of SITE_FORMS) {
				codes.push(await codeOfHttpCall(await mounted.handler(requestTo(route, siteHeader(site)))));
			}
			for (const origin of [FOREIGN_ORIGIN, null]) {
				codes.push(await codeOfServerCall(route, origin));
			}
		}

		expect(callbacks).toHaveLength(2);
		expect(codes).toHaveLength(2 * (1 + SITE_FORMS.length + 2));
		expect(codes.filter((code) => code === "origin_not_allowed")).toStrictEqual([]);
	}, 60_000);
});
