import { describe, expect, it } from "vitest";
import {
	ConcealedError,
	type ConcealedReason,
	toErrorBody,
	toVisibleFailure,
	VelveError,
} from "../src/core/http/error-map.js";

const SIGN_IN_REASONS: readonly ConcealedReason[] = [
	"user_not_found",
	"password_mismatch",
	"no_password_credential",
	"legacy_scheme_rejected",
	"user_disabled_on_sign_in",
];

describe("error map", () => {
	it("gives every visible error the status of its code", () => {
		expect(new VelveError("origin_not_allowed").httpStatus).toBe(403);
		expect(new VelveError("rate_limited").httpStatus).toBe(429);
		expect(new VelveError("internal_error").httpStatus).toBe(500);
	});

	it("merges every sign-in reason into invalid_credentials", () => {
		for (const reason of SIGN_IN_REASONS) {
			expect(toVisibleFailure(new ConcealedError(reason)).error.code).toBe("invalid_credentials");
		}
	});

	it("never turns a sign-in reason into account_disabled", () => {
		for (const reason of SIGN_IN_REASONS) {
			expect(toVisibleFailure(new ConcealedError(reason)).error.code).not.toBe("account_disabled");
		}
	});

	it("produces byte-identical bodies for merged reasons", () => {
		const bodies = SIGN_IN_REASONS.map((reason) =>
			JSON.stringify(toErrorBody(toVisibleFailure(new ConcealedError(reason)).error)),
		);

		expect(new Set(bodies).size).toBe(1);
	});

	it("keeps the true reason for the server-side log", () => {
		expect(toVisibleFailure(new ConcealedError("session_absolute_expired")).loggedReason).toBe(
			"session_absolute_expired",
		);
	});

	it("reveals nothing about an unexpected exception", () => {
		const failure = toVisibleFailure(new Error("connection to 10.0.0.4 refused"));

		expect(failure.error.code).toBe("internal_error");
		expect(JSON.stringify(toErrorBody(failure.error))).not.toContain("10.0.0.4");
		expect(failure.loggedReason).toBe("unhandled_exception");
	});

	it("carries a retry hint only where one was given", () => {
		expect(toErrorBody(new VelveError("rate_limited", { retryAfterSeconds: 12 }))).toEqual({
			error: { code: "rate_limited", message: "Too many requests.", retryAfterSeconds: 12 },
		});
		expect(toErrorBody(new VelveError("rate_limited"))).toEqual({
			error: { code: "rate_limited", message: "Too many requests." },
		});
	});
});
