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
	query: async <T>() => [{ key_version: 1 }] as T[],
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

//an older version of another purpose shares a key as dangerously as its current one (E-3375)
describe("the stored-version probe against older versions of the other purposes", () => {
	async function refusalWhenStateMacOneIs(
		other: "token-mac" | "token-pepper",
		otherVersion: "current" | 1,
	): Promise<Error | undefined> {
		const otherKey =
			otherVersion === "current"
				? (await genuine.current(other)).key
				: await genuine.byVersion(other, otherVersion);
		const keys: KeyProvider = {
			current: (purpose) => genuine.current(purpose),
			byVersion: async (purpose, version) =>
				purpose === "state-mac" && version === 1 ? otherKey : genuine.byVersion(purpose, version),
		};
		return assertStoredIntegrityKeysTakeMac({
			driver: storedVersionOne,
			keys,
			schema: "velve",
		}).then(
			() => undefined,
			(error: unknown) => error as Error,
		);
	}

	it("refuses a stored state-mac version answered with the older token-mac key as one key shared by two purposes", async () => {
		expect(await refusalWhenStateMacOneIs("token-mac", 1)).toMatchObject({
			code: "keys_unusable",
		});
	});

	it("names the stored version and the other key in the refusal", async () => {
		expect((await refusalWhenStateMacOneIs("token-mac", 1))?.message).toContain(
			"state-mac version 1, which a stored seal names, with the token-mac key of version 1",
		);
		const current = (await refusalWhenStateMacOneIs("token-pepper", "current"))?.message ?? "";
		expect(current).toContain("state-mac version 1");
		expect(current).toContain("the current token-pepper key");
	});
});
