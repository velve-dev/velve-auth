import { describe, expect, it } from "vitest";
import { decodeStandardBase64, encodeStandardBase64 } from "../src/core/password/base64.js";
import {
	bytesParameter,
	formatPhc,
	integerParameter,
	type PhcString,
	parsePhc,
} from "../src/core/password/phc.js";

const CANONICAL_ARGON2ID =
	"$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$AAcOFRwjKjE4P0ZNVFtiaXB3foWMk5qhqK+2vcTL0tk";
const IMPORTED_SCRYPT = "$scrypt$ln=14,r=16,p=1$c29tZXNhbHQ$c29tZWhhc2g";
const IMPORTED_FBSCRYPT = "$fbscrypt$v=1,n=14,r=8,p=1,ss=Qm9keQ==,sk=c2lnbmVy$c2FsdA==$aGFzaA==";
const IMPORTED_PBKDF2 = "$pbkdf2-sha256$i=600000$c29tZXNhbHQ$c29tZWhhc2g";

function parsed(text: string): PhcString {
	const value = parsePhc(text);
	if (value === null) {
		throw new Error(`expected a parseable PHC string, got a rejection`);
	}
	return value;
}

describe("standard base64", () => {
	it("round-trips every byte value", () => {
		const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
		expect(decodeStandardBase64(encodeStandardBase64(bytes))).toEqual(bytes);
	});

	it("emits no padding", () => {
		expect(encodeStandardBase64(new Uint8Array([1]))).toBe("AQ");
		expect(encodeStandardBase64(new Uint8Array([1, 2]))).toBe("AQI");
	});

	it("accepts the padded spelling an imported value arrives in", () => {
		expect(decodeStandardBase64("AQ==")).toEqual(new Uint8Array([1]));
		expect(decodeStandardBase64("AQI=")).toEqual(new Uint8Array([1, 2]));
	});

	it("rejects the base64url alphabet, misplaced padding and non-canonical trailing bits", () => {
		expect(decodeStandardBase64("a-b_")).toBeNull();
		expect(decodeStandardBase64("A===")).toBeNull();
		expect(decodeStandardBase64("AQ=")).toBeNull();
		expect(decodeStandardBase64("AQ==AQ==")).toBeNull();
		expect(decodeStandardBase64("AR")).toBeNull();
	});
});

describe("PHC parser", () => {
	it("reads the canonical Argon2id string the library creates", () => {
		const value = parsed(CANONICAL_ARGON2ID);

		expect(value.id).toBe("argon2id");
		expect(value.version).toBe(19);
		expect(integerParameter(value, "m")).toBe(19456);
		expect(integerParameter(value, "t")).toBe(2);
		expect(integerParameter(value, "p")).toBe(1);
		expect(value.salt).toHaveLength(16);
		expect(value.hash).toHaveLength(32);
	});

	it("reads a parameter list that carries its own version field", () => {
		const value = parsed(IMPORTED_FBSCRYPT);

		expect(value.id).toBe("fbscrypt");
		expect(value.version).toBeUndefined();
		expect(integerParameter(value, "v")).toBe(1);
		expect(integerParameter(value, "n")).toBe(14);
		expect(integerParameter(value, "r")).toBe(8);
		expect(bytesParameter(value, "ss")).toEqual(new TextEncoder().encode("Body"));
		expect(bytesParameter(value, "sk")).toEqual(new TextEncoder().encode("signer"));
	});

	it("reads the imported scrypt and PBKDF2 strings", () => {
		expect(integerParameter(parsed(IMPORTED_SCRYPT), "ln")).toBe(14);
		expect(integerParameter(parsed(IMPORTED_PBKDF2), "i")).toBe(600000);
		expect(parsed(IMPORTED_PBKDF2).id).toBe("pbkdf2-sha256");
	});

	it("keeps a padded salt out of the parameter list", () => {
		const value = parsed("$scrypt$aac=$aGFzaA");

		expect(value.parameters.size).toBe(0);
		expect(value.salt).toEqual(decodeStandardBase64("aac="));
	});

	it("rejects a string that is not a PHC string", () => {
		for (const text of [
			"",
			"argon2id$v=19",
			"$2b$10$abcdefghijklmnopqrstuv",
			"$ARGON2ID$v=19$m=1$c2FsdA$aGFzaA",
			"$argon2id$v=19$m=1$c2FsdA$aGFzaA$extra",
			"$argon2id$v=19$m=1$$aGFzaA",
			"$argon2id$v=19$m=1$c2Fsd!A$aGFzaA",
			"$argon2id$v=19$m=1,m=2$c2FsdA$aGFzaA",
			"$argon2id$",
		]) {
			expect(parsePhc(text), text).toBeNull();
		}
	});

	it("reports a missing or non-numeric parameter rather than guessing one", () => {
		const value = parsed(CANONICAL_ARGON2ID);

		expect(integerParameter(value, "keylen")).toBeNull();
		expect(bytesParameter(value, "keylen")).toBeNull();
		expect(integerParameter(parsed("$scrypt$ln=x$c2FsdA$aGFzaA"), "ln")).toBeNull();
	});
});

describe("PHC serialiser", () => {
	it("round-trips every canonical string byte for byte", () => {
		for (const text of [CANONICAL_ARGON2ID, IMPORTED_SCRYPT, IMPORTED_PBKDF2]) {
			expect(formatPhc(parsed(text))).toBe(text);
		}
	});

	it("normalises the padding an imported value arrived with", () => {
		expect(formatPhc(parsed(IMPORTED_FBSCRYPT))).toBe(
			"$fbscrypt$v=1,n=14,r=8,p=1,ss=Qm9keQ==,sk=c2lnbmVy$c2FsdA$aGFzaA",
		);
	});

	it("omits a field the value does not carry", () => {
		expect(formatPhc({ id: "argon2id", parameters: new Map() })).toBe("$argon2id");
		expect(formatPhc({ id: "argon2id", version: 19, parameters: new Map([["m", "19456"]]) })).toBe(
			"$argon2id$v=19$m=19456",
		);
	});
});
