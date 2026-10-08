import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

//the integrity chapters say the same numbers and code in both languages paragraph by paragraph (E-3376)

const german = readFileSync(new URL("../VELVE-AUTH-ARCHITEKTUR.md", import.meta.url), "utf8").split(
	"\n",
);
const english = readFileSync(
	new URL("../VELVE-AUTH-ARCHITECTURE.md", import.meta.url),
	"utf8",
).split("\n");

function region(lines: string[], from: string, until: string): string[] {
	const start = lines.findIndex((line) => line.startsWith(from));
	const end = lines.findIndex((line, index) => index > start && line.startsWith(until));
	return lines.slice(start, end).filter((line) => line.trim() !== "");
}

function numbersOutsideCode(line: string): string[] {
	return (
		line
			.replace(/\x60[^\x60]*\x60/g, " ")
			.replace(/(\d)[ \u202f\u00a0](\d{3})(?!\d)/g, "$1$2")
			.match(/\d[\d.,]*\d|\d/g) ?? []
	)
		.map((number) => number.replace(/[.,]/g, ""))
		.sort();
}

function asciiCodeSpans(line: string): string[] {
	return (line.match(/\x60[^\x60\n]+\x60/g) ?? [])
		.filter((span) => /^\x60[\x20-\x7e]+\x60$/.test(span) && !/[<>]/.test(span))
		.sort();
}

const chapters: ReadonlyArray<readonly [string, string, string]> = [
	["3.18", "### 3.18", "## 4."],
	["5.21", "### 5.21", "## 6."],
	["6.24", "### 6.24", "## 7."],
];

describe.each(chapters)(
	"section %s says the same numbers and code in both languages",
	(_name, from, until) => {
		const de = region(german, from, until);
		const en = region(english, from, until);

		it("has the same number of paragraphs", () => {
			expect(en.length).toBe(de.length);
		});

		it("agrees paragraph by paragraph", () => {
			const disagreements = de
				.map((line, index) => ({ line: line.slice(0, 60), en: en[index] ?? "", de: line }))
				.filter(
					({ de: d, en: e }) =>
						JSON.stringify(numbersOutsideCode(d)) !== JSON.stringify(numbersOutsideCode(e)) ||
						JSON.stringify(asciiCodeSpans(d)) !== JSON.stringify(asciiCodeSpans(e)),
				)
				.map(({ line }) => line);
			expect(disagreements).toStrictEqual([]);
		});
	},
);

describe("the configuration rows of 3.15 A.2 and the interface say the same", () => {
	it.each(["| `securityState`", "| `limits`", "  passkeysPerAccount", "  identitiesPerAccount"])(
		"%s",
		(prefix) => {
			const de = german.filter((line) => line.startsWith(prefix));
			const en = english.filter((line) => line.startsWith(prefix));
			expect(de.length).toBeGreaterThan(0);
			expect(en.map((line) => numbersOutsideCode(line))).toStrictEqual(
				de.map((line) => numbersOutsideCode(line)),
			);
			expect(en.map((line) => asciiCodeSpans(line))).toStrictEqual(
				de.map((line) => asciiCodeSpans(line)),
			);
			expect(en.map((line) => line.match(/\b\d+\b/g))).toStrictEqual(
				de.map((line) => line.match(/\b\d+\b/g)),
			);
		},
	);
});
