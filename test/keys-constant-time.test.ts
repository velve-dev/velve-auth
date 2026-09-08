import { describe, expect, it } from "vitest";
import { equalsInConstantTime } from "../src/core/keys/index.js";
import { randomBytes } from "../src/core/token/index.js";

describe("equalsInConstantTime", () => {
	it("accepts identical byte sequences", () => {
		const bytes = randomBytes(32);
		expect(equalsInConstantTime(bytes, Uint8Array.from(bytes))).toBe(true);
	});

	it("rejects a single flipped bit at every position", () => {
		const bytes = randomBytes(32);

		for (let index = 0; index < bytes.length; index += 1) {
			const flipped = Uint8Array.from(bytes);
			flipped[index] = (flipped[index] ?? 0) ^ 0b0000_0001;
			expect(equalsInConstantTime(bytes, flipped)).toBe(false);
		}
	});

	it("rejects sequences of different length", () => {
		expect(equalsInConstantTime(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
		expect(equalsInConstantTime(new Uint8Array(0), new Uint8Array(1))).toBe(false);
	});

	it("accepts two empty sequences", () => {
		expect(equalsInConstantTime(new Uint8Array(0), new Uint8Array(0))).toBe(true);
	});
});
