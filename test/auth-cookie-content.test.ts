import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type CookieWriter,
	createCookieCollector,
	DEFAULT_COOKIE_NAMES,
	serializeCookie,
} from "../src/core/http/cookies.js";
import { decodeBase64Url } from "../src/core/keys/base64url.js";
import { createSessionToken } from "../src/core/session/token.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { createUser, dropSchema } from "./db-fixtures.js";

let mounted: MountedAuth;
let sessionToken: string;

const SESSION_COOKIE = DEFAULT_COOKIE_NAMES.session;

/** 3.5 and S-COOKIE-1: the whole attribute set, in the order the serializer writes it. */
const EXPECTED_ATTRIBUTES = ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"];

beforeAll(async () => {
	mounted = await mountAuth("cookie");
	const userId = await createUser(mounted.connection, mounted.schema);
	const issued = createSessionToken();
	sessionToken = issued.token;
	await mounted.connection.query(
		`INSERT INTO ${mounted.schema}.session
		   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors)
		 VALUES ($1, $2, now() + interval '7 days', now() + interval '30 days', '{password}'::text[])`,
		[userId, issued.tokenHash],
	);
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

function partsOf(header: string): { name: string; value: string; attributes: string[] } {
	const [pair, ...rest] = header.split(";").map((part) => part.trim());
	const separator = (pair ?? "").indexOf("=");
	return {
		name: (pair ?? "").slice(0, separator),
		value: (pair ?? "").slice(separator + 1),
		attributes: rest,
	};
}

/**
 * S-COOKIE-4: the session cookie holds the session token and nothing else — no user data, no
 * session state, no remembered result of a check. This is the requirement whose absence is the
 * whole of the comparison system's worst published flaw, where the cookie carried the answer.
 */
describe("what the session cookie carries (S-COOKIE-4)", () => {
	it("puts the token in the cookie verbatim, and nothing beside it", () => {
		const issued = createSessionToken();
		const collector = createCookieCollector({
			names: DEFAULT_COOKIE_NAMES,
			sameSite: "lax",
			sessionMaximumAgeInSeconds: 2_592_000,
		});

		collector.setSession(issued.token);
		const [instruction] = collector.collect();

		expect(collector.collect()).toHaveLength(1);
		expect(instruction?.name).toBe(SESSION_COOKIE);
		expect(instruction?.value).toBe(issued.token);
		expect(decodeBase64Url(instruction?.value ?? "")).toHaveLength(32);
	});

	it("writes one name-value pair and four fixed attributes, and no field of its own", () => {
		const issued = createSessionToken();
		const header = serializeCookie({
			name: SESSION_COOKIE,
			value: issued.token,
			maximumAgeInSeconds: 2_592_000,
			attributes: "HttpOnly; Secure; SameSite=Lax; Path=/",
		});
		const parts = partsOf(header);

		expect(parts.name).toBe(SESSION_COOKIE);
		expect(parts.value).toBe(issued.token);
		expect(parts.attributes).toStrictEqual(["Max-Age=2592000", ...EXPECTED_ATTRIBUTES]);
		// Six segments and no more: a seventh would be the field this requirement forbids.
		expect(header.split(";")).toHaveLength(6);
		expect(parts.attributes.filter((attribute) => attribute.includes(issued.token))).toStrictEqual(
			[],
		);
	});

	it("offers no channel through which anything but a token could enter", () => {
		const collector: CookieWriter = createCookieCollector({
			names: DEFAULT_COOKIE_NAMES,
			sameSite: "lax",
			sessionMaximumAgeInSeconds: 60,
		});

		const methods = [
			"setSession",
			"clearSession",
			"setPending",
			"clearPending",
			"setOAuthState",
			// The same pointer under the attributes a `form_post` provider's cross-site POST needs (E-541).
			"setCrossSiteOAuthState",
			"clearOAuthState",
		] as const;

		expect(Object.keys(collector).sort()).toStrictEqual([...methods, "collect"].sort());
		// One parameter, and it is the token: there is no second one a caller could pass state in.
		expect(collector.setSession).toHaveLength(1);
		expect(collector.setCrossSiteOAuthState).toHaveLength(1);
		expect(collector.clearSession).toHaveLength(0);
	});
});

describe("what the instance actually sets on the wire (S-COOKIE-4, S-COOKIE-1)", () => {
	it("resolves the session the cookie names, and returns the token in no body", async () => {
		const answer = await mounted.handler(
			requestTo("/session", { method: "GET", cookie: `${SESSION_COOKIE}=${sessionToken}` }),
		);
		const body = await answer.text();

		expect(answer.status).toBe(200);
		expect(body).toContain('"session"');
		expect(body).not.toContain(sessionToken);
		expect(answer.headers.getSetCookie()).toStrictEqual([]);
	});

	it("clears the cookie with an empty value and no field smuggled into it", async () => {
		const answer = await mounted.handler(
			requestTo("/sign-out", { cookie: `${SESSION_COOKIE}=${sessionToken}`, body: {} }),
		);
		const headers = answer.headers.getSetCookie();
		const parts = partsOf(headers[0] ?? "");

		expect(answer.status).toBe(204);
		expect(headers).toHaveLength(1);
		expect(parts.name).toBe(SESSION_COOKIE);
		expect(parts.value).toBe("");
		expect(parts.attributes).toStrictEqual(["Max-Age=0", ...EXPECTED_ATTRIBUTES]);
	});

	it("no longer resolves the session it just ended", async () => {
		const answer = await mounted.handler(
			requestTo("/session", { method: "GET", cookie: `${SESSION_COOKIE}=${sessionToken}` }),
		);

		expect(await answer.text()).toBe("null");
	});
});
