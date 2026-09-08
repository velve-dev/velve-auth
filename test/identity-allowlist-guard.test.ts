import { describe, expect, it } from "vitest";
import {
	IdentityConfigurationError,
	resolveIdentityConfiguration,
	type UsernameRules,
} from "../src/core/identity/configuration.js";
import { normaliseUsername } from "../src/core/identity/normalise.js";

function rulesFor(allowedCharacters: RegExp): UsernameRules | IdentityConfigurationError {
	try {
		return resolveIdentityConfiguration({ mode: "username", username: { allowedCharacters } })
			.username;
	} catch (cause) {
		return cause instanceof IdentityConfigurationError
			? cause
			: new IdentityConfigurationError("an unexpected error");
	}
}

function admits(allowedCharacters: RegExp, candidate: string): string {
	const rules = rulesFor(allowedCharacters);
	if (rules instanceof IdentityConfigurationError) {
		return "refused at start";
	}
	const normalised = normaliseUsername(candidate, rules);
	return normalised.accepted
		? `stored as ${JSON.stringify(normalised.value.usernameKey)}`
		: `refused as ${normalised.rejection}`;
}

describe("the guard on a caller's allowlist (E-193)", () => {
	it("refuses a pattern that is not anchored at both ends", () => {
		expect(admits(/[a-z0-9]+$/, "***abc")).toBe("refused at start");
		expect(admits(/^[a-z0-9]+/, "abc***")).toBe("refused at start");
	});

	it("refuses a pattern whose lastIndex would survive between two names", () => {
		expect(admits(/^[a-z0-9]+$/g, "abc")).toBe("refused at start");
		expect(admits(/^[a-z0-9]+$/y, "abc")).toBe("refused at start");
	});

	it("accepts a widened pattern that really does match the whole name", () => {
		expect(admits(/^[a-zäöüß0-9_-]+$/, "grüße")).toBe('stored as "grüße"');
	});

	/**
	 * `assertWholeStringPattern` reads only the first and last character of the source, so an
	 * alternation anchored on one branch passes the guard and admits everything the other branch
	 * matches anywhere in the name.
	 */
	it("refuses an alternation that anchors only one of its branches", () => {
		expect(admits(/^[a-z]+|[0-9]+$/, "abc***123")).toBe("refused at start");
	});

	/**
	 * The `m` flag turns `^` and `$` into line anchors, so a pattern that looks whole-string
	 * accepts any name whose first line matches. `\n` is not trimmed away from the middle.
	 */
	it("refuses a pattern carrying the multiline flag", () => {
		expect(admits(/^[a-z0-9_-]+$/m, "alice\n***evil")).toBe("refused at start");
	});
});
