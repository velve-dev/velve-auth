import { describe, expect, it } from "vitest";
import { randomBytes } from "../src/core/keys/index.js";

describe("randomBytes", () => {
	it("returns the requested number of bytes", () => {
		expect(randomBytes(0)).toHaveLength(0);
		expect(randomBytes(12)).toHaveLength(12);
		expect(randomBytes(32)).toHaveLength(32);
	});

	it("does not repeat itself (S-RAND-1)", () => {
		const draws = new Set(Array.from({ length: 64 }, () => randomBytes(32).join(",")));
		expect(draws.size).toBe(64);
	});
});
