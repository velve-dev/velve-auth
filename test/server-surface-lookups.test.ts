import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPendingAuthenticationService } from "../src/core/factor/pending/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { TEST_ORIGIN } from "./auth-fixtures.js";
import { mountWidest, signUpOn, type WidestMount } from "./widest-mount-fixtures.js";

/**
 * 3.15 B.2 and B.7 name a `resolveFromHeaders` beside each `resolve`, for an application that holds
 * the request headers rather than a token, and the instance did not carry either (E-2832).
 */

const FOREIGN_ORIGIN = "https://evil.example.com";

let widest: WidestMount;
let sessionCookie: string;
let userId: string;

beforeAll(async () => {
	widest = await mountWidest("lookups");
	({ sessionCookie, userId } = await signUpOn(widest));
}, 120_000);

afterAll(async () => {
	await widest.close();
});

function headersWith(cookie: string | null, origin: string | null = null): Headers {
	const headers = new Headers();
	if (cookie !== null) {
		headers.set("Cookie", cookie);
	}
	if (origin !== null) {
		headers.set("Origin", origin);
	}
	return headers;
}

async function codeOf(call: Promise<unknown>): Promise<string> {
	try {
		await call;
		return "answered";
	} catch (cause) {
		return (cause as { code?: string }).code ?? String(cause);
	}
}

describe("session.resolveFromHeaders (3.15 B.2)", () => {
	it("answers the session and the account the cookie names, as session.resolve does", async () => {
		const token = sessionCookie.slice(DEFAULT_COOKIE_NAMES.session.length + 1);
		const fromHeaders = await widest.auth.session.resolveFromHeaders(headersWith(sessionCookie));
		const fromToken = await widest.auth.session.resolve({
			sessionToken: token,
			origin: TEST_ORIGIN,
		});

		expect(fromHeaders?.user.id).toBe(userId);
		expect(fromHeaders?.session.id).toBe(fromToken?.session.id);
		expect(fromHeaders?.user).toStrictEqual(fromToken?.user);
	});

	it("answers null without the cookie and for a token that names no session", async () => {
		const unknown = `${DEFAULT_COOKIE_NAMES.session}=${"x".repeat(43)}`;

		expect(await widest.auth.session.resolveFromHeaders(headersWith(null))).toBeNull();
		expect(await widest.auth.session.resolveFromHeaders(headersWith(unknown))).toBeNull();
	});

	it("reads only the cookie, so the Origin of a navigation from another site changes nothing", async () => {
		const resolved = await widest.auth.session.resolveFromHeaders(
			headersWith(sessionCookie, FOREIGN_ORIGIN),
		);

		expect(resolved?.user.id).toBe(userId);
	});

	it("refuses a second session cookie rather than choosing one (S-COOKIE-5)", async () => {
		const twice = `${sessionCookie}; ${sessionCookie}`;

		expect(await codeOf(widest.auth.session.resolveFromHeaders(headersWith(twice)))).toBe(
			"invalid_input",
		);
	});

	it("throws account_disabled for a disabled account, as resolve does (L-4)", async () => {
		const disabled = await signUpOn(widest);
		await widest.auth.user.disable({ userId: disabled.userId, reason: "test" });

		expect(
			await codeOf(widest.auth.session.resolveFromHeaders(headersWith(disabled.sessionCookie))),
		).toBe("account_disabled");
	});
});

describe("pending.resolveFromHeaders (3.15 B.7)", () => {
	it("answers the intermediate state the pending cookie names, and null without one", async () => {
		const pending = createPendingAuthenticationService({
			driver: widest.connection,
			schema: widest.schema,
		});
		const begun = await pending.begin({ userId, factorsCompleted: ["password"] });
		const cookie = `${DEFAULT_COOKIE_NAMES.pending}=${begun.token}`;

		const fromHeaders = await widest.auth.pending.resolveFromHeaders(headersWith(cookie));

		expect(fromHeaders).toStrictEqual(await widest.auth.pending.resolve(begun.token));
		expect(fromHeaders?.factorsCompleted).toStrictEqual(["password"]);
		expect(await widest.auth.pending.resolveFromHeaders(headersWith(sessionCookie))).toBeNull();
	});
});
