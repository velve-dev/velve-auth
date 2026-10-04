import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * E-2830 made `auth.pending.cancel` take the call fields, so a 1.1 caller passing `{ pendingToken }`
 * alone no longer compiles, and its Price says 1.2.0's notes have to name the break.
 */

const notes = readFileSync(
	fileURLToPath(new URL("../docs/releases/1.2.0.md", import.meta.url)),
	"utf8",
);

function breakingList(): string {
	const start = notes.indexOf("Can break compilation:");
	const end = notes.indexOf("Additive:", start);
	if (start < 0 || end < 0) {
		throw new Error("the list of changes that can break compilation was not found");
	}
	return notes.slice(start, end);
}

describe("the 1.2.0 release notes (E-2830)", () => {
	it("name pending.cancel among the changes that can break compilation", () => {
		expect(breakingList()).toMatch(/`(?:auth\.)?pending\.cancel`/);
	});
});
