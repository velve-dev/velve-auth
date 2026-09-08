import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { decodeBase64Url, encodeBase64Url } from "../src/core/keys/base64url.js";
import {
	createSecretToken,
	hashSecretToken,
	randomBytes,
	toSecretToken,
} from "../src/core/token/index.js";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("encodeBase64Url", () => {
	it("agrees with the platform encoder for every length up to 64", () => {
		for (let length = 0; length <= 64; length += 1) {
			const bytes = randomBytes(length);
			expect(encodeBase64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
		}
	});

	it("round-trips through the decoder beside it", () => {
		for (let length = 0; length <= 64; length += 1) {
			const bytes = randomBytes(length);
			expect(decodeBase64Url(encodeBase64Url(bytes))).toStrictEqual(bytes);
		}
	});

	it("writes no padding", () => {
		expect(encodeBase64Url(randomBytes(31))).not.toContain("=");
		expect(encodeBase64Url(randomBytes(32))).not.toContain("=");
	});
});

// T-RAND-4 fixes the sample at 1000 values and the threshold at 256 bit each.
describe("createSecretToken (S-RAND-4)", () => {
	const sample = Array.from({ length: 1000 }, () => createSecretToken());

	it("carries 256 bit in 43 base64url characters", () => {
		for (const token of sample) {
			expect(token).toMatch(BASE64URL);
			expect(token).toHaveLength(43);
			expect(decodeBase64Url(token)).toHaveLength(32);
		}
	});

	it("repeats no value", () => {
		expect(new Set(sample).size).toBe(1000);
	});

	it("uses every character of the alphabet across the sample", () => {
		const seen = new Set(sample.join(""));
		expect(seen.size).toBe(64);
	});
});

describe("hashSecretToken", () => {
	it("is SHA-256 over the token's UTF-8 bytes", () => {
		expect(Buffer.from(hashSecretToken(toSecretToken("abc"))).toString("hex")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("is 32 bytes wide and stable for the same token", () => {
		const token = createSecretToken();
		expect(hashSecretToken(token)).toHaveLength(32);
		expect(hashSecretToken(token)).toStrictEqual(hashSecretToken(token));
	});

	it("differs for tokens that differ in one character", () => {
		expect(hashSecretToken(toSecretToken("a"))).not.toStrictEqual(
			hashSecretToken(toSecretToken("b")),
		);
	});
});
