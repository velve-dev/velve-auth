import { Buffer } from "node:buffer";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createSecretToken, randomBytes } from "../src/core/token/index.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const randomModule = `${repositoryRoot}src/core/token/random.ts`;

function filesUnder(directory: string, extensions: readonly string[]): string[] {
	try {
		return readdirSync(directory, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && extensions.some((suffix) => entry.name.endsWith(suffix)))
			.map((entry) => `${entry.parentPath}/${entry.name}`)
			.sort();
	} catch {
		return [];
	}
}

const shippedSources = [
	...filesUnder(`${repositoryRoot}src`, [".ts"]),
	...filesUnder(`${repositoryRoot}tools`, [".mjs"]),
	...filesUnder(`${repositoryRoot}migrations`, [".sql"]),
];

// S-RAND-5 and T-RAND-5. The scan the writer inherited covers `src/core`; this one covers
// everything the repository ships or runs, because a second caller outside `core` would
// splinter the generator just as effectively as one inside it.
describe("the CSPRNG is reached in exactly one module (S-RAND-5)", () => {
	it("has a corpus worth scanning", () => {
		expect(shippedSources.length).toBeGreaterThan(50);
	});

	it("names crypto.getRandomValues in core/token/random.ts and nowhere else", () => {
		const callers = shippedSources.filter((path) =>
			/getRandomValues/.test(readFileSync(path, "utf8")),
		);
		expect(callers).toStrictEqual([randomModule]);
	});

	it("keeps no file at the module's former home", () => {
		expect(shippedSources).not.toContain(`${repositoryRoot}src/core/keys/random.ts`);
	});

	// Two module specifiers that resolve to two files would be two generators. Every import
	// of the name must land on the one file, whether written directly or through the barrel.
	it("has every import of randomBytes resolve to that one file", () => {
		const importers = shippedSources.filter(
			(path) => path.endsWith(".ts") && /\brandomBytes\b/.test(readFileSync(path, "utf8")),
		);
		expect(importers.length).toBeGreaterThan(1);

		for (const path of importers) {
			if (path === randomModule) {
				continue;
			}
			const text = readFileSync(path, "utf8");
			const specifiers = [
				...text.matchAll(/import\s*\{[^}]*\brandomBytes\b[^}]*\}\s*from\s*"([^"]+)"/g),
			]
				.map((match) => match[1] ?? "")
				.concat(
					[...text.matchAll(/export\s*\{[^}]*\brandomBytes\b[^}]*\}\s*from\s*"([^"]+)"/g)].map(
						(match) => match[1] ?? "",
					),
				);

			for (const specifier of specifiers) {
				const resolved = fileURLToPath(new URL(specifier, `file://${path}`)).replace(
					/\.js$/,
					".ts",
				);
				expect(resolved, `${path} imports randomBytes from ${specifier}`).toBe(randomModule);
			}
		}
	});

	it("re-exports the name from one barrel only", () => {
		const reExporters = shippedSources.filter(
			(path) =>
				path.endsWith("index.ts") &&
				/export\s*\{[^}]*\brandomBytes\b/.test(readFileSync(path, "utf8")),
		);
		expect(reExporters).toStrictEqual([`${repositoryRoot}src/core/token/index.ts`]);
	});
});

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// Section 6, T-RAND-Verteilung: N = 100 000 per artefact type.
const SAMPLE = 100_000;
const TOKEN_CHARACTERS = 43;
const TOKEN_BYTES = 32;

/** T-RAND-Verteilung is a nightly row in section 6, and its own numbers say why: forty-two
 * independent chi-square tests at p = 0.001 reject about four runs in a hundred with a perfect
 * generator, whatever N is. That belongs where a person reads the result, not in front of a
 * merge. The per-commit obligation is T-RAND-4, which lives in test/token-secret-token.test.ts
 * at its own threshold of 1000. Set VELVE_NIGHTLY=1 to run this. */
const NIGHTLY = process.env.VELVE_NIGHTLY === "1";

// A 32-byte value is 258 base64url bits, so the last character carries four bits of data
// and two of padding: sixteen of the sixty-four characters can appear there and no others.
const FINAL_CHARACTER_VALUES = Array.from({ length: 16 }, (_, index) => index * 4);

// Critical values of the chi-square distribution at p = 0.001, the threshold T-RAND-Verteilung
// fixes, for 63 and for 15 degrees of freedom.
const CHI_SQUARE_63_AT_P_001 = 103.442;
const CHI_SQUARE_15_AT_P_001 = 37.697;
// Two-sided normal deviate for the same p.
const NORMAL_AT_P_001 = 3.29;

function chiSquare(counts: readonly number[]): number {
	const total = counts.reduce((sum, count) => sum + count, 0);
	const expected = total / counts.length;
	return counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
}

describe("the width the generator is asked for (S-RAND-4)", () => {
	it("draws the width it is asked for and nothing shorter", () => {
		for (const length of [0, 1, 12, 16, 31, 32, 64, 255]) {
			expect(randomBytes(length)).toHaveLength(length);
		}
		expect(
			new Set(Array.from({ length: 1000 }, () => Buffer.from(randomBytes(32)).toString("hex")))
				.size,
		).toBe(1000);
	});
});

describe.skipIf(!NIGHTLY)("the tokens the generator produces (T-RAND-Verteilung)", () => {
	// Drawn in beforeAll rather than at collection, so a skipped run draws nothing.
	let sample: string[] = [];
	let decoded: Buffer[] = [];

	beforeAll(() => {
		sample = Array.from({ length: SAMPLE }, () => createSecretToken());
		decoded = sample.map((token) => Buffer.from(token, "base64url"));
	});

	it("is a large enough sample to say anything", () => {
		expect(sample).toHaveLength(SAMPLE);
	});

	it("carries 256 bit in 43 base64url characters, every time", () => {
		for (const token of sample) {
			expect(token).toHaveLength(TOKEN_CHARACTERS);
			expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
		}
		for (const bytes of decoded) {
			expect(bytes).toHaveLength(TOKEN_BYTES);
		}
	});

	it("repeats no token", () => {
		expect(new Set(sample).size).toBe(SAMPLE);
	});

	it("spreads every character position across the alphabet (chi-square, p > 0.001)", () => {
		for (let position = 0; position < TOKEN_CHARACTERS - 1; position += 1) {
			const counts = new Array<number>(BASE64URL_ALPHABET.length).fill(0);
			for (const token of sample) {
				const value = BASE64URL_ALPHABET.indexOf(token[position] as string);
				counts[value] = (counts[value] ?? 0) + 1;
			}
			expect(
				counts.filter((count) => count === 0),
				`position ${position} misses a character`,
			).toStrictEqual([]);
			expect(chiSquare(counts), `position ${position}`).toBeLessThan(CHI_SQUARE_63_AT_P_001);
		}
	});

	it("uses exactly the sixteen characters the padding permits in the last position", () => {
		const counts = new Array<number>(FINAL_CHARACTER_VALUES.length).fill(0);
		for (const token of sample) {
			const value = BASE64URL_ALPHABET.indexOf(token[TOKEN_CHARACTERS - 1] as string);
			expect(FINAL_CHARACTER_VALUES).toContain(value);
			const slot = value / 4;
			counts[slot] = (counts[slot] ?? 0) + 1;
		}
		expect(counts.filter((count) => count === 0)).toStrictEqual([]);
		expect(chiSquare(counts)).toBeLessThan(CHI_SQUARE_15_AT_P_001);
	});

	// A generator that fills only part of the buffer, or that repeats a block, shows up here
	// as a byte position that barely moves.
	it("moves in every one of the thirty-two byte positions", () => {
		for (let position = 0; position < TOKEN_BYTES; position += 1) {
			const seen = new Set<number>();
			let total = 0;
			for (const bytes of decoded) {
				const byte = bytes[position] ?? 0;
				seen.add(byte);
				total += byte;
			}
			expect(seen.size, `byte ${position}`).toBe(256);
			expect(total / SAMPLE, `byte ${position}`).toBeGreaterThan(120);
			expect(total / SAMPLE, `byte ${position}`).toBeLessThan(135);
		}
	});

	it("passes the monobit test over every bit drawn (p > 0.001)", () => {
		let ones = 0;
		for (const bytes of decoded) {
			for (const byte of bytes) {
				for (let bit = 0; bit < 8; bit += 1) {
					ones += (byte >> bit) & 1;
				}
			}
		}
		const bits = SAMPLE * TOKEN_BYTES * 8;
		const deviate = Math.abs(ones - bits / 2) / (Math.sqrt(bits) / 2);
		expect(deviate).toBeLessThan(NORMAL_AT_P_001);
	});

	// NIST SP 800-22, runs test: the number of alternations between adjacent bits. A generator
	// with the right proportion of ones can still fail this by producing them in blocks.
	it("passes the runs test over every bit drawn (p > 0.001)", () => {
		const bits: number[] = [];
		for (const bytes of decoded) {
			for (const byte of bytes) {
				for (let bit = 7; bit >= 0; bit -= 1) {
					bits.push((byte >> bit) & 1);
				}
			}
		}

		const total = bits.length;
		const ones = bits.reduce((sum, bit) => sum + bit, 0);
		const proportion = ones / total;
		let runs = 1;
		for (let index = 1; index < total; index += 1) {
			if (bits[index] !== bits[index - 1]) {
				runs += 1;
			}
		}

		const expected = 2 * total * proportion * (1 - proportion);
		const deviation = 2 * Math.sqrt(2 * total) * proportion * (1 - proportion);
		expect(Math.abs(runs - expected) / deviation).toBeLessThan(NORMAL_AT_P_001);
	});
});
