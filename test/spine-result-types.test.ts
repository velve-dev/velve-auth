import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { PendingAuthentication, Session } from "../src/core/http/caller.js";
import type {
	Identity,
	OAuthCallbackResult,
	OAuthRedirect,
	PendingToken,
	SessionToken,
	SignInResult,
	SignUpResult,
	User,
} from "../src/index.js";

type SignedIn = Extract<SignInResult, { status: "signed_in" }>;
type SecondFactorRequired = Extract<SignInResult, { status: "second_factor_required" }>;
type IdentityLinked = Exclude<OAuthCallbackResult, SignInResult>;

describe("SignUpResult is 3.15 B.1's record", () => {
	it("carries the user, the token and the session and nothing else", () => {
		expectTypeOf<keyof SignUpResult>().toEqualTypeOf<"user" | "sessionToken" | "session">();
		expectTypeOf<SignUpResult["user"]>().toEqualTypeOf<User>();
		expectTypeOf<SignUpResult["sessionToken"]>().toEqualTypeOf<SessionToken>();
		expectTypeOf<SignUpResult["session"]>().toEqualTypeOf<Session>();
	});
});

describe("SignInResult is 3.15 C.1's discriminated union", () => {
	it("has exactly the two branches, discriminated by status", () => {
		expectTypeOf<SignInResult["status"]>().toEqualTypeOf<"signed_in" | "second_factor_required">();
	});

	it("carries the session on the signed-in branch", () => {
		expectTypeOf<keyof SignedIn>().toEqualTypeOf<
			"status" | "sessionToken" | "session" | "user" | "signCountRegressed"
		>();
		expectTypeOf<SignedIn["sessionToken"]>().toEqualTypeOf<SessionToken>();
		expectTypeOf<SignedIn["user"]>().toEqualTypeOf<User>();
	});

	/** L-9: `undefined` means "not applicable", never "no". */
	it("makes signCountRegressed optional rather than a boolean that is always answered", () => {
		expectTypeOf<SignedIn["signCountRegressed"]>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<SignedIn>().toMatchTypeOf<{ signCountRegressed?: boolean }>();
	});

	/**
	 * 3.15 C.1: on this branch there is no `Session` and no `sessionToken` — not as `null`, not as an
	 * optional field, but as an absent property, so `result.sessionToken` does not compile unchecked.
	 */
	it("has no session and no session token on the second-factor branch, as absent properties", () => {
		expectTypeOf<keyof SecondFactorRequired>().toEqualTypeOf<
			"status" | "pendingToken" | "pending"
		>();
		expectTypeOf<SecondFactorRequired>().not.toMatchTypeOf<{ sessionToken?: unknown }>();
		expectTypeOf<SecondFactorRequired>().not.toMatchTypeOf<{ session?: unknown }>();
		expectTypeOf<SecondFactorRequired["pendingToken"]>().toEqualTypeOf<PendingToken>();
		expectTypeOf<SecondFactorRequired["pending"]>().toEqualTypeOf<PendingAuthentication>();
	});

	it("names the second factors the intermediate state can offer, and only those three", () => {
		expectTypeOf<PendingAuthentication["availableFactors"]>().toEqualTypeOf<
			readonly ("totp" | "webauthn" | "recovery")[]
		>();
	});
});

describe("OAuthRedirect and OAuthCallbackResult are 3.15 C's", () => {
	it("gives the redirect a URL and the state cookie, and nothing else", () => {
		expectTypeOf<keyof OAuthRedirect>().toEqualTypeOf<"authorizationUrl" | "stateCookie">();
		expectTypeOf<OAuthRedirect["authorizationUrl"]>().toEqualTypeOf<string>();
		expectTypeOf<keyof OAuthRedirect["stateCookie"]>().toEqualTypeOf<
			"name" | "value" | "maximumAgeInSeconds" | "attributes"
		>();
	});

	it("widens the callback result by exactly the linked branch", () => {
		expectTypeOf<IdentityLinked["status"]>().toEqualTypeOf<"identity_linked">();
		expectTypeOf<keyof IdentityLinked>().toEqualTypeOf<
			"status" | "identity" | "sessionToken" | "session"
		>();
		expectTypeOf<IdentityLinked["identity"]>().toEqualTypeOf<Identity>();
	});

	it("re-issues the session on the linked branch, because a new identity changes the trust level", () => {
		expectTypeOf<IdentityLinked["sessionToken"]>().toEqualTypeOf<SessionToken>();
		expectTypeOf<IdentityLinked["session"]>().toEqualTypeOf<Session>();
	});
});

describe("Identity is 3.15 C's record", () => {
	it("carries the nine fields and reads no provider claim", () => {
		expectTypeOf<keyof Identity>().toEqualTypeOf<
			| "id"
			| "provider"
			| "subject"
			| "createdAt"
			| "providerEmail"
			| "providerEmailVerified"
			| "profile"
			| "scopes"
			| "tokenExpiresAt"
		>();
		expectTypeOf<Identity["profile"]>().toEqualTypeOf<unknown>();
	});
});

/**
 * E-753: 3.15 C names `CookieInstruction` in the same block as `OAuthRedirect`, and it is the one place a
 * server method mentions a cookie — so an application handling the redirect has to be able to name
 * the type it is handed.
 */
describe("the vocabulary of the four result types is importable by name", () => {
	it("names every type the four results are written in terms of in the package's own exports", () => {
		const declaration = readFileSync(new URL("../dist/index.d.mts", import.meta.url), "utf8");
		const exported = new Set(
			[...declaration.matchAll(/\btype (\w+)|\bexport \{([^}]*)\}/g)]
				.flatMap((match) => `${match[1] ?? ""},${match[2] ?? ""}`.split(","))
				.map((name) => name.replace("type ", "").trim()),
		);
		const named = [
			"SignUpResult",
			"SignInResult",
			"OAuthRedirect",
			"OAuthCallbackResult",
			"Identity",
			"Session",
			"SessionToken",
			"PendingToken",
			"PendingAuthentication",
			"User",
			"CookieInstruction",
		];

		expect(exported.has("SignInResult")).toBe(true);
		expect(named.filter((name) => !exported.has(name))).toStrictEqual([]);
	});
});
