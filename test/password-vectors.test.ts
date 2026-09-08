import { argon2dAsync, argon2iAsync, argon2idAsync } from "@noble/hashes/argon2.js";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { encodeStandardBase64 } from "../src/core/password/base64.js";
import { resolvePasswordConfig } from "../src/core/password/config.js";
import { type AcceptedPassword, acceptSubmittedPassword } from "../src/core/password/policy.js";
import { deriveScrypt } from "../src/core/password/verifiers/scrypt.js";
import { verifyAgainstScheme } from "../src/core/password/verify-switch.js";

const DEFAULTS = resolvePasswordConfig();
const utf8 = new TextEncoder();

function bytesOfHex(hex: string): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(hex.length / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

function hexOf(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A vector's password is fixed by the RFC and is often shorter than the policy floor. */
function asPassword(plaintext: string): AcceptedPassword {
	return { text: plaintext, bytes: utf8.encode(plaintext) };
}

function throughPolicy(plaintext: string): AcceptedPassword {
	const value = acceptSubmittedPassword(plaintext, DEFAULTS);
	if (value === null) {
		throw new Error("the length policy refused a vector password");
	}
	return value;
}

describe("Argon2 — RFC 9106", () => {
	const password = new Uint8Array(32).fill(1);
	const salt = new Uint8Array(16).fill(2);
	const secret = new Uint8Array(8).fill(3);
	const associatedData = new Uint8Array(12).fill(4);
	const parameters = { m: 32, t: 3, p: 4, dkLen: 32, version: 0x13 } as const;

	// The reference vectors carry a secret and associated data, which the verification path in 3.3
	// never supplies; they therefore prove the primitive this library derives with, not its wiring.
	it.each([
		["argon2d", argon2dAsync, "512b391b6f1162975371d30919734294f868e3be3984f3c1a13a4db9fabe4acb"],
		["argon2i", argon2iAsync, "c814d9d1dc7f37aa13f0d77f2494bda1c8de6b016dd388d29952a4c4672b6ce8"],
		["argon2id", argon2idAsync, "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659"],
	])(
		"reproduces the %s vector of section 5",
		async (_name, derive, expected) => {
			const tag = await derive(password, salt, {
				...parameters,
				key: secret,
				personalization: associatedData,
			});

			expect(hexOf(tag)).toBe(expected);
		},
		60_000,
	);

	// The published output of the Argon2 reference command line, which the switch has to read as a
	// stored credential rather than as a raw derivation.
	it("verifies the reference implementation's own encoded output", async () => {
		const encoded = "$argon2i$v=19$m=65536,t=2,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG";

		expect(await verifyAgainstScheme("argon2i", throughPolicy("password"), encoded)).toBe(true);
		expect(await verifyAgainstScheme("argon2i", throughPolicy("passworE"), encoded)).toBe(false);
	}, 60_000);
});

describe("scrypt — RFC 7914 section 11", () => {
	it("reproduces the first vector, whose password and salt are both empty", async () => {
		const derived = await deriveScrypt({
			password: new Uint8Array(0),
			salt: new Uint8Array(0),
			costExponent: 4,
			blockSize: 1,
			parallelism: 1,
			hashBytes: 64,
		});

		expect(hexOf(derived)).toBe(
			"77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442" +
				"fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906",
		);
	}, 60_000);

	it.each([
		[
			"password",
			"NaCl",
			10,
			8,
			16,
			"fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162" +
				"2eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640",
		],
		[
			"pleaseletmein",
			"SodiumChloride",
			14,
			8,
			1,
			"7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2" +
				"d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887",
		],
	])(
		"verifies the vector for %s as a stored $scrypt$ credential",
		async (password, salt, costExponent, blockSize, parallelism, expected) => {
			const encoded = [
				"",
				"scrypt",
				`ln=${costExponent},r=${blockSize},p=${parallelism}`,
				encodeStandardBase64(utf8.encode(salt)),
				encodeStandardBase64(bytesOfHex(expected)),
			].join("$");

			expect(await verifyAgainstScheme("scrypt", throughPolicy(password), encoded)).toBe(true);
			expect(await verifyAgainstScheme("scrypt", throughPolicy(`${password}x`), encoded)).toBe(
				false,
			);
		},
		120_000,
	);

	// RFC 7914's fourth vector needs one gibibyte and runs nightly, per architecture 6.22.
	it.skipIf(process.env.VELVE_NIGHTLY !== "1")(
		"reproduces the N = 1048576 vector",
		async () => {
			const derived = await deriveScrypt({
				password: utf8.encode("pleaseletmein"),
				salt: utf8.encode("SodiumChloride"),
				costExponent: 20,
				blockSize: 8,
				parallelism: 1,
				hashBytes: 64,
			});

			expect(hexOf(derived)).toBe(
				"2101cb9b6a511aaeaddbbe09cf70f881ec568d574a2ffd4dabe5ee9820adaa47" +
					"8e56fd8f4ba5d09ffa1c6d927c40f4c337304049e8a952fbcbf45c6fa77a41a4",
			);
		},
		600_000,
	);
});

describe("PBKDF2 — RFC 6070 and its SHA-2 counterparts", () => {
	// RFC 6070 defines only HMAC-SHA1, which the switch of 3.3 does not carry. The vectors run
	// against the fallback implementation the SHA-2 verifiers use, so that a fault in the counter
	// handling is caught where it lives.
	// Five of the six; the sixth needs 16 777 216 iterations and runs nightly, per 6.22.
	it.each([
		["password", "salt", 1, 20, "0c60c80f961f0e71f3a9b524af6012062fe037a6"],
		["password", "salt", 2, 20, "ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957"],
		["password", "salt", 4096, 20, "4b007901b765489abead49d926f721d065a429c1"],
		[
			"passwordPASSWORDpassword",
			"saltSALTsaltSALTsaltSALTsaltSALTsalt",
			4096,
			25,
			"3d2eec4fe41c849b80c8d83662c0e44a8b291a964cf2f07038",
		],
		// The fifth vector carries a NUL in both the password and the salt, written as an escape
		// because a raw one would make git call this file binary and hide it from every scan.
		["pass\u0000word", "sa\u0000lt", 4096, 16, "56fa6aa75548099dcc37d7f03425e0c3"],
	])(
		"reproduces the HMAC-SHA1 vector at c = %#",
		async (password, salt, c, dkLen, expected) => {
			const { sha1 } = await import("@noble/hashes/legacy.js");
			const derived = await pbkdf2Async(sha1, utf8.encode(password), utf8.encode(salt), {
				c,
				dkLen,
			});

			expect(hexOf(derived)).toBe(expected);
		},
		60_000,
	);

	// RFC 6070's sixth vector: 16 777 216 iterations, minutes of SHA-1, nightly per 6.22.
	it.skipIf(process.env.VELVE_NIGHTLY !== "1")(
		"reproduces the HMAC-SHA1 vector at 16 777 216 iterations",
		async () => {
			const { sha1 } = await import("@noble/hashes/legacy.js");
			const derived = await pbkdf2Async(sha1, utf8.encode("password"), utf8.encode("salt"), {
				c: 16_777_216,
				dkLen: 20,
			});

			expect(hexOf(derived)).toBe("eefe3d61cd4da4e4e9945b3d6ba2158c2634e984");
		},
		1_800_000,
	);

	it.each([
		[
			"pbkdf2-sha256" as const,
			1,
			32,
			"120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b",
		],
		[
			"pbkdf2-sha256" as const,
			4096,
			32,
			"c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a",
		],
	])(
		"verifies the %s vector at c = %# as a stored credential",
		async (scheme, c, _dkLen, expected) => {
			const encoded = [
				"",
				scheme,
				`i=${c}`,
				encodeStandardBase64(utf8.encode("salt")),
				encodeStandardBase64(bytesOfHex(expected)),
			].join("$");

			expect(await verifyAgainstScheme(scheme, throughPolicy("password"), encoded)).toBe(true);
			expect(await verifyAgainstScheme(scheme, throughPolicy("passworE"), encoded)).toBe(false);
		},
		60_000,
	);

	// 6.22: the SHA-2 variants are cross-checked between two independent implementations, because
	// no RFC publishes them. The verifier prefers `crypto.subtle` and falls back to `@noble/hashes`.
	it.each([
		["SHA-256" as const, sha256, 32],
		["SHA-512" as const, sha512, 64],
	])(
		"agrees with crypto.subtle for %s",
		async (name, digest, dkLen) => {
			const password = utf8.encode("password");
			const salt = utf8.encode("salt");
			const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
			const fromSubtle = new Uint8Array(
				await crypto.subtle.deriveBits(
					{ name: "PBKDF2", salt, iterations: 4096, hash: name },
					key,
					dkLen * 8,
				),
			);
			const fromNoble = await pbkdf2Async(digest, password, salt, { c: 4096, dkLen });

			expect(hexOf(fromSubtle)).toBe(hexOf(fromNoble));
		},
		60_000,
	);
});

const PUNCTUATION = "~!@#$%^&*()      ~!@#$%^&*()PNBFRD";

describe("bcrypt — the crypt_blowfish reference vectors", () => {
	// 6.22 requires at least twenty. Four from Provos and Mazieres' own crypt_blowfish suite, then
	// the twenty published with jBCrypt and reproduced by py-bcrypt, which sweep four cost values
	// across an empty password, one byte, three, the lower-case alphabet and a punctuation string.
	const vectors: ReadonlyArray<readonly [string, string]> = [
		["U*U", "$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW"],
		["U*U*", "$2a$05$CCCCCCCCCCCCCCCCCCCCC.VGOzA784oUp/Z0DY336zx7pLYAy0lwK"],
		["U*U*U", "$2a$05$XXXXXXXXXXXXXXXXXXXXXOAcXxm9kjPGEMsLznoKqmqw7tc8WCx4a"],
		[
			"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789chars after 72 are ignored",
			"$2a$05$abcdefghijklmnopqrstuu5s2v8.iXieOjg/.AySBTTZIIVFJeBui",
		],
		["", "$2a$06$DCq7YPn5Rq63x1Lad4cll.TV4S6ytwfsfvkgY8jIucDrjc8deX1s."],
		["", "$2a$08$HqWuK6/Ng6sg9gQzbLrgb.Tl.ZHfXLhvt/SgVyWhQqgqcZ7ZuUtye"],
		["", "$2a$10$k1wbIrmNyFAPwPVPSVa/zecw2BCEnBwVS2GbrmgzxFUOqW9dk4TCW"],
		["", "$2a$12$k42ZFHFWqBp3vWli.nIn8uYyIkbvYRvodzbfbK18SSsY.CsIQPlxO"],
		["a", "$2a$06$m0CrhHm10qJ3lXRY.5zDGO3rS2KdeeWLuGmsfGlMfOxih58VYVfxe"],
		["a", "$2a$08$cfcvVd2aQ8CMvoMpP2EBfeodLEkkFJ9umNEfPD18.hUF62qqlC/V."],
		["a", "$2a$10$k87L/MF28Q673VKh8/cPi.SUl7MU/rWuSiIDDFayrKk/1tBsSQu4u"],
		["a", "$2a$12$8NJH3LsPrANStV6XtBakCez0cKHXVxmvxIlcz785vxAIZrihHZpeS"],
		["abc", "$2a$06$If6bvum7DFjUnE9p2uDeDu0YHzrHM6tf.iqN8.yx.jNN1ILEf7h0i"],
		["abc", "$2a$08$Ro0CUfOqk6cXEKf3dyaM7OhSCvnwM9s4wIX9JeLapehKK5YdLxKcm"],
		["abc", "$2a$10$WvvTPHKwdBJ3uk0Z37EMR.hLA2W6N9AEBhEgrAOljy2Ae5MtaSIUi"],
		["abc", "$2a$12$EXRkfkdmXn2gzds2SSitu.MW9.gAVqa9eLS1//RYtYCmB1eLHg.9q"],
		["abcdefghijklmnopqrstuvwxyz", "$2a$06$.rCVZVOThsIa97pEDOxvGuRRgzG64bvtJ0938xuqzv18d3ZpQhstC"],
		["abcdefghijklmnopqrstuvwxyz", "$2a$08$aTsUwsyowQuzRrDqFflhgekJ8d9/7Z3GV3UcgvzQW3J5zMyrTvlz."],
		["abcdefghijklmnopqrstuvwxyz", "$2a$10$fVH8e28OQRj9tqiDXs1e1uxpsjN0c7II7YPKXua2NAKYvM6iQk7dq"],
		["abcdefghijklmnopqrstuvwxyz", "$2a$12$D4G5f18o7aMMfwasBL7GpuQWuP3pkrZrOAnqP.bmezbMng.QwJ/pG"],
		[PUNCTUATION, "$2a$06$fPIsBO8qRqkjj273rfaOI.HtSV9jLDpTbZn782DC6/t7qT67P6FfO"],
		[PUNCTUATION, "$2a$08$Eq2r4G/76Wv39MzSX262huzPz612MZiYHVUJe/OcOql2jo4.9UxTW"],
		[PUNCTUATION, "$2a$10$LgfYWkbzEvQ4JakH7rOvHe0y8pHKF9OaFgwUZ2q7W2FFZmZzJYlfS"],
		[PUNCTUATION, "$2a$12$WApznUOJfkEGSmYRfnkrPOr466oFDCaj4b6HY3EXGvfxm43seyhgC"],
	];

	it.each(vectors)(
		"verifies the published vector for %j",
		async (password, encoded) => {
			expect(await verifyAgainstScheme("bcrypt", asPassword(password), encoded)).toBe(true);
		},
		60_000,
	);

	it.each(vectors)(
		"refuses a changed password against the vector for %j",
		async (password, encoded) => {
			// The change has to fall inside the first 72 bytes; past them bcrypt cannot see it.
			const changed = `!${password.slice(1)}`;

			expect(await verifyAgainstScheme("bcrypt", asPassword(changed), encoded)).toBe(false);
		},
		60_000,
	);

	it.each(["$2b$", "$2y$", "$2x$"])(
		"reads the same vector under the %s revision",
		async (revision) => {
			const [password, encoded] = vectors[0] as readonly [string, string];
			const rewritten = revision + encoded.slice(4);

			expect(await verifyAgainstScheme("bcrypt", asPassword(password), rewritten)).toBe(true);
		},
		60_000,
	);

	it("proves only the first 72 bytes, which is the limitation 3.3 names", async () => {
		const [long, encoded] = vectors[3] as readonly [string, string];
		const different = `${long.slice(0, 72)}a completely different tail`;

		expect(await verifyAgainstScheme("bcrypt", asPassword(different), encoded)).toBe(true);
	}, 60_000);

	// 6.22 asks for a vector with a NUL byte because `$2a$` and `$2x$` differ there in
	// crypt_blowfish. bcryptjs carries the byte through instead of truncating on it.
	it("does not truncate at a NUL byte", async () => {
		const { hash } = await import("bcryptjs");
		const encoded = await hash("velve\u0000tail", 4);

		expect(await verifyAgainstScheme("bcrypt", asPassword("velve\u0000tail"), encoded)).toBe(true);
		expect(await verifyAgainstScheme("bcrypt", asPassword("velve"), encoded)).toBe(false);
	}, 60_000);

	// crypt_blowfish's `$2x$` reproduces a sign-extension fault for bytes with the high bit set.
	// The verifier rewrites the revision to `$2a$`, so the two are one derivation here — which is
	// right for a 7-bit password and wrong for every other. The published `$2x$` vectors use raw
	// bytes that bcryptjs's string-only interface cannot carry, so this pins the rewrite itself.
	it("treats a $2x$ credential as a $2a$ credential", async () => {
		const [password, encoded] = vectors[0] as readonly [string, string];
		const asEightBitRevision = `$2x$${encoded.slice(4)}`;

		expect(await verifyAgainstScheme("bcrypt", asPassword(password), asEightBitRevision)).toBe(
			await verifyAgainstScheme("bcrypt", asPassword(password), encoded),
		);
	}, 60_000);
});
