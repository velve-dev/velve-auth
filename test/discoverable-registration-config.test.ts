import { describe, expect, it } from "vitest";
import type { VelveAuthConfig, WebAuthnConfig } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import {
	InvalidWebAuthnConfigError,
	type WebAuthnConfigErrorCode,
	webAuthnSettingsOf,
} from "../src/core/factor/webauthn/config.js";
import { resolveErrorCode } from "../src/core/http/error-map.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, createLogSink, TEST_ORIGIN } from "./auth-fixtures.js";

/**
 * S-DEFAULT-8, the configuration half: the switch is off unless set, a caller who sets it gets
 * user verification and nothing weaker, and a value that is no boolean or a contradiction with
 * `userVerification: "preferred"` refuses the start rather than reading as off or overriding.
 */

const A_RELYING_PARTY = {
	relyingPartyId: "example.com",
	relyingPartyName: "Velve Auth test",
	origins: ["https://example.com"],
};

function refusalOf(
	configuration: Parameters<typeof webAuthnSettingsOf>[0],
): WebAuthnConfigErrorCode {
	try {
		webAuthnSettingsOf(configuration);
	} catch (cause) {
		if (cause instanceof InvalidWebAuthnConfigError) {
			return cause.code;
		}
		throw cause;
	}
	throw new Error("the configuration was accepted");
}

//nothing in this file reaches the database, so a driver that is touched fails the case
const UNREACHABLE: Driver = {
	query: () => Promise.reject(new Error("the start reached the database")),
	transaction: () => Promise.reject(new Error("the start reached the database")),
};

function started(
	webauthn: WebAuthnConfig,
	overrides: Partial<VelveAuthConfig<"email">> = {},
): () => unknown {
	return () => createVelveAuth(configFor({ database: UNREACHABLE, webauthn, ...overrides }));
}

describe("the switch that asks every registration for a discoverable credential (S-DEFAULT-8)", () => {
	it("is off unless the application sets it", () => {
		expect(webAuthnSettingsOf(A_RELYING_PARTY).requireDiscoverableCredential).toBe(false);
		expect(
			webAuthnSettingsOf({ ...A_RELYING_PARTY, requireDiscoverableCredential: false })
				.requireDiscoverableCredential,
		).toBe(false);
	});

	it("is on with user verification required, the default and the explicit spelling alike", () => {
		const byDefault = webAuthnSettingsOf({
			...A_RELYING_PARTY,
			requireDiscoverableCredential: true,
		});
		const spelled = webAuthnSettingsOf({
			...A_RELYING_PARTY,
			userVerification: "required",
			requireDiscoverableCredential: true,
		});

		expect([
			byDefault.requireDiscoverableCredential,
			spelled.requireDiscoverableCredential,
		]).toStrictEqual([true, true]);
		expect([
			byDefault.registrationUserVerification,
			spelled.registrationUserVerification,
		]).toStrictEqual(["required", "required"]);
	});

	it("refuses to combine it with user verification that is only preferred", () => {
		expect(
			refusalOf({
				...A_RELYING_PARTY,
				userVerification: "preferred",
				requireDiscoverableCredential: true,
			}),
		).toBe("discoverable_credential_without_user_verification");
	});

	it("keeps a preferred user verification where the switch is off", () => {
		expect(
			webAuthnSettingsOf({
				...A_RELYING_PARTY,
				userVerification: "preferred",
				requireDiscoverableCredential: false,
			}).registrationUserVerification,
		).toBe("preferred");
	});

	it.each(["true", 1, null, {}] as const)(
		"refuses %j rather than reading a value that is no boolean as off",
		(value) => {
			expect(
				refusalOf({
					...A_RELYING_PARTY,
					requireDiscoverableCredential: value as unknown as boolean,
				}),
			).toBe("require_discoverable_credential_not_a_boolean");
		},
	);
});

describe("the start of an instance (S-DEFAULT-8)", () => {
	const webauthn: WebAuthnConfig = {
		relyingPartyId: "app.example.com",
		relyingPartyName: "Velve Auth tests",
		origins: [TEST_ORIGIN],
		userVerification: "required",
	};

	it("starts with the switch on and user verification required", () => {
		expect(started({ ...webauthn, requireDiscoverableCredential: true })).not.toThrow();
	});

	it("refuses to start with the switch on and user verification preferred", () => {
		expect(
			started({ ...webauthn, userVerification: "preferred", requireDiscoverableCredential: true }),
		).toThrow(InvalidWebAuthnConfigError);
	});

	it("refuses to start with a switch that is no boolean", () => {
		expect(
			started({ ...webauthn, requireDiscoverableCredential: "yes" as unknown as boolean }),
		).toThrow(InvalidWebAuthnConfigError);
	});

	it("reports turning the switch on as no weakening, and the preferred setting still as one", () => {
		const quiet = createLogSink();
		started({ ...webauthn, requireDiscoverableCredential: true }, { log: quiet.write })();
		const loud = createLogSink();
		started({ ...webauthn, userVerification: "preferred" }, { log: loud.write })();
		const weakened = (lines: typeof quiet.lines) =>
			lines
				.filter((line) => line.message === "a security option is weaker than its default")
				.map((line) => line.fields.option);

		expect(weakened(quiet.lines)).toStrictEqual([]);
		expect(weakened(loud.lines)).toStrictEqual(["webauthn"]);
	});
});

describe("the code a refused registration in a session answers with (3.15 F)", () => {
	it("is one stable code with status 400", () => {
		expect(resolveErrorCode("webauthn_credential_not_discoverable")).toStrictEqual({
			httpStatus: 400,
			message: "The authenticator did not report a discoverable credential.",
		});
	});
});
