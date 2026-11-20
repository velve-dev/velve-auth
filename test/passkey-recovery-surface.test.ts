import { describe, expect, expectTypeOf, it } from "vitest";
import { VelveStartupError } from "../src/core/auth/startup.js";
import type { Driver } from "../src/core/db/driver.js";
import { resolveErrorCode } from "../src/core/http/error-map.js";
import {
	LONGEST_PASSKEY_RECOVERY_WAIT_IN_SECONDS,
	waitingPeriodWithinBounds,
} from "../src/core/recovery/config.js";
import type { PasskeyRecoveryNamespace, VelveAuth } from "../src/index.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";

/**
 * 3.15 A.8, B and D.3: the recovery to a new passkey is off unless `webauthn.recovery` names a
 * waiting period, its five routes exist only then, the start refuses a configuration it cannot
 * run, and the waiting period is clamped to the library's bounds.
 */

const NO_DATABASE: Driver = {
	query: () => Promise.reject(new Error("no statement runs while an instance is assembled")),
	transaction: () => Promise.reject(new Error("no statement runs while an instance is assembled")),
};

const WEBAUTHN = {
	relyingPartyId: "app.example.com",
	relyingPartyName: "Velve Auth tests",
	origins: [TEST_ORIGIN],
	userVerification: "required",
} as const;

const RECOVERY_ROUTES = [
	"POST /passkey-recovery/request",
	"POST /passkey-recovery/start",
	"POST /passkey-recovery/finish",
	"GET /passkey-recovery",
	"POST /passkey-recovery/cancel",
];

function recoveryRoutesOf(auth: VelveAuth<"email">): string[] {
	return auth.routes
		.filter((route) => route.path.startsWith("/passkey-recovery"))
		.map((route) => `${route.method} ${route.path}`);
}

describe("the recovery is off unless configured (3.15 A.8)", () => {
	it("mounts its five routes and namespace with webauthn.recovery", () => {
		const auth = createVelveAuth(
			configFor({
				database: NO_DATABASE,
				keys: testKeyProvider(),
				webauthn: { ...WEBAUTHN, recovery: { waitingPeriodInSeconds: () => 0 } },
			}),
		);

		expect(recoveryRoutesOf(auth)).toStrictEqual(RECOVERY_ROUTES);
		expect(Object.keys(auth.passkeyRecovery).sort()).toStrictEqual([
			"cancel",
			"finish",
			"pending",
			"request",
			"start",
		]);
	});

	it("has no route without it, and none without webauthn", () => {
		const withoutRecovery = createVelveAuth(
			configFor({ database: NO_DATABASE, keys: testKeyProvider(), webauthn: WEBAUTHN }),
		);
		const withoutWebAuthn = createVelveAuth(
			configFor({ database: NO_DATABASE, keys: testKeyProvider() }),
		);

		expect(recoveryRoutesOf(withoutRecovery)).toStrictEqual([]);
		expect(recoveryRoutesOf(withoutWebAuthn)).toStrictEqual([]);
		expect((withoutRecovery as { passkeyRecovery?: unknown }).passkeyRecovery).toBeUndefined();
	});

	it.each([
		["a recovery without a function", { recovery: { waitingPeriodInSeconds: 30 } }],
		["a recovery that is no object", { recovery: "30d" }],
	])("refuses to start with %s", (_case, extra) => {
		expect(() =>
			createVelveAuth(
				configFor({
					database: NO_DATABASE,
					keys: testKeyProvider(),
					webauthn: { ...WEBAUTHN, ...(extra as object) } as never,
				}),
			),
		).toThrow(expect.objectContaining({ code: "passkey_recovery_unusable" }));
	});

	it("refuses to start in mode username, where no address begins a recovery", () => {
		let refusal: unknown;
		try {
			createVelveAuth({
				identity: { mode: "username", username: {} },
				database: NO_DATABASE,
				keys: testKeyProvider(),
				origins: [TEST_ORIGIN],
				recoveryCodes: { count: 10, groupSize: 5 },
				webauthn: { ...WEBAUTHN, recovery: { waitingPeriodInSeconds: () => 0 } },
			} as never);
		} catch (error) {
			refusal = error;
		}

		expect(refusal).toBeInstanceOf(VelveStartupError);
		expect((refusal as VelveStartupError).code).toBe("passkey_recovery_unusable");
	});
});

describe("the waiting period is clamped to the library's bounds (3.15 A.8)", () => {
	it.each([
		[0, 0],
		[1.2, 2],
		[-30, 0],
		[Number.NEGATIVE_INFINITY, 0],
		[86_400, 86_400],
		[LONGEST_PASSKEY_RECOVERY_WAIT_IN_SECONDS + 1, LONGEST_PASSKEY_RECOVERY_WAIT_IN_SECONDS],
		[Number.POSITIVE_INFINITY, LONGEST_PASSKEY_RECOVERY_WAIT_IN_SECONDS],
		[Number.NaN, LONGEST_PASSKEY_RECOVERY_WAIT_IN_SECONDS],
		["3600", LONGEST_PASSKEY_RECOVERY_WAIT_IN_SECONDS],
		[undefined, LONGEST_PASSKEY_RECOVERY_WAIT_IN_SECONDS],
	])("reads %s as %s seconds", (answer, seconds) => {
		expect(waitingPeriodWithinBounds(answer)).toBe(seconds);
	});

	it("waits thirty days at the longest", () => {
		expect(LONGEST_PASSKEY_RECOVERY_WAIT_IN_SECONDS).toBe(30 * 24 * 60 * 60);
	});
});

describe("the surface of the recovery (3.15 B, F)", () => {
	it("answers every failing step with one code of status 400", () => {
		expect(resolveErrorCode("passkey_recovery_failed")).toStrictEqual({
			httpStatus: 400,
			message: "The recovery could not be continued.",
		});
	});

	it("is typed in the modes with an address and absent in mode username", () => {
		expectTypeOf<VelveAuth<"email">["passkeyRecovery"]>().toEqualTypeOf<PasskeyRecoveryNamespace>();
		expectTypeOf<
			VelveAuth<"username_email">["passkeyRecovery"]
		>().toEqualTypeOf<PasskeyRecoveryNamespace>();
		expectTypeOf<VelveAuth<"username">>().not.toHaveProperty("passkeyRecovery");
	});
});
