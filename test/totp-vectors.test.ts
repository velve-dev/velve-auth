import { Secret, TOTP } from "otpauth";
import { describe, expect, it } from "vitest";
import { totpCodeForStep } from "../src/core/factor/totp/code.js";
import {
	TOTP_ALGORITHM,
	TOTP_DIGITS,
	TOTP_PERIOD_SECONDS,
	timeStepAt,
} from "../src/core/factor/totp/parameters.js";

/**
 * RFC 6238 Appendix B. The seed is ASCII "12345678901234567890" repeated up to the block size of
 * the hash, which the RFC states in its errata rather than in the table; SHA-256 takes 32 bytes
 * and SHA-512 takes 64.
 */
const SEED_SHA1 = "12345678901234567890";
const SEED_SHA256 = "12345678901234567890123456789012";
const SEED_SHA512 = "1234567890123456789012345678901234567890123456789012345678901234";
const VECTOR_DIGITS = 8;

interface Vector {
	readonly seconds: number;
	readonly algorithm: "SHA1" | "SHA256" | "SHA512";
	readonly counterHex: string;
	readonly token: string;
}

const APPENDIX_B: readonly Vector[] = [
	{ seconds: 59, algorithm: "SHA1", counterHex: "0000000000000001", token: "94287082" },
	{ seconds: 59, algorithm: "SHA256", counterHex: "0000000000000001", token: "46119246" },
	{ seconds: 59, algorithm: "SHA512", counterHex: "0000000000000001", token: "90693936" },
	{ seconds: 1111111109, algorithm: "SHA1", counterHex: "00000000023523EC", token: "07081804" },
	{ seconds: 1111111109, algorithm: "SHA256", counterHex: "00000000023523EC", token: "68084774" },
	{ seconds: 1111111109, algorithm: "SHA512", counterHex: "00000000023523EC", token: "25091201" },
	{ seconds: 1111111111, algorithm: "SHA1", counterHex: "00000000023523ED", token: "14050471" },
	{ seconds: 1111111111, algorithm: "SHA256", counterHex: "00000000023523ED", token: "67062674" },
	{ seconds: 1111111111, algorithm: "SHA512", counterHex: "00000000023523ED", token: "99943326" },
	{ seconds: 1234567890, algorithm: "SHA1", counterHex: "000000000273EF07", token: "89005924" },
	{ seconds: 1234567890, algorithm: "SHA256", counterHex: "000000000273EF07", token: "91819424" },
	{ seconds: 1234567890, algorithm: "SHA512", counterHex: "000000000273EF07", token: "93441116" },
	{ seconds: 2000000000, algorithm: "SHA1", counterHex: "0000000003F940AA", token: "69279037" },
	{ seconds: 2000000000, algorithm: "SHA256", counterHex: "0000000003F940AA", token: "90698825" },
	{ seconds: 2000000000, algorithm: "SHA512", counterHex: "0000000003F940AA", token: "38618901" },
	{ seconds: 20000000000, algorithm: "SHA1", counterHex: "0000000027BC86AA", token: "65353130" },
	{ seconds: 20000000000, algorithm: "SHA256", counterHex: "0000000027BC86AA", token: "77737706" },
	{ seconds: 20000000000, algorithm: "SHA512", counterHex: "0000000027BC86AA", token: "47863826" },
];

const SEED_BY_ALGORITHM: Readonly<Record<Vector["algorithm"], string>> = {
	SHA1: SEED_SHA1,
	SHA256: SEED_SHA256,
	SHA512: SEED_SHA512,
};

describe("RFC 6238 Appendix B (architecture 6.22)", () => {
	it("carries all eighteen vectors", () => {
		expect(APPENDIX_B).toHaveLength(18);
	});

	it.each(APPENDIX_B)(
		"reproduces $token at $seconds s under $algorithm",
		({ seconds, algorithm, token }) => {
			expect(
				TOTP.generate({
					secret: Secret.fromLatin1(SEED_BY_ALGORITHM[algorithm]),
					algorithm,
					digits: VECTOR_DIGITS,
					period: TOTP_PERIOD_SECONDS,
					timestamp: seconds * 1000,
				}),
			).toBe(token);
		},
	);

	it.each(APPENDIX_B)(
		"reads $counterHex as the time step at $seconds s",
		({ seconds, counterHex }) => {
			expect(BigInt(timeStepAt(new Date(seconds * 1000)))).toBe(BigInt(`0x${counterHex}`));
		},
	);

	it("produces the SHA-1 vectors through the library's own generator when it is asked for eight digits", () => {
		const sha1Vectors = APPENDIX_B.filter((vector) => vector.algorithm === "SHA1");
		expect(sha1Vectors).toHaveLength(6);
		for (const vector of sha1Vectors) {
			const step = timeStepAt(new Date(vector.seconds * 1000));
			expect(
				TOTP.generate({
					secret: Secret.fromLatin1(SEED_SHA1),
					algorithm: TOTP_ALGORITHM,
					digits: VECTOR_DIGITS,
					period: TOTP_PERIOD_SECONDS,
					timestamp: step * TOTP_PERIOD_SECONDS * 1000,
				}),
			).toBe(vector.token);
		}
	});

	it("ships six digits, not the eight the vectors use (architecture 3.6)", () => {
		expect(TOTP_DIGITS).toBe(6);
		expect(TOTP_ALGORITHM).toBe("SHA1");

		const secret = Secret.fromLatin1(SEED_SHA1);
		const step = timeStepAt(new Date(59_000));
		expect(totpCodeForStep(Uint8Array.from(secret.bytes), step)).toBe("287082");
	});
});
