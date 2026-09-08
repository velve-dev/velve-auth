import { describe, expect, it } from "vitest";
import type { IdentityMode } from "../src/core/db/migrations/identity-mode.js";
import {
	assertRecoveryCodesAreConfigured,
	RecoveryCodesRequiredError,
	recoveryCodesAreMandatoryFor,
} from "../src/core/factor/recovery/index.js";

const EVERY_IDENTITY_MODE: readonly IdentityMode[] = ["email", "username", "username_email"];

/**
 * T-DEFAULT-4 states the case as `createVelveAuth({ identity: "username" })`, which `auth-core`
 * builds. This is the mechanism that call has to reach, and until it exists this is the only place
 * S-DEFAULT-4 is fulfilled or checked at all.
 */
describe("T-DEFAULT-4: identity username without recovery codes is a start error (S-DEFAULT-4)", () => {
	it("refuses the first configuration and accepts the second", () => {
		expect(() =>
			assertRecoveryCodesAreConfigured({ identityMode: "username", recoveryCodes: false }),
		).toThrow(RecoveryCodesRequiredError);
		expect(() =>
			assertRecoveryCodesAreConfigured({ identityMode: "username", recoveryCodes: true }),
		).not.toThrow();
	});

	it("names both options in the message", () => {
		try {
			assertRecoveryCodesAreConfigured({ identityMode: "username", recoveryCodes: false });
			throw new Error("the configuration was accepted");
		} catch (failure) {
			expect(failure).toBeInstanceOf(RecoveryCodesRequiredError);
			expect((failure as Error).message).toContain('identity: "username"');
			expect((failure as Error).message).toContain("recoveryCodes: true");
		}
	});

	it("carries a machine-readable code (CLAUDE.md section 3)", () => {
		expect(new RecoveryCodesRequiredError("username").code).toBe("recovery_codes_required");
	});

	it.each(EVERY_IDENTITY_MODE)("decides %s the same way in both entry points", (identityMode) => {
		const mandatory = recoveryCodesAreMandatoryFor(identityMode);
		expect(mandatory).toBe(identityMode === "username");
		expect(() =>
			assertRecoveryCodesAreConfigured({ identityMode, recoveryCodes: false }),
		).toSatisfy((refuse: () => void) => {
			try {
				refuse();
				return !mandatory;
			} catch {
				return mandatory;
			}
		});
	});

	it("leaves the two modes that carry an e-mail address free to omit the codes", () => {
		expect(() =>
			assertRecoveryCodesAreConfigured({ identityMode: "email", recoveryCodes: false }),
		).not.toThrow();
		expect(() =>
			assertRecoveryCodesAreConfigured({ identityMode: "username_email", recoveryCodes: false }),
		).not.toThrow();
	});

	it("covers every identity mode the migration can create", () => {
		expect(EVERY_IDENTITY_MODE).toHaveLength(3);
	});
});
