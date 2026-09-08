import { describe, expect, it } from "vitest";
import {
	ARGON2ID_FLOOR,
	MAXIMUM_LENGTH_CEILING_IN_BYTES,
	MINIMUM_LENGTH_FLOOR,
	type PasswordConfig,
	resolvePasswordConfig,
} from "../src/core/password/config.js";
import {
	PasswordConfigurationError,
	type PasswordConfigurationErrorCode,
} from "../src/core/password/errors.js";
import { acceptNewPassword, acceptSubmittedPassword } from "../src/core/password/policy.js";
import { LEGACY_SCHEMES, type LegacyScheme } from "../src/core/password/scheme.js";

const DEFAULTS = resolvePasswordConfig();

function configurationErrorCode(config: PasswordConfig): PasswordConfigurationErrorCode | string {
	try {
		resolvePasswordConfig(config);
	} catch (failure) {
		return failure instanceof PasswordConfigurationError ? failure.code : "not a start error";
	}
	return "no error";
}

describe("password configuration", () => {
	it("defaults to the parameters section 3.3 fixes", () => {
		expect(DEFAULTS.argon2id).toEqual(ARGON2ID_FLOOR);
		expect(DEFAULTS.minimumLength).toBe(MINIMUM_LENGTH_FLOOR);
		expect(DEFAULTS.maximumLengthInBytes).toBe(MAXIMUM_LENGTH_CEILING_IN_BYTES);
		expect([...DEFAULTS.acceptLegacy]).toEqual([...LEGACY_SCHEMES]);
		expect(DEFAULTS.validate).toBeUndefined();
	});

	it("never sizes the semaphore above min(4, cpus)", () => {
		const reported = globalThis.navigator?.hardwareConcurrency;
		const cores = typeof reported === "number" && reported >= 1 ? Math.floor(reported) : 1;

		expect(DEFAULTS.concurrentHashLimit).toBeGreaterThanOrEqual(1);
		expect(DEFAULTS.concurrentHashLimit).toBe(Math.min(4, cores));
	});

	it("accepts every parameter raised above the floor", () => {
		const raised = resolvePasswordConfig({
			argon2id: { memoryKiB: 65536, iterations: 4, parallelism: 2 },
		});

		expect(raised.argon2id).toEqual({ memoryKiB: 65536, iterations: 4, parallelism: 2 });
	});

	it("refuses to start on a parameter below the floor", () => {
		expect(configurationErrorCode({ argon2id: { ...ARGON2ID_FLOOR, memoryKiB: 19455 } })).toBe(
			"argon2id_memory_below_floor",
		);
		expect(configurationErrorCode({ argon2id: { ...ARGON2ID_FLOOR, iterations: 1 } })).toBe(
			"argon2id_iterations_below_floor",
		);
		expect(configurationErrorCode({ argon2id: { ...ARGON2ID_FLOOR, parallelism: 0 } })).toBe(
			"argon2id_parallelism_below_floor",
		);
		expect(configurationErrorCode({ minimumLength: 7 })).toBe("minimum_length_below_floor");
	});

	it("refuses to start on a length ceiling above 4096 and on a nonsensical semaphore", () => {
		expect(configurationErrorCode({ maximumLengthInBytes: 4097 })).toBe(
			"maximum_length_above_ceiling",
		);
		expect(configurationErrorCode({ maximumLengthInBytes: 7 })).toBe(
			"maximum_length_below_minimum_length",
		);
		expect(configurationErrorCode({ maximumLengthInBytes: 100.5 })).toBe(
			"maximum_length_not_an_integer",
		);
		expect(configurationErrorCode({ concurrentHashLimit: 0 })).toBe(
			"concurrent_hash_limit_out_of_range",
		);
		expect(configurationErrorCode({ concurrentHashLimit: 1.5 })).toBe(
			"concurrent_hash_limit_out_of_range",
		);
	});

	it("lets the estate be narrowed but not extended", () => {
		expect([...resolvePasswordConfig({ acceptLegacy: ["bcrypt"] }).acceptLegacy]).toEqual([
			"bcrypt",
		]);
		expect(
			configurationErrorCode({
				acceptLegacy: ["md5"] as unknown as readonly LegacyScheme[],
			}),
		).toBe("legacy_scheme_unknown");
	});
});

describe("length policy", () => {
	it("accepts the shortest and the longest permitted input", () => {
		expect(acceptSubmittedPassword("a".repeat(8), DEFAULTS)).not.toBeNull();
		expect(acceptSubmittedPassword("a".repeat(4096), DEFAULTS)).not.toBeNull();
	});

	it("rejects everything outside the limits before any derivation could start", () => {
		for (const plaintext of ["", "a".repeat(7), "a".repeat(4097), "a".repeat(1024 * 1024)]) {
			expect(acceptSubmittedPassword(plaintext, DEFAULTS)).toBeNull();
		}
	});

	it("admits a decomposed password whose normal form fits the byte ceiling", () => {
		const decomposed = "U\u0308\u0301".repeat(1400);

		expect(decomposed.length).toBe(4200);
		expect(acceptSubmittedPassword(decomposed, DEFAULTS)?.bytes).toHaveLength(2800);
	});

	it("still refuses an input too long to be worth normalising", () => {
		const beyondTheBound = "a".repeat(4 * 4096 + 1);

		expect(acceptSubmittedPassword(beyondTheBound, DEFAULTS)).toBeNull();
		expect(acceptSubmittedPassword("a".repeat(4 * 4096), DEFAULTS)).toBeNull();
	});

	it("measures characters, not UTF-16 code units", () => {
		expect(acceptSubmittedPassword("😀".repeat(7), DEFAULTS)).toBeNull();
		expect(acceptSubmittedPassword("😀".repeat(8), DEFAULTS)).not.toBeNull();
	});

	it("measures the byte ceiling in bytes", () => {
		const twoBytesEach = "ä".repeat(2048);

		expect(new TextEncoder().encode(twoBytesEach)).toHaveLength(4096);
		expect(acceptSubmittedPassword(twoBytesEach, DEFAULTS)).not.toBeNull();
		expect(acceptSubmittedPassword(`${twoBytesEach}a`, DEFAULTS)).toBeNull();
	});

	it("normalises to NFKC so that two spellings of one password agree", () => {
		const composed = acceptSubmittedPassword("passwörter", DEFAULTS);
		const decomposed = acceptSubmittedPassword("passwörter", DEFAULTS);

		expect(composed?.text).toBe(decomposed?.text);
		expect(composed?.bytes).toEqual(decomposed?.bytes);
	});

	it("counts a compatibility character after normalisation", () => {
		expect(acceptSubmittedPassword("\ufb01\ufb01\ufb01\ufb01", DEFAULTS)?.text).toBe("fifififi");
	});
});

describe("the validate hook", () => {
	it("runs when a password is set", async () => {
		const seen: string[] = [];
		const config = resolvePasswordConfig({
			validate: async (plaintext) => {
				seen.push(plaintext);
			},
		});

		await acceptNewPassword("correct horse battery", config);

		expect(seen).toEqual(["correct horse battery"]);
	});

	it("sees the normalised form, which is what becomes the credential", async () => {
		const seen: string[] = [];
		const config = resolvePasswordConfig({
			validate: async (plaintext) => {
				seen.push(plaintext);
			},
		});

		await acceptNewPassword("passwörter", config);

		expect(seen).toEqual(["passwörter"]);
	});

	it("is not reachable from the sign-in entry", () => {
		let calls = 0;
		const config = resolvePasswordConfig({
			validate: async () => {
				calls += 1;
			},
		});

		expect(acceptSubmittedPassword("correct horse battery", config)).not.toBeNull();
		expect(calls).toBe(0);
	});

	it("does not run when the length policy already refused", async () => {
		let calls = 0;
		const config = resolvePasswordConfig({
			validate: async () => {
				calls += 1;
			},
		});

		await expect(acceptNewPassword("short", config)).rejects.toMatchObject({
			code: "password_unacceptable",
		});
		expect(calls).toBe(0);
	});

	it("turns its own rejection into one code and keeps its message to itself", async () => {
		const config = resolvePasswordConfig({
			validate: async () => {
				throw new Error("found in leak corpus row 41277");
			},
		});

		await expect(acceptNewPassword("correct horse battery", config)).rejects.toMatchObject({
			code: "password_unacceptable",
			message: "The password does not meet the length requirements.",
		});
	});

	it("survives a hook that throws synchronously", async () => {
		const config = resolvePasswordConfig({
			validate: (): Promise<void> => {
				throw new Error("synchronous");
			},
		});

		await expect(acceptNewPassword("correct horse battery", config)).rejects.toMatchObject({
			code: "password_unacceptable",
		});
	});
});
