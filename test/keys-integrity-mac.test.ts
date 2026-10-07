import { describe, expect, it } from "vitest";
import { rootKeyProvider } from "../src/core/keys/index.js";
import { MAXIMUM_KEY_VERSION } from "../src/core/keys/key-version.js";
import { macUnderCurrentKey, verifyMacUnderKeyVersion } from "../src/core/keys/mac.js";
import { generateRootKey, withLastBitFlipped } from "./keys-fixtures.js";

const utf8 = new TextEncoder();
const MESSAGE = utf8.encode("a row the database must not be able to forge");
const OTHER_MESSAGE = utf8.encode("a row the database must not be able to forgf");

const firstRootKey = generateRootKey();
const secondRootKey = generateRootKey();
const beforeRotation = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: firstRootKey } });
const duringRotation = rootKeyProvider({
	currentVersion: 2,
	keysByVersion: { 1: firstRootKey, 2: secondRootKey },
});
const afterRotation = rootKeyProvider({ currentVersion: 2, keysByVersion: { 2: secondRootKey } });

describe("a MAC under the state-mac purpose (S-KEY-1)", () => {
	it("is 32 bytes taken under the current version", async () => {
		const taken = await macUnderCurrentKey(duringRotation, "state-mac", MESSAGE);

		expect(taken.keyVersion).toBe(2);
		expect(taken.mac).toHaveLength(32);
	});

	it("verifies the message it was taken over", async () => {
		const taken = await macUnderCurrentKey(beforeRotation, "state-mac", MESSAGE);

		expect(await verifyMacUnderKeyVersion(beforeRotation, "state-mac", taken, MESSAGE)).toBe(
			"valid",
		);
	});

	it("reports a mismatch for a changed message and for a changed MAC", async () => {
		const taken = await macUnderCurrentKey(beforeRotation, "state-mac", MESSAGE);
		const tampered = { ...taken, mac: withLastBitFlipped(taken.mac) };

		expect(await verifyMacUnderKeyVersion(beforeRotation, "state-mac", taken, OTHER_MESSAGE)).toBe(
			"mismatch",
		);
		expect(await verifyMacUnderKeyVersion(beforeRotation, "state-mac", tampered, MESSAGE)).toBe(
			"mismatch",
		);
	});

	it("reports a mismatch for a MAC of another length rather than throwing", async () => {
		const taken = await macUnderCurrentKey(beforeRotation, "state-mac", MESSAGE);
		const shortened = { ...taken, mac: taken.mac.slice(0, 31) };

		expect(await verifyMacUnderKeyVersion(beforeRotation, "state-mac", shortened, MESSAGE)).toBe(
			"mismatch",
		);
	});

	it("reports a mismatch for a MAC taken under another root key with the same version", async () => {
		const elsewhere = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: secondRootKey } });
		const taken = await macUnderCurrentKey(elsewhere, "state-mac", MESSAGE);

		expect(await verifyMacUnderKeyVersion(beforeRotation, "state-mac", taken, MESSAGE)).toBe(
			"mismatch",
		);
	});

	it("still verifies a MAC of the old version while that version is in the ring", async () => {
		const taken = await macUnderCurrentKey(beforeRotation, "state-mac", MESSAGE);

		expect(await verifyMacUnderKeyVersion(duringRotation, "state-mac", taken, MESSAGE)).toBe(
			"valid",
		);
	});

	it("tells a version that left the ring apart from a mismatch", async () => {
		const taken = await macUnderCurrentKey(beforeRotation, "state-mac", MESSAGE);

		expect(await verifyMacUnderKeyVersion(afterRotation, "state-mac", taken, MESSAGE)).toBe(
			"key_version_unknown",
		);
	});

	it.each([0, -1, 1.5, MAXIMUM_KEY_VERSION + 1, Number.NaN])(
		"answers an unstorable version %s as unknown without asking the provider",
		async (keyVersion) => {
			const taken = await macUnderCurrentKey(beforeRotation, "state-mac", MESSAGE);

			expect(
				await verifyMacUnderKeyVersion(
					beforeRotation,
					"state-mac",
					{ ...taken, keyVersion },
					MESSAGE,
				),
			).toBe("key_version_unknown");
		},
	);

	it("does not verify under the cookie-sig key, which signs with the same algorithm (S-KEY-2)", async () => {
		const taken = await macUnderCurrentKey(beforeRotation, "state-mac", MESSAGE);
		const { key } = await beforeRotation.current("cookie-sig");
		const underCookieKey = new Uint8Array(await crypto.subtle.sign("HMAC", key, MESSAGE));

		expect(underCookieKey).not.toStrictEqual(taken.mac);
	});
});

describe("the two integrity purposes against each other (S-KEY-2)", () => {
	it("does not verify a state-mac MAC under token-mac, nor the reverse", async () => {
		const underState = await macUnderCurrentKey(beforeRotation, "state-mac", MESSAGE);
		const underToken = await macUnderCurrentKey(beforeRotation, "token-mac", MESSAGE);

		expect(underState.mac).not.toStrictEqual(underToken.mac);
		expect(await verifyMacUnderKeyVersion(beforeRotation, "token-mac", underState, MESSAGE)).toBe(
			"mismatch",
		);
		expect(await verifyMacUnderKeyVersion(beforeRotation, "state-mac", underToken, MESSAGE)).toBe(
			"mismatch",
		);
	});

	it("does not take a token-mac MAC under the token-pepper key", async () => {
		const underToken = await macUnderCurrentKey(beforeRotation, "token-mac", MESSAGE);
		const { key } = await beforeRotation.current("token-pepper");
		const underPepper = new Uint8Array(await crypto.subtle.sign("HMAC", key, MESSAGE));

		expect(underPepper).not.toStrictEqual(underToken.mac);
	});
});
