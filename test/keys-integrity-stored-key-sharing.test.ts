import { describe, expect, it } from "vitest";
import { assertStoredIntegrityKeysTakeMac } from "../src/core/auth/integrity-key-ring.js";
import type { Driver } from "../src/core/db/driver.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { rootKeyProvider } from "../src/core/keys/root-key-provider.js";
import { generateRootKey } from "./keys-fixtures.js";

//a stored state-mac version answered with the current key of any other hmac purpose is refused (E-3329)

const genuine = rootKeyProvider({
	currentVersion: 2,
	keysByVersion: { 1: generateRootKey(), 2: generateRootKey() },
});
const storedVersionOne: Driver = {
	query: async <T>() => [{ purpose: "state-mac", key_version: 1 }] as T[],
	transaction: () => Promise.reject(new Error("not used")),
};

describe("the stored-version probe against the non-integrity HMAC purposes", () => {
	it.each(["cookie-sig", "token-pepper"] as const)(
		"refuses a stored state-mac version answered with the current %s key",
		async (other) => {
			const otherKey = (await genuine.current(other)).key;
			const keys: KeyProvider = {
				current: (purpose) => genuine.current(purpose),
				byVersion: async (purpose, version) =>
					purpose === "state-mac" && version === 1 ? otherKey : genuine.byVersion(purpose, version),
			};

			await expect(
				assertStoredIntegrityKeysTakeMac({ driver: storedVersionOne, keys, schema: "velve" }),
			).rejects.toMatchObject({ code: "keys_unusable" });
		},
	);
});
