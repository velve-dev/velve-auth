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

/** Section 6 puts T-RAND-Verteilung on the nightly tier and T-RAND-4 on every commit; the
 * per-commit half lives in test/token-secret-token.test.ts at its own threshold of 1000. Set
 * VELVE_NIGHTLY=1 to run this. */
const NIGHTLY = process.env.VELVE_NIGHTLY === "1";

// A 32-byte value is 258 base64url bits, so the last character carries four bits of data
// and two of padding: sixteen of the sixty-four characters can appear there and no others.
const FINAL_CHARACTER_VALUES = Array.from({ length: 16 }, (_, index) => index * 4);

function logGamma(value: number): number {
	const coefficients = [
		676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
		12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
	];
	if (value < 0.5) {
		return Math.log(Math.PI / Math.sin(Math.PI * value)) - logGamma(1 - value);
	}
	const shifted = value - 1;
	let series = 0.99999999999980993;
	for (let index = 0; index < coefficients.length; index += 1) {
		series += (coefficients[index] as number) / (shifted + index + 1);
	}
	const t = shifted + coefficients.length - 0.5;
	return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(series);
}

function regularizedLowerGammaBySeries(shape: number, x: number): number {
	let term = 1 / shape;
	let sum = term;
	for (let n = 1; n < 10_000; n += 1) {
		term *= x / (shape + n);
		sum += term;
		if (Math.abs(term) < Math.abs(sum) * Number.EPSILON) {
			break;
		}
	}
	return sum * Math.exp(-x + shape * Math.log(x) - logGamma(shape));
}

function regularizedUpperGammaByContinuedFraction(shape: number, x: number): number {
	const tiny = 1e-300;
	let b = x + 1 - shape;
	let c = 1 / tiny;
	let d = 1 / b;
	let fraction = d;
	for (let i = 1; i < 10_000; i += 1) {
		const a = -i * (i - shape);
		b += 2;
		d = a * d + b;
		if (Math.abs(d) < tiny) {
			d = tiny;
		}
		c = b + a / c;
		if (Math.abs(c) < tiny) {
			c = tiny;
		}
		d = 1 / d;
		const step = d * c;
		fraction *= step;
		if (Math.abs(step - 1) < Number.EPSILON) {
			break;
		}
	}
	return Math.exp(-x + shape * Math.log(x) - logGamma(shape)) * fraction;
}

function chiSquareUpperTailProbability(statistic: number, degreesOfFreedom: number): number {
	if (statistic <= 0) {
		return 1;
	}
	const shape = degreesOfFreedom / 2;
	const x = statistic / 2;
	return x < shape + 1
		? 1 - regularizedLowerGammaBySeries(shape, x)
		: regularizedUpperGammaByContinuedFraction(shape, x);
}

function chiSquareCriticalValue(alpha: number, degreesOfFreedom: number): number {
	let low = 0;
	let high = degreesOfFreedom + 1;
	while (chiSquareUpperTailProbability(high, degreesOfFreedom) > alpha) {
		high *= 2;
	}
	for (let step = 0; step < 200; step += 1) {
		const middle = (low + high) / 2;
		if (chiSquareUpperTailProbability(middle, degreesOfFreedom) > alpha) {
			low = middle;
		} else {
			high = middle;
		}
	}
	return (low + high) / 2;
}

function twoSidedNormalDeviate(alpha: number): number {
	return Math.sqrt(chiSquareCriticalValue(alpha, 1));
}

/** A deliberate deviation from architecture section 6, whose T-RAND-Verteilung row fixes the
 * chi-square threshold *per position* rather than per file, and so states a per-case rate that
 * the file repeats 45 times. Read literally it turns 4.4 per cent of nightly runs red, and
 * that cost one investigation and one retracted explanation (E-993, E-995). The 0.001 is kept and
 * spent on the file instead. Section 6 has not been amended; this is reported, not settled. */
const FILE_FALSE_FAILURE_RATE = 0.001;

const ownSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
const DERIVED_LIMIT_ASSERTION = /toBeLessThan\(([A-Z_]+)\)/g;

function limitsAssertedInThisFile(): string[] {
	return [...ownSource.matchAll(DERIVED_LIMIT_ASSERTION)].map((match) => match[1] as string);
}

function casesMeasuredAgainst(limit: string): number {
	return limitsAssertedInThisFile().filter((name) => name === limit).length;
}

const CHARACTER_POSITION_CASES = TOKEN_CHARACTERS - 1;
const FINAL_CHARACTER_CASES = casesMeasuredAgainst("FINAL_CHARACTER_LIMIT");
const BIT_SEQUENCE_CASES = casesMeasuredAgainst("BIT_SEQUENCE_LIMIT");
/** Every case below whose failure probability under a sound generator is not negligible, counted
 * from this file rather than stated beside it — the three cases E-995 missed are exactly the three
 * that were literals. The remaining assertions — an unseen character, an unseen byte, a byte mean
 * outside a 32-sigma band, a repeated 256-bit token — are past 30 sigma and contribute nothing. */
const INDEPENDENT_CASES = CHARACTER_POSITION_CASES + FINAL_CHARACTER_CASES + BIT_SEQUENCE_CASES;

/** Šidák: the per-case rate whose INDEPENDENT_CASES-fold repetition is FILE_FALSE_FAILURE_RATE. */
const PER_CASE_ALPHA = 1 - (1 - FILE_FALSE_FAILURE_RATE) ** (1 / INDEPENDENT_CASES);

const CHARACTER_POSITION_LIMIT = chiSquareCriticalValue(PER_CASE_ALPHA, 63);
const FINAL_CHARACTER_LIMIT = chiSquareCriticalValue(PER_CASE_ALPHA, 15);
const BIT_SEQUENCE_LIMIT = twoSidedNormalDeviate(PER_CASE_ALPHA);

function chiSquare(counts: readonly number[]): number {
	const total = counts.reduce((sum, count) => sum + count, 0);
	const expected = total / counts.length;
	return counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
}

// The thresholds below are computed rather than quoted, so nothing external states what they
// are. These cases are the external statement: published critical values the implementation has
// to reproduce before the ones it derives mean anything.
describe("the thresholds this file derives for itself", () => {
	it("reproduces published critical values of the chi-square distribution", () => {
		const published = [
			[0.05, 1, 3.841459],
			[0.001, 1, 10.827566],
			[0.025, 2, 7.377759],
			[0.05, 10, 18.307038],
			[0.001, 15, 37.697298],
			[0.005, 30, 53.671962],
			[0.001, 63, 103.442377],
			[0.01, 100, 135.806723],
		] as const;
		for (const [alpha, degreesOfFreedom, expected] of published) {
			expect(
				chiSquareCriticalValue(alpha, degreesOfFreedom),
				`chi-square critical value at p = ${alpha}, ${degreesOfFreedom} degrees of freedom`,
			).toBeCloseTo(expected, 5);
		}
		expect(twoSidedNormalDeviate(0.001)).toBeCloseTo(3.290527, 5);
	});

	it("inverts its own tail probability", () => {
		for (const degreesOfFreedom of [1, 15, 63]) {
			expect(
				chiSquareUpperTailProbability(
					chiSquareCriticalValue(PER_CASE_ALPHA, degreesOfFreedom),
					degreesOfFreedom,
				),
			).toBeCloseTo(PER_CASE_ALPHA, 12);
		}
	});

	it("spends the file's whole false-failure budget and no more", () => {
		expect(1 - (1 - PER_CASE_ALPHA) ** INDEPENDENT_CASES).toBeCloseTo(FILE_FALSE_FAILURE_RATE, 12);
	});

	// A scan that matched nothing would leave INDEPENDENT_CASES at 42 and every threshold too low,
	// with nothing failing — so the corpus, the count and the set of names are all asserted.
	it("counts its cases from its own source rather than from a literal beside it", () => {
		expect(ownSource.length).toBeGreaterThan(10_000);
		expect(limitsAssertedInThisFile().length).toBeGreaterThan(2);
		expect(new Set(limitsAssertedInThisFile())).toStrictEqual(
			new Set(["CHARACTER_POSITION_LIMIT", "FINAL_CHARACTER_LIMIT", "BIT_SEQUENCE_LIMIT"]),
		);
		expect(FINAL_CHARACTER_CASES).toBeGreaterThan(0);
		expect(BIT_SEQUENCE_CASES).toBeGreaterThan(0);
		expect(INDEPENDENT_CASES).toBeGreaterThan(TOKEN_CHARACTERS);
	});

	// Uncorrected, each case spent the file's budget on its own and the file spent it 45 times
	// over. Every derived threshold therefore has to sit above the value it replaced (E-995).
	it("sits above the uncorrected thresholds it replaced", () => {
		expect(CHARACTER_POSITION_LIMIT).toBeGreaterThan(103.442);
		expect(FINAL_CHARACTER_LIMIT).toBeGreaterThan(37.697);
		expect(BIT_SEQUENCE_LIMIT).toBeGreaterThan(3.29);
	});
});

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

	it("spreads every character position across the alphabet (chi-square, the file's shared p)", () => {
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
			expect(chiSquare(counts), `position ${position}`).toBeLessThan(CHARACTER_POSITION_LIMIT);
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
		expect(chiSquare(counts)).toBeLessThan(FINAL_CHARACTER_LIMIT);
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

	it("passes the monobit test over every bit drawn (the file's shared p)", () => {
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
		expect(deviate).toBeLessThan(BIT_SEQUENCE_LIMIT);
	});

	// NIST SP 800-22, runs test: the number of alternations between adjacent bits. A generator
	// with the right proportion of ones can still fail this by producing them in blocks.
	it("passes the runs test over every bit drawn (the file's shared p)", () => {
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

		// SP 800-22 divides by 2√(2n)·π(1−π) because that ratio is the argument it hands to erfc,
		// and erfc takes a deviate over √2. The threshold here is a deviate, so the divisor is the
		// standard deviation itself.
		const expectedRuns = 2 * total * proportion * (1 - proportion);
		const standardDeviation = 2 * Math.sqrt(total) * proportion * (1 - proportion);
		expect(Math.abs(runs - expectedRuns) / standardDeviation).toBeLessThan(BIT_SEQUENCE_LIMIT);
	});
});
