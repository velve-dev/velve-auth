import { describe, expect, it } from "vitest";
import { derivePurposeKeyBytes } from "../src/core/keys/hkdf.js";
import { KEY_PURPOSES, randomBytes } from "../src/core/keys/index.js";

describe("derivePurposeKeyBytes", () => {
	it("derives 32 bytes for every purpose", async () => {
		const rootKey = randomBytes(32);

		for (const purpose of KEY_PURPOSES) {
			expect(await derivePurposeKeyBytes(rootKey, purpose)).toHaveLength(32);
		}
	});

	it("is deterministic for the same root key and purpose", async () => {
		const rootKey = randomBytes(32);
		const first = await derivePurposeKeyBytes(rootKey, "password-enc");
		const second = await derivePurposeKeyBytes(rootKey, "password-enc");
		expect(first).toStrictEqual(second);
	});

	it("gives every purpose its own key (S-KEY-1)", async () => {
		const rootKey = randomBytes(32);
		const derived = await Promise.all(
			KEY_PURPOSES.map((purpose) => derivePurposeKeyBytes(rootKey, purpose)),
		);

		expect(new Set(derived.map((keyBytes) => keyBytes.join(","))).size).toBe(KEY_PURPOSES.length);
	});

	it("gives every root key its own set of purpose keys", async () => {
		const first = await derivePurposeKeyBytes(randomBytes(32), "cookie-sig");
		const second = await derivePurposeKeyBytes(randomBytes(32), "cookie-sig");
		expect(first).not.toStrictEqual(second);
	});

	it("covers exactly the six purposes of section 3.8", () => {
		expect([...KEY_PURPOSES]).toStrictEqual([
			"cookie-sig",
			"token-pepper",
			"totp-enc",
			"oauth-token-enc",
			"pkce-enc",
			"password-enc",
		]);
	});
});
