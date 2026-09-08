import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { decodeBase64Url } from "../src/core/keys/base64url.js";
import { randomBytes } from "../src/core/token/index.js";
import { encodeBase64Url } from "./keys-fixtures.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

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

	it("rejects trailing bits that no byte carries", () => {
		expect(decodeBase64Url("QQ")).toStrictEqual(new Uint8Array([0x41]));
		expect(decodeBase64Url("QR")).toBeNull();
	});

	// A 32-byte key ends in a character that carries four bytes' bits and two bits belonging to no
	// byte. Only the sixteen characters whose last two bits are zero spell such a key.
	it("accepts only the spellings of a 32-byte key whose trailing bits are zero", () => {
		const canonical = encodeBase64Url(randomBytes(32));
		let rejected = 0;

		for (let value = 0; value < 64; value += 1) {
			const spelling = canonical.slice(0, -1) + ALPHABET[value];

			if ((value & 0b11) === 0) {
				expect(decodeBase64Url(spelling)).not.toBeNull();
			} else {
				expect(decodeBase64Url(spelling)).toBeNull();
				rejected += 1;
			}
		}

		expect(rejected).toBe(48);
	});

	it("rejects padding that is not one or two characters at the end", () => {
		const canonical = encodeBase64Url(randomBytes(32));
		expect(decodeBase64Url(`${canonical}===`)).toBeNull();
		expect(decodeBase64Url(`${canonical.slice(0, -1)}=A`)).toBeNull();
	});
});
