import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertCookieNamesAreEnumerated,
	DEFAULT_COOKIE_NAMES,
	type HostPrefixedCookieName,
} from "../src/core/http/cookies.js";
import { VelveError } from "../src/core/http/error-map.js";
import { InvalidSessionConfigError, sessionSettingsOf } from "../src/core/session/config.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { PROOF_PASSWORD, parseSetCookie } from "./proof-fixtures.js";

const CONFIGURED_NAME: HostPrefixedCookieName = "__Host-application_session";

let mounted: MountedAuth;
let sessionToken: string;
let signUpCookies: readonly string[];

beforeAll(async () => {
	mounted = await mountAuth("cookiename", { session: { cookieName: CONFIGURED_NAME } });
	const answer = await mounted.handler(
		postTo("/sign-up", { email: "named@example.com", password: PROOF_PASSWORD }),
	);
	if (answer.status !== 200) {
		throw new Error(`the sign-up answered ${answer.status}`);
	}
	signUpCookies = answer.headers.getSetCookie();
	sessionToken = parseSetCookie(signUpCookies[0] ?? "").value;
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

function readSession(cookie: string): Promise<Response> {
	return mounted.handler(requestTo("/session", { method: "GET", cookie }));
}

/**
 * Architecture 3.15 A.5 offers `session.cookieName`, and S-COOKIE-1 names the session cookie
 * `__Host-velve_session` by default or the configured name. Until E-2550 the option was
 * validated at start and then ignored; these cases hold it to being honoured, through the
 * mounted handler, on writing and on reading.
 */
describe("session.cookieName is the name written and read (S-COOKIE-1)", () => {
	/** T-COOKIE-1 under a configured name: the name exactly, the attribute set exactly. */
	it("writes the configured name, and only it, with the fixed attribute set", () => {
		const cookies = signUpCookies.map(parseSetCookie);

		expect(cookies.map((cookie) => cookie.name)).toStrictEqual([CONFIGURED_NAME]);
		expect(
			cookies[0]?.attributes.filter((attribute) => !attribute.startsWith("Max-Age=")),
		).toStrictEqual(["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]);
		expect(sessionToken).not.toBe("");
	});

	it("resolves the session from a cookie of the configured name", async () => {
		const answer = await readSession(`${CONFIGURED_NAME}=${sessionToken}`);
		const body = (await answer.json()) as { session?: unknown } | null;

		expect(answer.status).toBe(200);
		expect(body?.session).toBeDefined();
	});

	it("ignores the default name once another one is configured", async () => {
		const underDefault = await readSession(`${DEFAULT_COOKIE_NAMES.session}=${sessionToken}`);
		const withoutCookie = await mounted.handler(requestTo("/session", { method: "GET" }));

		expect(withoutCookie.status).toBe(200);
		expect([underDefault.status, await underDefault.text()]).toStrictEqual([
			withoutCookie.status,
			await withoutCookie.text(),
		]);
	});

	/** T-COOKIE-5 under a configured name: both orders, and among unrelated cookies. */
	it("rejects a request that carries the configured name twice (S-COOKIE-5)", async () => {
		for (const cookie of [
			`${CONFIGURED_NAME}=A; ${CONFIGURED_NAME}=${sessionToken}`,
			`${CONFIGURED_NAME}=${sessionToken}; ${CONFIGURED_NAME}=A`,
			`theme=dark; ${CONFIGURED_NAME}=${sessionToken}; other=1; ${CONFIGURED_NAME}=A`,
		]) {
			const answer = await readSession(cookie);
			const body = await answer.text();
			expect([cookie, answer.status, body.includes('"session"')]).toStrictEqual([
				cookie,
				400,
				false,
			]);
		}
	});

	it("clears the configured name on sign-out", async () => {
		const answer = await mounted.handler(
			requestTo("/sign-out", { cookie: `${CONFIGURED_NAME}=${sessionToken}`, body: {} }),
		);
		const cookies = answer.headers.getSetCookie().map(parseSetCookie);

		expect(answer.status).toBe(204);
		expect(cookies.map((cookie) => [cookie.name, cookie.value])).toStrictEqual([
			[CONFIGURED_NAME, ""],
		]);
	});
});

describe("the enumerated set follows the configured name (S-COOKIE-6)", () => {
	const configured = { ...DEFAULT_COOKIE_NAMES, session: CONFIGURED_NAME };

	function instructionNamed(name: HostPrefixedCookieName) {
		return {
			name,
			value: "token",
			maximumAgeInSeconds: 60,
			attributes: "HttpOnly; Secure; SameSite=Lax; Path=/",
		} as const;
	}

	it("accepts the configured session name with the fixed pending and state names", () => {
		expect(() =>
			assertCookieNamesAreEnumerated(
				[CONFIGURED_NAME, configured.pending, configured.oauthState].map(instructionNamed),
				configured,
			),
		).not.toThrow();
	});

	it("refuses the default session name once another one is configured", () => {
		expect(() =>
			assertCookieNamesAreEnumerated([instructionNamed(DEFAULT_COOKIE_NAMES.session)], configured),
		).toThrow(new VelveError("internal_error"));
	});
});

describe("the configured name is checked at start", () => {
	it("refuses a name the pending or the state cookie already carries", () => {
		for (const cookieName of [DEFAULT_COOKIE_NAMES.pending, DEFAULT_COOKIE_NAMES.oauthState]) {
			expect(() => sessionSettingsOf({ cookieName })).toThrow(InvalidSessionConfigError);
		}
	});

	it("still refuses a name without the __Host- prefix", () => {
		expect(() =>
			sessionSettingsOf({ cookieName: "application_session" as HostPrefixedCookieName }),
		).toThrow(InvalidSessionConfigError);
	});
});
