import { describe, expect, it, vi } from "vitest";

//a stored mac is compared only in constant time and only under a version a column holds (E-3311)

const compared = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../src/core/keys/constant-time.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/keys/constant-time.js")>();
	return {
		...original,
		equalsInConstantTime: (...args: Parameters<typeof original.equalsInConstantTime>) => {
			compared.calls += 1;
			return original.equalsInConstantTime(...args);
		},
	};
});

import { MAXIMUM_KEY_VERSION } from "../src/core/keys/key-version.js";
import { macUnderCurrentKey, verifyMacUnderKeyVersion } from "../src/core/keys/mac.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { rootKeyProvider } from "../src/core/keys/root-key-provider.js";
import { generateRootKey } from "./keys-fixtures.js";

const genuine = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
const MESSAGE = new TextEncoder().encode("a row the database must not forge");

function providerWithCurrentVersion(version: number): KeyProvider {
	return {
		current: async (purpose) => ({ version, key: (await genuine.current(purpose)).key }),
		byVersion: (purpose, asked) => genuine.byVersion(purpose, asked),
	};
}

describe("the comparison of a stored MAC (section 3.18 point 4, Checking)", () => {
	it("goes through equalsInConstantTime and through nothing else", async () => {
		const taken = await macUnderCurrentKey(genuine, "state-mac", MESSAGE);
		compared.calls = 0;

		await verifyMacUnderKeyVersion(genuine, "state-mac", taken, MESSAGE);

		expect(compared.calls).toBe(1);
	});
});

describe("the current key version a MAC is stored under (S-KEY-3)", () => {
	it.each([0, -1, 1.5, Number.NaN, MAXIMUM_KEY_VERSION + 1])(
		"refuses to take a MAC under a provider whose current version is %s",
		async (version) => {
			await expect(
				macUnderCurrentKey(providerWithCurrentVersion(version), "state-mac", MESSAGE),
			).rejects.toMatchObject({ name: "KeyError", code: "key_version_out_of_range" });
		},
	);
});

describe("a stored key version no integer column holds", () => {
	it.each([0, 1.5, Number.NaN, MAXIMUM_KEY_VERSION + 1])(
		"is answered as unknown without asking the provider for %s",
		async (keyVersion) => {
			const taken = await macUnderCurrentKey(genuine, "state-mac", MESSAGE);
			const asked: number[] = [];
			const provider: KeyProvider = {
				current: (purpose) => genuine.current(purpose),
				byVersion: async (purpose, version) => {
					asked.push(version);
					return genuine.byVersion(purpose, version);
				},
			};

			const verdict = await verifyMacUnderKeyVersion(
				provider,
				"state-mac",
				{ ...taken, keyVersion },
				MESSAGE,
			);

			expect({ verdict, asked }).toStrictEqual({ verdict: "key_version_unknown", asked: [] });
		},
	);
});
