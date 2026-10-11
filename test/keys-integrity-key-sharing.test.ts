import { describe, expect, it } from "vitest";
import { assertKeysAnswerForEveryPurpose } from "../src/core/auth/startup.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { rootKeyProvider } from "../src/core/keys/root-key-provider.js";
import { generateRootKey } from "./keys-fixtures.js";

//the start refuses one hmac key answering any two hmac purposes (E-3330)

const genuine = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });

type HmacPurpose = "cookie-sig" | "token-pepper" | "state-mac" | "token-mac";

function providerAnswering(purpose: HmacPurpose, withTheKeyOf: HmacPurpose): KeyProvider {
	return {
		async current(asked) {
			return asked === purpose ? genuine.current(withTheKeyOf) : genuine.current(asked);
		},
		async byVersion(asked, version) {
			return genuine.byVersion(asked === purpose ? withTheKeyOf : asked, version);
		},
	};
}

describe("one HMAC key answering two purposes, every pair", () => {
	it.each([
		["token-pepper", "cookie-sig"],
		["state-mac", "token-pepper"],
		["token-mac", "token-pepper"],
		["token-mac", "cookie-sig"],
	] as const)("refuses %s answered with the key of %s", async (purpose, other) => {
		await expect(
			assertKeysAnswerForEveryPurpose(providerAnswering(purpose, other)),
		).rejects.toMatchObject({ code: "keys_unusable" });
	});
});
