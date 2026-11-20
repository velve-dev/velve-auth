import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VELVE_ERROR_CODES } from "../src/core/http/error-map.js";

/**
 * Review of the count S-DEFAULT-8's new code changes: `webauthn_credential_not_discoverable` makes
 * the core thirty codes, and every sentence of DOCUMENTATION.md that counts the core codes, in
 * figures or in words, says the number `VELVE_ERROR_CODES` holds.
 */

const WORDS: Readonly<Record<string, number>> = {
	"twenty-eight": 28,
	"twenty-nine": 29,
	thirty: 30,
	"thirty-one": 31,
};

function countedCoreCodes(text: string): readonly string[] {
	const flattened = text.replace(/\s+/g, " ");
	const stated: string[] = [];
	for (const match of flattened.matchAll(
		/\b(?:one of |the )(\d+|twenty-eight|twenty-nine|thirty|thirty-one)( core| stable)? codes\b|\bunion of all (\d+|twenty-eight|twenty-nine|thirty|thirty-one)\b/g,
	)) {
		const spelled = match[1] ?? match[3] ?? "";
		const number = WORDS[spelled] ?? Number(spelled);
		stated.push(`${number} in "${match[0]}"`);
	}
	return stated;
}

describe("the number of core codes DOCUMENTATION.md states (3.15 F)", () => {
	it("is the number the error map holds, wherever it is stated", () => {
		const documentation = readFileSync(new URL("../DOCUMENTATION.md", import.meta.url), "utf8");
		const expected = VELVE_ERROR_CODES.length;
		const stated = countedCoreCodes(documentation);

		expect(expected).toBe(30);
		expect(stated.length).toBeGreaterThan(0);
		expect(stated.filter((each) => !each.startsWith(`${expected} in`))).toStrictEqual([]);
	});
});
