import { describe, expect, it } from "vitest";
import {
	KeyError,
	type KeyErrorCode,
	type KeyProvider,
	type RootKeyProviderInput,
	rootKeyProvider,
} from "../src/core/keys/index.js";
import { MAXIMUM_KEY_VERSION } from "../src/core/keys/key-version.js";
import { randomBytes } from "../src/core/token/random.js";
import { encodeBase64Url, generateRootKey } from "./keys-fixtures.js";

function expectRejectedInput(input: RootKeyProviderInput, code: KeyErrorCode): void {
	try {
		rootKeyProvider(input);
	} catch (error) {
		expect(error).toBeInstanceOf(KeyError);
		expect((error as KeyError).code).toBe(code);
		return;
	}

	expect.fail("rootKeyProvider accepted a configuration it must reject");
}

describe("rootKeyProvider construction (S-KEY-6)", () => {
	it("refuses an empty key ring", () => {
		expectRejectedInput({ currentVersion: 1, keysByVersion: {} }, "root_key_missing");
	});

	it("refuses a ring without the current version", () => {
		expectRejectedInput(
			{ currentVersion: 2, keysByVersion: { 1: generateRootKey() } },
			"root_key_missing",
		);
	});

	it("refuses a root key shorter than 32 bytes", () => {
		expectRejectedInput(
			{ currentVersion: 1, keysByVersion: { 1: encodeBase64Url(randomBytes(31)) } },
			"root_key_too_short",
		);
	});

	it("refuses a root key that is not base64url", () => {
		expectRejectedInput(
			{ currentVersion: 1, keysByVersion: { 1: "not base64url at all!!" } },
			"root_key_malformed",
		);
	});

	it("refuses a version outside the range of a PostgreSQL integer", () => {
		expectRejectedInput(
			{ currentVersion: 0, keysByVersion: { 0: generateRootKey() } },
			"key_version_out_of_range",
		);
		expectRejectedInput(
			{
				currentVersion: MAXIMUM_KEY_VERSION + 1,
				keysByVersion: { [MAXIMUM_KEY_VERSION + 1]: generateRootKey() },
			},
			"key_version_out_of_range",
		);
	});

	it("refuses a version spelled as anything but a decimal integer", () => {
		for (const version of ["0x10", "1e2", " 1", "1.0", "+1", ""]) {
			expectRejectedInput(
				{ currentVersion: 1, keysByVersion: { [version]: generateRootKey() } },
				"key_version_out_of_range",
			);
		}
	});

	it("accepts a root key longer than 32 bytes", () => {
		expect(() =>
			rootKeyProvider({
				currentVersion: 1,
				keysByVersion: { 1: encodeBase64Url(randomBytes(64)) },
			}),
		).not.toThrow();
	});
});

describe("rootKeyProvider ring (S-KEY-4)", () => {
	const rootKeys = { 1: generateRootKey(), 4: generateRootKey() };
	const keys: KeyProvider = rootKeyProvider({ currentVersion: 4, keysByVersion: rootKeys });

	it("writes with exactly one version", async () => {
		expect((await keys.current("password-enc")).version).toBe(4);
	});

	it("resolves every version of the ring for reading", async () => {
		expect(await keys.byVersion("password-enc", 1)).not.toBeNull();
		expect(await keys.byVersion("password-enc", 4)).not.toBeNull();
	});

	it("resolves a version outside the ring to null rather than throwing", async () => {
		expect(await keys.byVersion("password-enc", 2)).toBeNull();
		expect(await keys.byVersion("password-enc", MAXIMUM_KEY_VERSION)).toBeNull();
	});

	it("returns the same key object for repeated requests", async () => {
		const first = await keys.byVersion("totp-enc", 1);
		const second = await keys.byVersion("totp-enc", 1);
		expect(first).toBe(second);
	});

	it("hands the current version the same key as byVersion (S-KEY-5)", async () => {
		const { version, key } = await keys.current("cookie-sig");
		expect(await keys.byVersion("cookie-sig", version)).toBe(key);
	});
});

describe("rootKeyProvider purpose separation (S-KEY-2)", () => {
	const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });

	it("imports signing purposes as HMAC keys that cannot decrypt", async () => {
		for (const purpose of ["cookie-sig", "token-pepper"] as const) {
			const { key } = await keys.current(purpose);
			expect(key.algorithm.name).toBe("HMAC");
			expect([...key.usages].sort()).toStrictEqual(["sign", "verify"]);
		}
	});

	it("imports encryption purposes as AES-GCM keys that cannot sign", async () => {
		for (const purpose of ["totp-enc", "oauth-token-enc", "pkce-enc", "password-enc"] as const) {
			const { key } = await keys.current(purpose);
			expect(key.algorithm.name).toBe("AES-GCM");
			expect([...key.usages].sort()).toStrictEqual(["decrypt", "encrypt"]);
		}
	});

	it("gives each purpose a distinct key object", async () => {
		const totp = await keys.current("totp-enc");
		const pkce = await keys.current("pkce-enc");
		expect(totp.key).not.toBe(pkce.key);
	});
});

describe("KeyError", () => {
	it("carries a machine-readable code and no key material", () => {
		const error = new KeyError("root_key_too_short");
		expect(error).toBeInstanceOf(Error);
		expect(error.code).toBe("root_key_too_short");
		expect(error.name).toBe("KeyError");
	});
});
