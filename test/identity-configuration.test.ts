import { describe, expect, it } from "vitest";
import {
	DEFAULT_USERNAME_RULES,
	type IdentityConfiguration,
	IdentityConfigurationError,
	type IdentityConfigurationInput,
	resolveIdentityConfiguration,
	type UsernameRules,
} from "../src/core/identity/configuration.js";
import { caseFolded } from "../src/core/identity/fold.js";
import { normaliseUsername } from "../src/core/identity/normalise.js";

type IsUnrepresentable<Candidate> = Candidate extends IdentityConfiguration ? false : true;

const emailModeCannotCarryUsernameRules: IsUnrepresentable<{
	mode: "email";
	username: UsernameRules;
}> = true;
const usernameModeCannotOmitRules: IsUnrepresentable<{ mode: "username" }> = true;
const usernameEmailModeCannotOmitRules: IsUnrepresentable<{ mode: "username_email" }> = true;
const usernameModeWithRulesIsRepresentable: IsUnrepresentable<{
	mode: "username";
	username: UsernameRules;
}> = false;

describe("identity configuration", () => {
	it("makes every combination the three modes do not have unrepresentable (E-15)", () => {
		expect([
			emailModeCannotCarryUsernameRules,
			usernameModeCannotOmitRules,
			usernameEmailModeCannotOmitRules,
			usernameModeWithRulesIsRepresentable,
		]).toEqual([true, true, true, false]);
	});

	it("carries no username rules in the email mode", () => {
		const input: IdentityConfigurationInput<"email"> = { mode: "email" };
		expect(resolveIdentityConfiguration(input)).toEqual({ mode: "email" });
	});

	it("fills the documented defaults", () => {
		expect(resolveIdentityConfiguration({ mode: "username_email" })).toEqual({
			mode: "username_email",
			username: DEFAULT_USERNAME_RULES,
		});
	});

	it("keeps every override the caller gives", () => {
		const resolved = resolveIdentityConfiguration({
			mode: "username",
			username: { minimumLength: 5, maximumLength: 12, allowedCharacters: /^[a-z.]+$/ },
		});
		expect(resolved.username).toEqual({
			allowedCharacters: /^[a-z.]+$/,
			minimumLength: 5,
			maximumLength: 12,
			reservedNames: [],
		});
	});

	it("stores reserved names in the comparison form they will be compared against", () => {
		const resolved = resolveIdentityConfiguration({
			mode: "username",
			username: { reservedNames: ["Admin", "ＲＯＯＴ", "  spaced  "] },
		});
		expect(resolved.username.reservedNames).toEqual(["admin", "root", "spaced"]);
	});

	/**
	 * A reservation folded over the whole string ends in U+03C2 where the key it is compared
	 * against ends in U+03C3, and the reservation then matches nothing at all.
	 */
	it("folds a reserved name the same way the key it guards is folded", () => {
		const greek = resolveIdentityConfiguration({
			mode: "username",
			username: { allowedCharacters: /^[\p{L}\p{N}\p{M}_-]+$/u, reservedNames: ["ΟΔΟΣ"] },
		});
		expect(greek.username.reservedNames).toEqual([caseFolded("ΟΔΟΣ".normalize("NFKC"))]);
		expect(normaliseUsername("ΟΔΟΣ", greek.username)).toEqual({
			accepted: false,
			rejection: "reserved",
		});
		expect(normaliseUsername("οδοσ", greek.username)).toEqual({
			accepted: false,
			rejection: "reserved",
		});
	});

	it("reserves every spelling that folds onto a reserved name", () => {
		const reserved = resolveIdentityConfiguration({
			mode: "username",
			username: { reservedNames: ["admin"] },
		});
		for (const spelling of ["admin", "ADMIN", "Admin", "ＡＤＭＩＮ", " admin "]) {
			expect([spelling, normaliseUsername(spelling, reserved.username)]).toEqual([
				spelling,
				{ accepted: false, rejection: "reserved" },
			]);
		}
	});

	it("refuses an allowlist that does not match the whole name", () => {
		expect(() =>
			resolveIdentityConfiguration({
				mode: "username",
				username: { allowedCharacters: /[a-z]+/ },
			}),
		).toThrow(IdentityConfigurationError);
	});

	it("refuses an allowlist whose lastIndex survives between two names", () => {
		expect(() =>
			resolveIdentityConfiguration({
				mode: "username",
				username: { allowedCharacters: /^[a-z]+$/g },
			}),
		).toThrow(IdentityConfigurationError);
	});

	it("refuses length bounds that no name can satisfy", () => {
		expect(() =>
			resolveIdentityConfiguration({
				mode: "username",
				username: { minimumLength: 9, maximumLength: 4 },
			}),
		).toThrow(IdentityConfigurationError);
		expect(() =>
			resolveIdentityConfiguration({ mode: "username", username: { minimumLength: 0 } }),
		).toThrow(IdentityConfigurationError);
	});
});
