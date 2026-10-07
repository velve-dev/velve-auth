import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

//the comparison row on purpose-separated keys lists all eight purposes (E-3349)

describe.each([
	["VELVE-AUTH-ARCHITEKTUR.md", "| Zweckgetrennte Schlüssel mit Rotation |"],
	["VELVE-AUTH-ARCHITECTURE.md", "| Purpose-separated keys with rotation |"],
])("%s", (file, rowStart) => {
	it("names state-mac and token-mac in the row that lists the purposes", () => {
		const rows = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
			.split("\n")
			.filter((line) => line.startsWith(rowStart));

		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("`state-mac`");
		expect(rows[0]).toContain("`token-mac`");
	});
});
