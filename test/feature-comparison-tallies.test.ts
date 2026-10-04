import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Section 1 states each section's verdicts three times: in the category column of every row, in
 * the bold tally line closing the section, and in 2.N's table per section. A row whose category
 * changes moves all three, and E-36 in section 7 states the omitted total as well.
 */

interface Language {
	readonly file: string;
	readonly categories: readonly [string, string, string, string];
	readonly perSectionHeading: string;
	readonly sumLabel: string;
}

const GERMAN: Language = {
	file: "../VELVE-AUTH-ARCHITEKTUR.md",
	categories: ["Übernehmen", "Anders lösen", "Weglassen", "Übertreffen"],
	perSectionHeading: "#### Je Abschnitt",
	sumLabel: "**Summe**",
};

const ENGLISH: Language = {
	file: "../VELVE-AUTH-ARCHITECTURE.md",
	categories: ["Adopt", "Solve differently", "Omit", "Surpass"],
	perSectionHeading: "#### Per section",
	sumLabel: "**Sum**",
};

/** the sections whose rows are one feature each, so the rows can be counted */
const SECTIONS_OF_SINGLE_ROWS = ["A", "B", "D", "E", "F", "G", "H"];

type Tally = readonly [number, number, number, number];

function textOf(language: Language): string {
	return readFileSync(fileURLToPath(new URL(language.file, import.meta.url)), "utf8");
}

function cellsOf(line: string): string[] {
	return line
		.replace(/\\\|/g, "")
		.split("|")
		.map((cell) => cell.trim());
}

function tallyLines(language: Language): Map<string, Tally> {
	const [adopt, differently, omit, surpass] = language.categories;
	const pattern = new RegExp(
		`^\\*\\*([A-M])(?:\\.1)?: ${adopt} (\\d+) · ${differently} (\\d+) · ${omit} (\\d+) · ${surpass} (\\d+)\\*\\*$`,
		"gm",
	);
	const tallies = new Map<string, Tally>();
	for (const [, section = "", a, b, c, d] of textOf(language).matchAll(pattern)) {
		tallies.set(section, [Number(a), Number(b), Number(c), Number(d)]);
	}
	return tallies;
}

function perSectionTable(language: Language): Map<string, Tally> {
	const text = textOf(language);
	const start = text.indexOf(language.perSectionHeading);
	const end = text.indexOf(language.sumLabel, start);
	const table = new Map<string, Tally>();
	for (const line of text.slice(start, end).split("\n")) {
		const [, section = "", , , a, b, c, d] = cellsOf(line);
		if (/^[A-M]$/.test(section)) {
			table.set(section, [Number(a), Number(b), Number(c), Number(d)]);
		}
	}
	return table;
}

function countedFromRows(language: Language, section: string): Tally {
	const counts = [0, 0, 0, 0];
	for (const line of textOf(language).split("\n")) {
		if (!new RegExp(`^\\| ${section}\\d+ `).test(line)) {
			continue;
		}
		const index = language.categories.indexOf(cellsOf(line)[3] ?? "");
		if (index >= 0) {
			counts[index] = (counts[index] ?? 0) + 1;
		}
	}
	return [counts[0] ?? 0, counts[1] ?? 0, counts[2] ?? 0, counts[3] ?? 0];
}

describe.each([
	["German", GERMAN],
	["English", ENGLISH],
])("section 1's verdicts in the %s specification", (_name, language) => {
	it("finds a tally line and a table row for every section", () => {
		expect([...tallyLines(language).keys()].sort()).toStrictEqual(
			[...perSectionTable(language).keys()].sort(),
		);
		expect(perSectionTable(language).size).toBe(13);
	});

	it("states in each section's tally line what 2.N's table states for it", () => {
		const table = perSectionTable(language);
		const mismatched = [...tallyLines(language)]
			.filter(([section, tally]) => tally.join("/") !== table.get(section)?.join("/"))
			.map(
				([section, tally]) =>
					`${section}: line ${tally.join("/")}, table ${table.get(section)?.join("/")}`,
			);

		expect(mismatched).toStrictEqual([]);
	});

	it.each(SECTIONS_OF_SINGLE_ROWS)("counts section %s's rows as its tally line does", (section) => {
		expect(countedFromRows(language, section)).toStrictEqual(tallyLines(language).get(section));
	});
});

describe("section 7's E-36 against 2.N", () => {
	it("states the omitted total 2.N counts, or 2.N says that it does not", () => {
		const text = textOf(GERMAN);
		const decided = Number(
			/\*\*E-36 — (\d+) von 618 Funktionen werden weggelassen\.\*\*/.exec(text)?.[1],
		);
		const sum = cellsOf(text.split("\n").find((line) => line.includes("**Summe**")) ?? "");
		const counted = Number((sum[6] ?? "").replace(/\*/g, ""));
		const opens = text.indexOf("### 2.N ");
		const theNumbers = text.slice(opens, text.indexOf("\n## 2. ", opens));

		expect(Number.isNaN(decided) || Number.isNaN(counted) || opens < 0).toBe(false);
		expect(decided === counted || theNumbers.includes("E-36")).toBe(true);
	});
});
