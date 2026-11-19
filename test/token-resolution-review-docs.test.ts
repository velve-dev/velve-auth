import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SURFACE_NAMESPACES } from "../src/core/auth/instance.js";

/**
 * Review of S-TOKEN-7's documentation: `oneTimeToken` is a twentieth namespace of 3.15 B, so a
 * plugin whose id is `oneTimeToken` is now refused at start. Every place DOCUMENTATION.md counts
 * the namespaces a plugin may not take must count the list the instance enforces.
 */

const NUMBER_WORDS: Readonly<Record<string, number>> = {
	eighteen: 18,
	nineteen: 19,
	twenty: 20,
	"twenty-one": 21,
};

describe("the documentation counts the namespaces the instance reserves (3.11, 3.15 B)", () => {
	it("states the length of SURFACE_NAMESPACES wherever it counts them", () => {
		const documentation = readFileSync(new URL("../DOCUMENTATION.md", import.meta.url), "utf8");
		const counted = [
			...documentation.matchAll(/\b([a-z-]+) (?:surface )?namespaces (?:3\.15 B|of 3\.15 B)/g),
		].map(([, word]) => NUMBER_WORDS[word ?? ""] ?? word);

		expect(counted.length).toBeGreaterThanOrEqual(3);
		expect(counted.filter((count) => count !== SURFACE_NAMESPACES.length)).toStrictEqual([]);
	});
});
