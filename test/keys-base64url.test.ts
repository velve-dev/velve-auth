import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { decodeBase64Url } from "../src/core/keys/base64url.js";
import { randomBytes } from "../src/core/keys/index.js";
import { encodeBase64Url } from "./keys-fixtures.js";

describe("decodeBase64Url", () => {
	it("round-trips byte sequences of every length up to 64", () => {
		for (let length = 0; length <= 64; length += 1) {
			const bytes = randomBytes(length);
			expect(decodeBase64Url(encodeBase64Url(bytes))).toStrictEqual(bytes);
		}
	});

	it("accepts the padded spelling of the same value", () => {
		const bytes = randomBytes(32);
		const padded = Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_");
		expect(decodeBase64Url(padded)).toStrictEqual(bytes);
	});

	it("rejects characters outside the base64url alphabet", () => {
		expect(decodeBase64Url("abc+def")).toBeNull();
		expect(decodeBase64Url("abc/def")).toBeNull();
		expect(decodeBase64Url("abc def")).toBeNull();
	});

	it("rejects a length that cannot come from base64url", () => {
		expect(decodeBase64Url("abcde")).toBeNull();
	});
});
