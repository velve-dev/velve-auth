import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const german = readFileSync(`${repositoryRoot}/VELVE-AUTH-ARCHITEKTUR.md`, "utf8");
const english = readFileSync(`${repositoryRoot}/VELVE-AUTH-ARCHITECTURE.md`, "utf8");

/**
 * Line numbers are not comparable: German and English wrap differently, so a bullet that
 * takes two lines in one takes one in the other. Everything asserted here survives that.
 */
const IDENTIFIER =
	/\bS-[A-Z]+-\d+|\bT-[A-Z]+-\d+|\bL-\d+|\bE-\d+|\bCVE-\d{4}-\d+|\bGHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|\bCWE-\d+/g;

/**
 * A heading's text is translated, so it cannot be compared; its level and the section
 * number it opens with can. Without the number a heading keeps its level while saying
 * something else entirely, which is a plant that passed before this carried it.
 */
function headingShapes(document: string): string[] {
	return [...document.matchAll(/^(#{1,6}) +(\S*)/gm)].map((match) => {
		const numbering = /^[0-9A-Z](?:\.[0-9]+)*\.?$/.test(String(match[2])) ? String(match[2]) : "";
		return `${String(match[1])} ${numbering}`;
	});
}

function identifierCensus(document: string): Map<string, number> {
	const census = new Map<string, number>();
	for (const [identifier] of document.matchAll(IDENTIFIER)) {
		census.set(identifier, (census.get(identifier) ?? 0) + 1);
	}
	return census;
}

function fencedBlockCount(document: string): number {
	return [...document.matchAll(/^```/gm)].length;
}

/** Each run of consecutive table lines is one table; the run length is its height. */
function tableHeights(document: string): number[] {
	const heights: number[] = [];
	let run = 0;
	for (const line of document.split("\n")) {
		if (line.startsWith("|")) {
			run += 1;
			continue;
		}
		if (run > 0) heights.push(run);
		run = 0;
	}
	if (run > 0) heights.push(run);
	return heights;
}

function sortedCensusEntries(census: Map<string, number>): string[] {
	return [...census].map(([name, count]) => `${name}×${count}`).sort();
}

describe("the English architecture is a translation of the German one", () => {
	it("carries the same headings, at the same levels and section numbers, in the same order", () => {
		expect(headingShapes(english)).toEqual(headingShapes(german));
	});

	it("cites every requirement, test, gap, decision and advisory the same number of times", () => {
		const inGerman = identifierCensus(german);
		const inEnglish = identifierCensus(english);
		expect(sortedCensusEntries(inEnglish)).toEqual(sortedCensusEntries(inGerman));
	});

	it("keeps every table, with the same number of rows in each", () => {
		expect(tableHeights(english)).toEqual(tableHeights(german));
	});

	it("keeps every fenced block", () => {
		expect(fencedBlockCount(english)).toBe(fencedBlockCount(german));
	});

	/**
	 * An untranslated paragraph is the failure this file exists to catch. Bare umlauts do
	 * not prove one: `Müller` is the example that makes the NFKC casefold collision in
	 * 3.4 legible, and one German report title is quoted verbatim. Both live inside a code
	 * span or a quotation, so prose is what gets examined — with the letters as one
	 * signal and the function words, which no identifier contains, as the other.
	 */
	it("is written in English outside code spans and quotations", () => {
		const prose = english
			.replace(/^```[\s\S]*?^```/gm, "")
			.replace(/`[^`\n]*`/g, "")
			.replace(/"[^"\n]*"/g, "");
		expect([...prose.matchAll(/[äöüßÄÖÜ]/g)].map((match) => match[0])).toEqual([]);
		expect(
			[...prose.matchAll(/\b(?:nicht|und|oder|werden|wird|eine|dass|kein|sich|auch)\b/g)].map(
				(match) => match[0],
			),
		).toEqual([]);
	});

	/** CLAUDE.md states which file wins, and the translation says so about itself. */
	it("says on its own face that the German is binding", () => {
		expect(english).toContain("VELVE-AUTH-ARCHITEKTUR.md");
		expect(english).toMatch(/the German is right and this file has a bug/);
	});
});
