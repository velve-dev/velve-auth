import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import { VelveStartupError } from "../src/core/auth/startup.js";
import type { Driver } from "../src/core/db/driver.js";
import type { OAuthConfig } from "../src/core/oauth/config.js";
import { KNOWN_PROVIDERS } from "../src/core/oauth/config.js";
import { resolveProviderTable } from "../src/core/oauth/providers.js";
import { createVelveAuth } from "../src/index.js";
import {
	type MountedAuth,
	mountAuth,
	requestTo,
	TEST_ORIGIN,
	testKeyProvider,
} from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import {
	CALLBACK_BASE_URL,
	codeCarrying,
	createStubProvider,
	oauthConfigFor,
	type StubProvider,
} from "./oauth-provider.js";

const CREDENTIALS = { clientId: "id", clientSecret: "secret" };

/** The start check runs before anything is asked of the driver, so it never needs to answer. */
const refusingDriver: Driver = {
	query: () => Promise.reject(new Error("the start check reached the database")),
	transaction: () => Promise.reject(new Error("the start check opened a transaction")),
};

function sourceOf(relative: string): string {
	return readFileSync(join(process.cwd(), relative), "utf8");
}

/* ------------------------------------------------------------------ *
 * The second exempt route, and the boundary around it.
 * ------------------------------------------------------------------ */

interface Mounted {
	readonly auth: MountedAuth;
	readonly provider: StubProvider;
}

const mounted: MountedAuth[] = [];

async function mountWith(responseMode?: "query" | "form_post"): Promise<Mounted> {
	const provider = await createStubProvider({
		claims: { sub: "surface-subject", email: "surface@example.com", email_verified: true },
	});
	const auth = await mountAuth("oauthsurface", {
		oauth: oauthConfigFor({
			openIdConnect: false,
			...(responseMode === undefined ? {} : { responseMode }),
		}),
		fetch: provider.fetch,
	});
	mounted.push(auth);
	return { auth, provider };
}

afterEach(async () => {
	for (const instance of mounted.splice(0)) {
		await dropSchema(instance.connection, instance.schema);
		await instance.connection.close();
	}
});

interface Started {
	readonly pointer: string;
	readonly state: string;
	readonly attributes: string;
	readonly setCookie: readonly string[];
}

async function startFlow(mount: Mounted): Promise<Started> {
	const response = await mount.auth.handler(
		requestTo("/sign-in/oauth/start", { body: { provider: "stubby" } }),
	);
	const body = (await response.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string; attributes: string };
	};
	return {
		pointer: body.stateCookie.value,
		state: new URL(body.authorizationUrl).searchParams.get("state") ?? "",
		attributes: body.stateCookie.attributes,
		setCookie: response.headers.getSetCookie(),
	};
}

function postedForm(started: Started, fields: Record<string, string>): Request {
	const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
	if (started.pointer !== "") {
		headers.set("Cookie", `__Host-velve_oauth_state=${started.pointer}`);
	}
	return new Request("https://api.example.com/sign-in/oauth/callback/stubby", {
		method: "POST",
		headers,
		body: new URLSearchParams({ state: started.state, ...fields }),
	});
}

describe("S-CSRF-1: the routes that skip the origin check", () => {
	it("has exactly two, both named, and both of them the OAuth callback", async () => {
		const mount = await mountWith();
		const table = mount.auth.auth.routes;
		const exempt = table.filter((route) => route.originCheck === "exempt").map((one) => one.name);

		expect(exempt).toStrictEqual(["signIn.oauth.callback", "signIn.oauth.callbackFormPost"]);
		expect(table.filter((route) => route.originCheck === "checked").length).toBe(
			table.length - exempt.length,
		);
	});

	/**
	 * Nothing enforces the count; the census in `auth-route-table.test.ts` does. What is enforceable
	 * is where a third could be written, and that is one file — the one this feature owns.
	 */
	it("declares `exempt` in one file of the tree and twice in it", () => {
		const declarations = [
			"src/core/oauth/routes.ts",
			"src/core/auth/routes.ts",
			"src/core/http/route.ts",
			"src/core/http/pipeline.ts",
		].map((path) => [path, (sourceOf(path).match(/originCheck: "exempt"/g) ?? []).length] as const);

		expect(declarations).toStrictEqual([
			["src/core/oauth/routes.ts", 2],
			["src/core/auth/routes.ts", 0],
			["src/core/http/route.ts", 0],
			["src/core/http/pipeline.ts", 0],
		]);
	});

	it("reads a posted form on exactly one route, and that route is the second exempt one", async () => {
		const mount = await mountWith();
		const table = mount.auth.auth.routes;
		const forms = table.filter((route) => route.requestBody === "form").map((one) => one.name);

		expect(forms).toStrictEqual(["signIn.oauth.callbackFormPost"]);
		expect(table.filter((route) => route.requestBody === "json").length).toBe(table.length - 1);
	});
});

describe("S-COOKIE-2: SameSite=None is confined to the flow that needs it", () => {
	it("writes Lax for a query provider and None only for a form_post one", async () => {
		const query = await startFlow(await mountWith());
		const formPost = await startFlow(await mountWith("form_post"));

		expect(query.attributes).toBe("HttpOnly; Secure; SameSite=Lax; Path=/");
		expect(formPost.attributes).toBe("HttpOnly; Secure; SameSite=None; Path=/");
		expect(query.setCookie.filter((one) => one.includes("SameSite=None"))).toStrictEqual([]);
	});

	it("puts None on the state pointer and on no other cookie the library can write", async () => {
		const mount = await mountWith("form_post");
		const started = await startFlow(mount);
		const answered = await mount.auth.handler(postedForm(started, { code: codeCarrying(null) }));
		const written = answered.headers.getSetCookie();
		const crossSite = written.filter((one) => one.includes("SameSite=None"));

		expect(answered.status).toBe(302);
		expect(written.some((one) => one.startsWith("__Host-velve_session="))).toBe(true);
		expect(crossSite.filter((one) => !one.startsWith("__Host-velve_oauth_state="))).toStrictEqual(
			[],
		);
	});

	it("names the cross-site attribute set in one module and behind one writer", () => {
		const cookies = sourceOf("src/core/http/cookies.ts");
		const writers = cookies.match(/CROSS_SITE_ATTRIBUTES/g) ?? [];

		expect(cookies).toContain(
			'const CROSS_SITE_ATTRIBUTES = "HttpOnly; Secure; SameSite=None; Path=/"',
		);
		expect(writers).toHaveLength(3);
		expect(cookies).toContain("form_post: CROSS_SITE_ATTRIBUTES");
	});
});

/* ------------------------------------------------------------------ *
 * What a hostile cross-site POST can put in that body, and when it is
 * read at all.
 * ------------------------------------------------------------------ */

describe("the form-bodied callback and an unauthenticated cross-site POST", () => {
	it("runs the origin check and the rate limit before the body is read", () => {
		const pipeline = sourceOf("src/core/http/pipeline.ts");
		const body = pipeline.indexOf("call.readInput()");
		const origin = pipeline.indexOf('route.originCheck === "checked"');
		const limit = pipeline.indexOf("await enforceIpAddressRateLimit(route, call, environment)");

		expect(origin).toBeGreaterThan(0);
		expect(limit).toBeGreaterThan(origin);
		expect(body).toBeGreaterThan(limit);
	});

	it("answers a spent bucket before it looks at what was posted", async () => {
		const mount = await mountWith("form_post");
		const started = await startFlow(mount);
		const statuses: number[] = [];
		for (let attempt = 0; attempt < 12; attempt += 1) {
			const answer = await mount.auth.handler(
				postedForm({ ...started, pointer: "" }, { code: "no-code" }),
			);
			statuses.push(answer.status);
		}

		expect(statuses.filter((status) => status === 400).length).toBeGreaterThan(0);
		expect(statuses.at(-1)).toBe(429);
	});

	it("lets no field of the body name the provider the path already named", async () => {
		const mount = await mountWith("form_post");
		const started = await startFlow(mount);
		const answered = await mount.auth.handler(
			postedForm(started, { code: codeCarrying(null), provider: "an-unconfigured-provider" }),
		);
		const [identity] = await mount.auth.connection.query<{ provider: string }>(
			`SELECT provider FROM ${mount.auth.schema}.identity`,
			[],
		);

		expect(answered.status).toBe(302);
		expect(identity?.provider).toBe("stubby");
	});

	/**
	 * `{ __proto__: "polluted" }` in an object literal is the prototype setter and creates no own
	 * property, so the vector never reached the request and the case could not fail; the body is
	 * built from entries instead. The repeated name is presented with a valid pointer and a valid
	 * state, so that the refusal is what makes it a 400 rather than the missing cookie beside it
	 * (E-583).
	 */
	it("drops what the declaration does not name and refuses a repeated name", async () => {
		const mount = await mountWith("form_post");
		const forExtras = await startFlow(mount);
		const forRepeat = await startFlow(mount);
		const withExtras = await mount.auth.handler(
			new Request("https://api.example.com/sign-in/oauth/callback/stubby", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Cookie: `__Host-velve_oauth_state=${forExtras.pointer}`,
				},
				body: new URLSearchParams([
					["state", forExtras.state],
					["code", codeCarrying(null)],
					["user", '{"name":{"firstName":"Ada"}}'],
					["__proto__", "polluted"],
				]),
			}),
		);
		const repeated = await mount.auth.handler(
			new Request("https://api.example.com/sign-in/oauth/callback/stubby", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Cookie: `__Host-velve_oauth_state=${forRepeat.pointer}`,
				},
				body: new URLSearchParams([
					["state", forRepeat.state],
					["code", codeCarrying(null)],
					["code", "a-second-code"],
				]),
			}),
		);

		expect(withExtras.status).toBe(302);
		expect(repeated.status).toBe(400);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(Object.prototype).not.toHaveProperty("polluted");
	});

	it("writes no row for a posted form with no pointer cookie", async () => {
		const mount = await mountWith("form_post");
		const started = await startFlow(mount);
		const answered = await mount.auth.handler(
			postedForm({ ...started, pointer: "" }, { code: codeCarrying(null) }),
		);
		const [row] = await mount.auth.connection.query<{ present: number }>(
			`SELECT count(*)::int AS present FROM ${mount.auth.schema}.identity`,
			[],
		);

		expect(answered.status).toBe(400);
		expect(row?.present).toBe(0);
	});
});

/* ------------------------------------------------------------------ *
 * RFC 9207, and the fourteen descriptors.
 * ------------------------------------------------------------------ */

describe("the `iss` of RFC 9207 (3.10, section 1 C60)", () => {
	async function callbackWith(mount: Mounted, iss: string | null): Promise<number> {
		const started = await startFlow(mount);
		const query = `code=${codeCarrying(null)}&state=${encodeURIComponent(started.state)}${iss === null ? "" : `&iss=${encodeURIComponent(iss)}`}`;
		const answer = await mount.auth.handler(
			requestTo(`/sign-in/oauth/callback/stubby?${query}`, {
				method: "GET",
				cookie: `__Host-velve_oauth_state=${started.pointer}`,
			}),
		);
		return answer.status;
	}

	it("refuses an `iss` no configured issuer answers for", async () => {
		const mount = await mountWith();

		expect(await callbackWith(mount, "https://evil.example")).toBe(400);
	});

	it("accepts a response that carries no `iss` at all", async () => {
		const mount = await mountWith();

		expect(await callbackWith(mount, null)).toBe(302);
	});
});

describe("the fourteen descriptors are library data, checked where they can be", () => {
	const resolved = resolveProviderTable({
		providers: Object.fromEntries(KNOWN_PROVIDERS.map((id) => [id, CREDENTIALS])),
		callbackBaseUrl: CALLBACK_BASE_URL,
		trustedProviders: [],
	} as unknown as OAuthConfig);

	it("names fourteen and no more, and the two lists agree", () => {
		expect(KNOWN_PROVIDERS).toHaveLength(14);
		expect([...resolved.keys()].sort()).toStrictEqual([...KNOWN_PROVIDERS].sort());
	});

	it("gives every one of them an absolute https endpoint and a subject claim", () => {
		const faults = [...resolved.values()].flatMap((provider) => {
			const urls = [
				provider.authorizationEndpoint,
				provider.tokenEndpoint,
				provider.userInfoEndpoint,
				provider.jwksUri,
				provider.redirectUri,
			].filter((one): one is string => one !== null);
			const notHttps = urls.filter((one) => !one.startsWith("https://"));
			const claim = provider.subjectClaim === "" ? ["empty subjectClaim"] : [];
			return [...notHttps, ...claim].map((fault) => `${provider.id}: ${fault}`);
		});

		expect(faults).toStrictEqual([]);
	});

	it("gives every one of them a way to read claims — a JWKS or a userinfo endpoint", () => {
		const neither = [...resolved.values()]
			.filter((provider) => provider.jwksUri === null && provider.userInfoEndpoint === null)
			.map((provider) => provider.id);

		expect(neither).toStrictEqual([]);
	});

	/**
	 * A descriptor without `emailVerifiedClaim` can never satisfy the first condition of S-LINK-2,
	 * which is the safe direction; the list is pinned so that adding one is a deliberate act.
	 */
	it("names the providers that can never report an address verified", () => {
		const cannot = [...resolved.values()]
			.filter((provider) => provider.emailVerifiedClaim === null)
			.map((provider) => provider.id)
			.sort();

		expect(cannot).toStrictEqual(["facebook", "github", "microsoft", "notion", "spotify"]);
	});

	/**
	 * 3.15 A.8 gives `subjectClaim` no default on purpose, and the type permits a custom id shaped as
	 * bare `ProviderCredentials`. What closes it is the start check, not the type — so the start
	 * check is what this reads.
	 */
	it("refuses to start for a custom id that names endpoints but no subject claim", () => {
		const incomplete = {
			providers: {
				mycorp: {
					...CREDENTIALS,
					authorizationEndpoint: "https://issuer.example/authorize",
					tokenEndpoint: "https://issuer.example/token",
				},
			},
			callbackBaseUrl: CALLBACK_BASE_URL,
			trustedProviders: [],
		} as unknown as OAuthConfig;

		expect(() => resolveProviderTable(incomplete).get("mycorp")?.subjectClaim).not.toThrow();
		expect(() =>
			createVelveAuth({
				identity: { mode: "email" },
				database: refusingDriver,
				keys: testKeyProvider(),
				origins: [TEST_ORIGIN],
				email: { send: () => Promise.resolve() },
				oauth: incomplete,
			} as unknown as VelveAuthConfig<"email">),
		).toThrowError(VelveStartupError);
	});

	it("appends the provider id to the configured callback base", () => {
		const google = resolved.get("google");

		expect(google?.redirectUri).toBe(`${CALLBACK_BASE_URL}/google`);
	});
});
