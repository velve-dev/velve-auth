import { describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import {
	createWebAuthnChallenges,
	WEBAUTHN_CHALLENGE_PURPOSES,
	type WebAuthnChallengePurpose,
	type WebAuthnChallengeRepositoryOptions,
} from "../src/core/factor/webauthn/challenge.js";
import {
	DEFAULT_REGISTRATION_USER_VERIFICATION,
	InvalidWebAuthnConfigError,
	type WebAuthnConfigErrorCode,
	webAuthnSettingsOf,
} from "../src/core/factor/webauthn/config.js";

const A_CONFIGURATION = {
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
	}
	throw new Error("the configuration was accepted");
}

describe("the webauthn configuration", () => {
	it("demands user verification unless the application asks for less", () => {
		expect(webAuthnSettingsOf(A_CONFIGURATION).registrationUserVerification).toBe(
			DEFAULT_REGISTRATION_USER_VERIFICATION,
		);
		expect(DEFAULT_REGISTRATION_USER_VERIFICATION).toBe("required");
	});

	it("keeps the relying party, the name and every origin as given", () => {
		const settings = webAuthnSettingsOf({
			...A_CONFIGURATION,
			origins: ["https://example.com", "android:apk-key-hash:c2lnbmVy"],
			userVerification: "preferred",
		});

		expect(settings.relyingPartyId).toBe("example.com");
		expect(settings.origins).toEqual(["https://example.com", "android:apk-key-hash:c2lnbmVy"]);
		expect(settings.registrationUserVerification).toBe("preferred");
	});

	/** A trailing slash never equals the origin a browser sends, so it would refuse every
	 * ceremony at the one moment nobody is watching the configuration. */
	it("refuses a web origin that carries more than an origin", () => {
		expect(refusalOf({ ...A_CONFIGURATION, origins: ["https://example.com/"] })).toBe(
			"origin_carries_more_than_an_origin",
		);
		expect(refusalOf({ ...A_CONFIGURATION, origins: ["https://example.com/app"] })).toBe(
			"origin_carries_more_than_an_origin",
		);
	});

	it.each([
		[{ ...A_CONFIGURATION, relyingPartyId: "" }, "relying_party_id_empty"],
		[
			{ ...A_CONFIGURATION, relyingPartyId: "https://example.com" },
			"relying_party_id_is_not_a_hostname",
		],
		[
			{ ...A_CONFIGURATION, relyingPartyId: "example.com:443" },
			"relying_party_id_is_not_a_hostname",
		],
		[{ ...A_CONFIGURATION, relyingPartyName: "" }, "relying_party_name_empty"],
		[{ ...A_CONFIGURATION, origins: [] }, "origins_empty"],
		[{ ...A_CONFIGURATION, origins: [""] }, "origin_empty"],
	])("refuses a configuration it cannot run on: %o", (configuration, code) => {
		expect(refusalOf(configuration)).toBe(code);
	});
});

describe("the challenge purposes", () => {
	/** The two purposes are the two ceremonies, and S-REPLAY-5 binds a challenge to the one it
	 * was created under. A third would be a third ceremony. */
	it("names the two ceremonies and no more", () => {
		const purposes: readonly WebAuthnChallengePurpose[] = WEBAUTHN_CHALLENGE_PURPOSES;

		expect(purposes).toEqual(["register", "authenticate"]);
	});

	it("builds its statements against the configured schema", () => {
		const statements: string[] = [];
		const driver: Driver = {
			query: async (sql) => {
				statements.push(sql);
				return [];
			},
			transaction: (run) => run(driver),
		};
		const options: WebAuthnChallengeRepositoryOptions = { driver, schema: "tenant_one" };

		void createWebAuthnChallenges(options).consume({
			challengeToken: "x",
			purpose: "register",
			userId: null,
		});

		expect(statements.at(0)).toContain("tenant_one.webauthn_challenge");
	});
});
