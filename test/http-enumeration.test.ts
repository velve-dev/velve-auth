import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	ConcealedError,
	type ConcealedReason,
	toErrorBody,
	toVisibleFailure,
	type VelveErrorCode,
} from "../src/core/http/error-map.js";
import { type AnyRoute, defineRoute } from "../src/core/http/route.js";
import { object, string } from "../src/core/http/validators.js";
import { toWebHandler } from "../src/http/index.js";
import { createHarness, requestTo } from "./http-fixtures.js";

const SIGN_IN_REASONS: readonly ConcealedReason[] = [
	"user_not_found",
	"password_mismatch",
	"no_password_credential",
	"legacy_scheme_rejected",
	"user_disabled_on_sign_in",
];

const MERGED_GROUPS: Readonly<Record<string, readonly ConcealedReason[]>> = {
	invalid_credentials: SIGN_IN_REASONS,
	session_required: [
		"cookie_absent",
		"session_not_found",
		"session_idle_expired",
		"session_absolute_expired",
	],
	invalid_token: [
		"token_not_found",
		"token_expired",
		"token_consumed",
		"token_purpose_mismatch",
		"email_taken_on_change",
		"user_disabled_on_token_redemption",
	],
	invalid_factor_code: ["totp_code_wrong", "totp_step_replayed", "totp_not_confirmed"],
	invalid_recovery_code: [
		"recovery_code_not_found",
		"recovery_codes_exhausted",
		"recovery_codes_never_generated",
	],
	invalid_pending_authentication: [
		"pending_not_found",
		"pending_expired",
		"pending_consumed",
		"pending_cookie_absent",
	],
	oauth_flow_invalid: [
		"state_not_found",
		"state_expired",
		"pkce_mismatch",
		"nonce_mismatch",
		"issuer_mismatch",
		"id_token_signature_invalid",
		"user_disabled_on_oauth_flow",
	],
	webauthn_challenge_invalid: [
		"challenge_not_found",
		"challenge_expired",
		"challenge_purpose_mismatch",
	],
	webauthn_credential_rejected: [
		"credential_unknown",
		"signature_invalid",
		"rp_id_mismatch",
		"origin_mismatch",
		"user_not_verified",
		"user_disabled_on_webauthn_assertion",
	],
};

const ALL_REASONS: readonly ConcealedReason[] = Object.values(MERGED_GROUPS).flat();

function signInRouteFailingWith(reason: ConcealedReason): AnyRoute {
	return defineRoute({
		name: "test.signIn.password",
		method: "POST",
		path: "/sign-in/password",
		input: object({ emailOrUsername: string(), password: string() }),
		errors: ["invalid_credentials", "invalid_input", "rate_limited"] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: "none", perAccount: "none" },
		handler: async () => {
			throw new ConcealedError(reason);
		},
	});
}

function sourceFilesUnder(
	directory: URL,
	prefix = "",
): readonly { name: string; path: string; source: string }[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
		if (entry.isDirectory()) {
			return sourceFilesUnder(child, `${prefix}${entry.name}/`);
		}
		return entry.name.endsWith(".ts")
			? [{ name: entry.name, path: `${prefix}${entry.name}`, source: readFileSync(child, "utf8") }]
			: [];
	});
}

describe("enumeration — S-ENUM-1, S-ENUM-2, S-ENUM-6, L-4", () => {
	it("answers every internal sign-in reason with byte-identical status, headers and body", async () => {
		const answers = new Set<string>();

		for (const reason of SIGN_IN_REASONS) {
			const { environment } = createHarness({ routes: [signInRouteFailingWith(reason)] });
			const response = await toWebHandler({ http: environment })(
				requestTo("/sign-in/password", {
					body: { emailOrUsername: "someone@example.com", password: "wrong-password" },
				}),
			);
			const headers = [...response.headers]
				.map(([name, value]) => `${name}: ${value}`)
				.sort()
				.join("\n");
			answers.add(`${response.status}\n${headers}\n${await response.text()}`);
		}

		expect(answers.size).toBe(1);
		expect([...answers][0]).toContain('"code":"invalid_credentials"');
	});

	it("never sets a cookie on any rejected sign-in, so the header set cannot differ", async () => {
		for (const reason of SIGN_IN_REASONS) {
			const { environment } = createHarness({ routes: [signInRouteFailingWith(reason)] });
			const response = await toWebHandler({ http: environment })(
				requestTo("/sign-in/password", {
					body: { emailOrUsername: "someone@example.com", password: "wrong-password" },
				}),
			);
			expect([reason, response.headers.getSetCookie()]).toEqual([reason, []]);
		}
	});

	it("never produces account_disabled from any internal reason (L-4)", () => {
		for (const reason of ALL_REASONS) {
			expect([reason, toVisibleFailure(new ConcealedError(reason)).error.code]).not.toEqual([
				reason,
				"account_disabled",
			]);
		}
	});

	it("merges every internal reason of a group into one code, message and status", () => {
		for (const [code, reasons] of Object.entries(MERGED_GROUPS)) {
			const answers = new Set(
				reasons.map((reason) => {
					const failure = toVisibleFailure(new ConcealedError(reason));
					return `${failure.error.code}|${failure.error.httpStatus}|${JSON.stringify(
						toErrorBody(failure.error),
					)}`;
				}),
			);
			expect([code, answers.size]).toEqual([code, 1]);
			expect([code, [...answers][0]?.startsWith(`${code}|`)]).toEqual([code, true]);
		}
	});

	it("puts no internal reason into any visible body", () => {
		for (const reason of ALL_REASONS) {
			const body = JSON.stringify(toErrorBody(toVisibleFailure(new ConcealedError(reason)).error));
			expect([reason, body.includes(reason)]).toEqual([reason, false]);
		}
	});

	it("keeps a body that depends on nothing but the code", () => {
		const code: VelveErrorCode = "invalid_credentials";
		const first = toVisibleFailure(new ConcealedError("user_not_found")).error;
		const second = toVisibleFailure(new ConcealedError("user_disabled_on_sign_in")).error;
		second.message = "the account 42 is disabled";

		expect(JSON.stringify(toErrorBody(first))).toBe(JSON.stringify(toErrorBody(second)));
		expect(JSON.parse(JSON.stringify(toErrorBody(second))).error.code).toBe(code);
	});

	it("logs the true reason of every rejected sign-in", async () => {
		for (const reason of SIGN_IN_REASONS) {
			const { environment, logs } = createHarness({ routes: [signInRouteFailingWith(reason)] });
			await toWebHandler({ http: environment })(
				requestTo("/sign-in/password", {
					body: { emailOrUsername: "someone@example.com", password: "wrong-password" },
				}),
			);
			expect(logs.map((entry) => entry.fields?.reason)).toEqual([reason]);
		}
	});

	/**
	 * `.reason` alone names any property so called, and 3.15 G gives `PluginActor` one that has
	 * nothing to do with a concealed failure. What the requirement is about is reading the reason
	 * *off a `ConcealedError`*, so the file has to name that class to be reading one.
	 */
	/**
	 * `core/password/routes.ts` reads a `.reason` that is not a `ConcealedError`'s: `checkPassword`
	 * answers a refusal with the reason as a value, and the route raises it so the pipeline logs the
	 * true one (S-ENUM-6). Producing a `ConcealedError` is the opposite of deciding what one means,
	 * so the exemption is by path and covers that file alone — `instanceof ConcealedError`, which is
	 * the only way to have one in hand to read, still fails for every file including this one
	 * (E-1188).
	 */
	const MAY_NAME_A_REASON_BESIDE_THE_CLASS = "core/password/routes.ts";

	it("decides the visible code from an internal reason in exactly one file", () => {
		const files = sourceFilesUnder(new URL("../src/", import.meta.url));
		const deciders = files.filter(
			({ name, path, source }) =>
				name !== "error-map.ts" &&
				(source.includes("instanceof ConcealedError") ||
					(path !== MAY_NAME_A_REASON_BESIDE_THE_CLASS &&
						source.includes("ConcealedError") &&
						source.includes(".reason"))),
		);

		expect(deciders.map(({ path }) => path)).toEqual([]);
		expect(
			files.filter(({ source }) => source.includes("VISIBLE_CODE_BY_CONCEALED_REASON")).length,
		).toBe(1);
	});

	it("builds a response in exactly one module and hard-codes a status in exactly one other", () => {
		const files = sourceFilesUnder(new URL("../src/", import.meta.url));

		expect(
			files.filter(({ source }) => source.includes("new Response(")).map(({ name }) => name),
		).toEqual(["response.ts"]);
		expect(
			files
				.filter(({ name }) => name !== "error-map.ts")
				.flatMap(({ name, source }) =>
					[...source.matchAll(/(?:jsonResponse|bodilessResponse)\(\s*(\d{3})/g)].map(
						(match) => `${name}:${match[1]}`,
					),
				)
				.sort(),
		).toEqual(["web-handler.ts:200", "web-handler.ts:204", "web-handler.ts:404"]);
	});
});
