import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

//the token mac encodes the factor list in its stored order, the one exception to the sorted lists (E-3383)

describe.each([
	[
		"German",
		"../VELVE-AUTH-ARCHITEKTUR.md",
		"in der Reihenfolge, in der die Zeile ihn speichert, so dass eine umgestellte oder wiederholte Liste den MAC bricht",
	],
	[
		"English",
		"../VELVE-AUTH-ARCHITECTURE.md",
		"in the order the row stores it, so a reordered or repeated list breaks the MAC",
	],
])("section 3.18 point 3 in the %s specification", (_name, file, statement) => {
	it("states that the factors keep their stored order under the token MAC", () => {
		expect(readFileSync(new URL(file, import.meta.url), "utf8")).toContain(statement);
	});
});
