import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ONE_TIME_TOKEN_PURPOSES } from "../src/core/token/purpose.js";

/**
 * Review of change 6: the counts and enumerations the recovery changes, read where the
 * specification and DOCUMENTATION.md state them. The recovery adds a freshness-gated method to
 * B.9, a ninth hook point and a fifth one-time token purpose; each statement of those counts must
 * say the new number, and a link to a heading the branch renamed must still land.
 */

function textOf(file: string): string {
	return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
	four: 4,
	five: 5,
	eight: 8,
	nine: 9,
	seventeen: 17,
	eighteen: 18,
};

function freshMethodsOfB9(specification: string, heading: string, fresh: string): number {
	const start = specification.indexOf(heading);
	const end = specification.indexOf("\n##### ", start + heading.length);
	const rows = specification
		.slice(start, end)
		.split("\n")
		.filter((line) => line.startsWith("| `"));
	return rows
		.map((row) => row.split("|").map((cell) => cell.trim()))
		.filter((cells) => cells[3] === fresh)
		.reduce((sum, cells) => sum + (cells[1]?.match(/`[^`]+`/g)?.length ?? 0), 0);
}

describe("the methods freshness gates, which the cancel adds to (3.15 B.9)", () => {
	it("is the count of B.9's fresh rows wherever the German specification states it", () => {
		const german = textOf("VELVE-AUTH-ARCHITEKTUR.md");
		const counted = freshMethodsOfB9(german, "##### B.9 Vorbedingungen je Methode", "**ja**");
		const stated = german.match(/sie betrifft (\d+) Methoden \(B\.9\)/)?.[1];

		expect(counted).toBe(18);
		expect(Number(stated)).toBe(counted);
	});

	it("is the same count in the English translation", () => {
		const english = textOf("VELVE-AUTH-ARCHITECTURE.md");
		const stated = english.match(/it concerns (\d+) methods \(B\.9\)/)?.[1];

		expect(Number(stated)).toBe(18);
	});

	it("is the same count in DOCUMENTATION.md", () => {
		const stated = textOf("DOCUMENTATION.md").match(/gates the (\w+)\s+methods of 3\.15 B\.9/)?.[1];

		expect(NUMBER_WORDS[stated ?? ""]).toBe(18);
	});
});

describe("the nine hook points wherever DOCUMENTATION.md counts them (3.11)", () => {
	const documentation = textOf("DOCUMENTATION.md");

	it("links only to hook headings that exist", () => {
		const anchors = [...documentation.matchAll(/\(#(the-\w+-hook-points)\)/g)].map(
			(match) => match[1],
		);
		const headings = [...documentation.matchAll(/^#+ (The \w+ hook points)$/gm)].map((match) =>
			(match[1] ?? "").toLowerCase().replaceAll(" ", "-"),
		);

		expect(anchors.filter((anchor) => !headings.includes(anchor ?? ""))).toStrictEqual([]);
	});

	it("never counts them as eight", () => {
		const eights = [
			...documentation.matchAll(
				/(the eight enumerated hook|held to the eight points|All eight have a producer)/g,
			),
		].map((match) => match[1]);

		expect(eights).toStrictEqual([]);
	});
});

describe("the five one-time token purposes wherever they are counted (3.7, S-TOKEN-7)", () => {
	it("are five in the code", () => {
		expect(ONE_TIME_TOKEN_PURPOSES).toHaveLength(5);
	});

	it("are never 'the four' in DOCUMENTATION.md's purpose guard, whose message says five", () => {
		const fours = [
			...textOf("DOCUMENTATION.md").matchAll(
				/the purpose is not one of the four|one of the four or `null`/g,
			),
		];

		expect(fours).toHaveLength(0);
	});

	it("are all resolved by T-TOKEN-7, in both specification files", () => {
		const german = textOf("VELVE-AUTH-ARCHITEKTUR.md")
			.split("\n")
			.find((line) => line.startsWith("| T-TOKEN-7 "));
		const english = textOf("VELVE-AUTH-ARCHITECTURE.md")
			.split("\n")
			.find((line) => line.startsWith("| T-TOKEN-7 "));

		expect(german).not.toMatch(/der vier Zwecke|\*\*4\/4\*\* Zwecke/);
		expect(english).not.toMatch(/of the four purposes|\*\*4\/4\*\* purposes/);
	});
});
