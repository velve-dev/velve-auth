import { describe, expect, it } from "vitest";
import { derivePurposeKeyBytes } from "../src/core/keys/hkdf.js";
import { KEY_PURPOSES, type KeyPurpose } from "../src/core/keys/index.js";

// T-KEY-1 fixes the threshold as "HKDF matches all 7 test vectors of RFC 5869 Appendix A".
// The library derives through `crypto.subtle`, so the vectors are checked against an HKDF
// assembled here from HMAC alone; the same construction then reproduces `derivePurposeKeyBytes`.

const utf8 = new TextEncoder();

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(hex.length / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ascendingBytes(from: number, count: number): Uint8Array<ArrayBuffer> {
	return Uint8Array.from({ length: count }, (_unused, index) => from + index);
}

function repeatedByte(byte: number, count: number): Uint8Array<ArrayBuffer> {
	return new Uint8Array(count).fill(byte);
}

async function hmac(
	hash: "SHA-256" | "SHA-1",
	key: Uint8Array<ArrayBuffer>,
	message: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
	const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash }, false, [
		"sign",
	]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", imported, message));
}

async function hkdf(
	hash: "SHA-256" | "SHA-1",
	inputKeyMaterial: Uint8Array<ArrayBuffer>,
	salt: Uint8Array<ArrayBuffer> | null,
	info: Uint8Array<ArrayBuffer>,
	outputLength: number,
): Promise<Uint8Array<ArrayBuffer>> {
	const hashLength = hash === "SHA-256" ? 32 : 20;
	// RFC 5869 section 2.2: an absent salt is a string of HashLen zeros, and HMAC pads a shorter
	// key with zeros, so a zero-length salt is the same value. Web Crypto refuses to import the
	// empty key, so the substitution happens here.
	const effectiveSalt = salt === null || salt.length === 0 ? new Uint8Array(hashLength) : salt;
	const pseudoRandomKey = await hmac(hash, effectiveSalt, inputKeyMaterial);

	const output = new Uint8Array(outputLength);
	let previousBlock = new Uint8Array(0);
	let written = 0;

	for (let counter = 1; written < outputLength; counter += 1) {
		const input = new Uint8Array(previousBlock.length + info.length + 1);
		input.set(previousBlock);
		input.set(info, previousBlock.length);
		input[input.length - 1] = counter;

		previousBlock = await hmac(hash, pseudoRandomKey, input);
		output.set(previousBlock.subarray(0, outputLength - written), written);
		written += previousBlock.length;
	}

	return output;
}

interface Rfc5869Vector {
	name: string;
	hash: "SHA-256" | "SHA-1";
	inputKeyMaterial: Uint8Array<ArrayBuffer>;
	salt: Uint8Array<ArrayBuffer> | null;
	info: Uint8Array<ArrayBuffer>;
	outputLength: number;
	outputKeyMaterial: string;
}

const RFC_5869_VECTORS: readonly Rfc5869Vector[] = [
	{
		name: "A.1 basic, SHA-256",
		hash: "SHA-256",
		inputKeyMaterial: repeatedByte(0x0b, 22),
		salt: fromHex("000102030405060708090a0b0c"),
		info: fromHex("f0f1f2f3f4f5f6f7f8f9"),
		outputLength: 42,
		outputKeyMaterial:
			"3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
	},
	{
		name: "A.2 longer inputs, SHA-256",
		hash: "SHA-256",
		inputKeyMaterial: ascendingBytes(0x00, 80),
		salt: ascendingBytes(0x60, 80),
		info: ascendingBytes(0xb0, 80),
		outputLength: 82,
		outputKeyMaterial:
			"b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87",
	},
	{
		name: "A.3 zero-length salt and info, SHA-256",
		hash: "SHA-256",
		inputKeyMaterial: repeatedByte(0x0b, 22),
		salt: new Uint8Array(0),
		info: new Uint8Array(0),
		outputLength: 42,
		outputKeyMaterial:
			"8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
	},
	{
		name: "A.4 basic, SHA-1",
		hash: "SHA-1",
		inputKeyMaterial: repeatedByte(0x0b, 11),
		salt: fromHex("000102030405060708090a0b0c"),
		info: fromHex("f0f1f2f3f4f5f6f7f8f9"),
		outputLength: 42,
		outputKeyMaterial:
			"085a01ea1b10f36933068b56efa5ad81a4f14b822f5b091568a9cdd4f155fda2c22e422478d305f3f896",
	},
	{
		name: "A.5 longer inputs, SHA-1",
		hash: "SHA-1",
		inputKeyMaterial: ascendingBytes(0x00, 80),
		salt: ascendingBytes(0x60, 80),
		info: ascendingBytes(0xb0, 80),
		outputLength: 82,
		outputKeyMaterial:
			"0bd770a74d1160f7c9f12cd5912a06ebff6adcae899d92191fe4305673ba2ffe8fa3f1a4e5ad79f3f334b3b202b2173c486ea37ce3d397ed034c7f9dfeb15c5e927336d0441f4c4300e2cff0d0900b52d3b4",
	},
	{
		name: "A.6 zero-length salt and info, SHA-1",
		hash: "SHA-1",
		inputKeyMaterial: repeatedByte(0x0b, 22),
		salt: new Uint8Array(0),
		info: new Uint8Array(0),
		outputLength: 42,
		outputKeyMaterial:
			"0ac1af7002b3d761d1e55298da9d0506b9ae52057220a306e07b6b87e8df21d0ea00033de03984d34918",
	},
	{
		name: "A.7 salt not provided, SHA-1",
		hash: "SHA-1",
		inputKeyMaterial: repeatedByte(0x0c, 22),
		salt: null,
		info: new Uint8Array(0),
		outputLength: 42,
		outputKeyMaterial:
			"2c91117204d745f3500d636a62f64f0ab3bae548aa53d423b0d1f27ebba6f5e5673a081d70cce7acfc48",
	},
];

describe("HKDF against RFC 5869 Appendix A (T-KEY-1)", () => {
	it.each(RFC_5869_VECTORS)("reproduces $name", async (vector) => {
		const derived = await hkdf(
			vector.hash,
			vector.inputKeyMaterial,
			vector.salt,
			vector.info,
			vector.outputLength,
		);

		expect(toHex(derived)).toBe(vector.outputKeyMaterial);
	});

	it("covers all seven vectors of the appendix", () => {
		expect(RFC_5869_VECTORS).toHaveLength(7);
	});
});

// The reference above is validated by the seven vectors, so it can now stand in judgement over
// the library's own derivation.
describe("derivePurposeKeyBytes is HKDF-SHA256 with one context per purpose (S-KEY-1)", () => {
	const HKDF_SALT = utf8.encode("velve-auth/hkdf-sha256/v1");
	const rootKey = repeatedByte(0x5a, 32);

	it.each([...KEY_PURPOSES])("derives %s exactly as HKDF-SHA256 does", async (purpose) => {
		const expected = await hkdf(
			"SHA-256",
			rootKey,
			HKDF_SALT,
			utf8.encode(`velve-auth/key/${purpose}`),
			32,
		);

		expect(await derivePurposeKeyBytes(rootKey, purpose)).toStrictEqual(expected);
	});

	it("gives the six purposes six different keys", async () => {
		const derived = await Promise.all(
			KEY_PURPOSES.map((purpose) => derivePurposeKeyBytes(rootKey, purpose)),
		);

		expect(new Set(derived.map(toHex)).size).toBe(6);
	});

	it("shares no derived key between two different root keys", async () => {
		const other = repeatedByte(0x5b, 32);
		const fromFirst = await Promise.all(
			KEY_PURPOSES.map((purpose) => derivePurposeKeyBytes(rootKey, purpose)),
		);
		const fromSecond = await Promise.all(
			KEY_PURPOSES.map((purpose) => derivePurposeKeyBytes(other, purpose)),
		);

		expect(new Set([...fromFirst, ...fromSecond].map(toHex)).size).toBe(12);
	});

	it("returns the same bytes on repeated calls", async () => {
		const purpose: KeyPurpose = "password-enc";
		const draws = await Promise.all(
			Array.from({ length: 8 }, () => derivePurposeKeyBytes(rootKey, purpose)),
		);

		expect(new Set(draws.map(toHex)).size).toBe(1);
	});
});
