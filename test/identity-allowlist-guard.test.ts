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
	 * An alternation anchored on one branch leaves the other free to match anywhere in the name.
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

/** Written as a variable so that neither the formatter nor the ES2023 target folds it into a literal. */
const UNICODE_SETS = "v";

const LEAK_PROBES: readonly string[] = [
	"***",
	"\n***",
	"@@@",
	"abc***",
	"abc\n***",
	"***abc",
	" x",
	"­",
];

function leaksFrom(allowedCharacters: RegExp): string[] | "refused at start" {
	let rules: UsernameRules;
	try {
		rules = resolveIdentityConfiguration({
			mode: "username",
			username: { allowedCharacters, minimumLength: 1, maximumLength: 64 },
		}).username;
	} catch {
		return "refused at start";
	}
	return LEAK_PROBES.filter((probe) => normaliseUsername(`abc${probe}`, rules).accepted);
}

describe("the guard read as an allowlist rather than as a syntax rule", () => {
	const mustBeRefused: readonly RegExp[] = [
		/^[a-z]+|[0-9]+$/,
		/^[0-9]+|^[a-z]+$/,
		/^[a-z]+$|^[0-9]+$/,
		/^[(]|[a-z]+$/u,
		/^(^[a-z]+)$/,
		/^[a-z]+$[a-z]*$/,
		/^[a-z]+(?:$)/,
		/[a-z]+$/,
		/^[a-z]+/,
		/^[a-z]+$/m,
		/^[a-z]+$/g,
		/^[a-z]+$/y,
	];

	const mustBeAccepted: readonly RegExp[] = [
		/^[a-z0-9]+$/,
		/^(?:[a-z]+|[0-9]+)$/,
		/^(?=.*[a-z])[a-z0-9]+$/,
		/^(?<only>[a-z]+)$/,
		/^[a-z0-9|]+$/,
		/^[a-z0-9|]+$/u,
		/^[a-z]+\|[0-9]+$/u,
		/^[$^|]+$/u,
		/^[^\W]+$/,
		/^\^[a-z]+$/,
		/^[a-z]+\$$/,
		/^\([a-z]+\)$/u,
		/^[a-z]{1,8}$/u,
		/^\p{L}+$/u,
		/^[\p{L}\p{N}]+$/u,
		new RegExp("^[[a-z][0-9]]+$", UNICODE_SETS),
		new RegExp("^[\\q{a|b}]+$", UNICODE_SETS),
		/^[a-z]+$/s,
		/^[a-z]+$/d,
		/^[a-z]+$/i,
		/^[a-z]+$/iu,
	];

	it("refuses every pattern that could match less than a whole name", () => {
		const admitted = mustBeRefused.filter((pattern) => leaksFrom(pattern) !== "refused at start");
		expect(admitted.map(String)).toEqual([]);
	});

	it("accepts every pattern that is genuinely whole-string, and none of them leaks", () => {
		const wrong = mustBeAccepted.flatMap((pattern) => {
			const leaks = leaksFrom(pattern);
			if (leaks === "refused at start") {
				return [`${pattern} was refused although it matches the whole name`];
			}
			return leaks.length > 0 ? [`${pattern} admitted ${JSON.stringify(leaks)}`] : [];
		});
		expect(wrong).toEqual([]);
	});

	/** Perl and Python let `$` match before a final newline; JavaScript does not, so `m` is the whole hole. */
	it("has no trailing-newline allowance behind the anchor", () => {
		expect(/^[a-z]+$/.test("abc\n")).toBe(false);
		expect(/^[a-z]+$/m.test("abc\n")).toBe(true);
		expect(admits(/^[a-z0-9_-]+$/, "abc\nabc")).toBe("refused as invalid_characters");
		expect(admits(/^[a-z0-9_-]+$/, "abc\n")).toBe('stored as "abc"');
	});

	it("still reports a wildcard as a refused character and not as a length", () => {
		const rules = resolveIdentityConfiguration({ mode: "username" }).username;
		expect(normaliseUsername("*", rules)).toEqual({
			accepted: false,
			rejection: "invalid_characters",
		});
		expect(normaliseUsername("ali%ce", rules)).toEqual({
			accepted: false,
			rejection: "invalid_characters",
		});
	});

	it("settles the length before the caller's pattern sees the input", () => {
		const rules = resolveIdentityConfiguration({
			mode: "username",
			username: { allowedCharacters: /^(?:[a-z]+)+$/ },
		}).username;
		const started = process.hrtime.bigint();
		const outcome = normaliseUsername(`${"a".repeat(200_000)}!`, rules);
		const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
		expect(outcome).toEqual({ accepted: false, rejection: "too_long" });
		expect(elapsedMs).toBeLessThan(1000);
	});
});
