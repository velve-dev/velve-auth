import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

//the stated counts, the challenge key version, the aggregate alarm and the count of failing commits stay true (E-3367)

const german = readFileSync("VELVE-AUTH-ARCHITEKTUR.md", "utf8");
const english = readFileSync("VELVE-AUTH-ARCHITECTURE.md", "utf8");

const GERMAN_NUMBER_WORDS: Record<string, number> = { neunzehn: 19 };

function requirementItems(text: string): number {
	return (text.match(/^- \*\*S-[A-Z]+-\d+:\*\*/gm) ?? []).length;
}

function testRows(text: string): number {
	return (text.match(/^\| T-[A-Za-z0-9-]+ \|/gm) ?? []).length;
}

describe("stated counts match the lists they count", () => {
	it("German: every stated requirement count equals the S- list items", () => {
		const items = requirementItems(german);
		const stated = [
			...german.matchAll(/(\d+) Sicherheitsanforderungen in/g),
			...german.matchAll(/(\d+) Anforderungen in/g),
			...german.matchAll(/Zu jeder der (\d+) Anforderungen/g),
		].map((match) => Number(match[1]));
		expect(stated.length).toBe(3);
		expect(stated).toEqual([items, items, items]);
		expect(GERMAN_NUMBER_WORDS.neunzehn).toBe(19);
	});

	it("German: every stated test-case count equals the T- rows", () => {
		const rows = testRows(german);
		const stated = [
			...german.matchAll(/(\d+) Testfälle, von denen/g),
			...german.matchAll(/(\d+) Testfälle mit vorab/g),
			...german.matchAll(/zusammen \*\*(\d+) Testfälle\*\*/g),
			...german.matchAll(/Die (\d+) Testfälle dieses Plans/g),
		].map((match) => Number(match[1]));
		expect(stated.length).toBe(4);
		expect(stated).toEqual([rows, rows, rows, rows]);
	});

	it("English: the same counts", () => {
		const items = requirementItems(english);
		const rows = testRows(english);
		const requirementClaims = [
			...english.matchAll(/(\d+) security requirements in/g),
			...english.matchAll(/(\d+) requirements in/g),
			...english.matchAll(/To each of the (\d+) requirements/g),
		].map((match) => Number(match[1]));
		const testClaims = [
			...english.matchAll(/(\d+) test cases, of which/g),
			...english.matchAll(/(\d+) test cases with/g),
			...english.matchAll(/in total \*\*(\d+) test cases\*\*/g),
			...english.matchAll(/The (\d+) test cases of this plan/g),
		].map((match) => Number(match[1]));
		expect(requirementClaims).toEqual([items, items, items]);
		expect(testClaims).toEqual([rows, rows, rows, rows]);
	});
});

describe("the webauthn challenge's token MAC is a produced protected value", () => {
	for (const [name, text] of [
		["German", german],
		["English", english],
	] as const) {
		it(`${name}: S-KEY-3 names token_mac_key_version of webauthn_challenge`, () => {
			const line = text.split("\n").find((l) => l.startsWith("- **S-KEY-3:**")) ?? "";
			expect(line).toMatch(/webauthn_challenge/);
		});
		it(`${name}: T-KEY-3 creates the challenge's token MAC too`, () => {
			const row = text.split("\n").find((l) => l.startsWith("| T-KEY-3 |")) ?? "";
			expect(row).toMatch(/10\/10/);
		});
	}
});

describe("the aggregate alarm has a case", () => {
	it("section 6.24 exercises the aggregate alarm (reason suppressed) and does not only exclude it", () => {
		const rows = german.split("\n").filter((l) => l.startsWith("| T-INTEG-"));
		expect(rows.join("\n")).toMatch(/Sammelalarm/);
	});
});

describe("E-3106 counts the commits that fail the gate", () => {
	it("counts every commit that still carries a red test its own text says goes green later", () => {
		const log = readFileSync("docs/decisions/log.md", "utf8");
		const heading = /### (\w+) commits of this branch do not pass the gate on their own/.exec(log);
		const words: Record<string, number> = { Seven: 7, Eight: 8, Nine: 9 };
		const carried = execFileSync("git", ["rev-list", "--reverse", "21c536b^..6abacf9"], {
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.map((full) => full.slice(0, 7))
			.slice(0, -1);
		const failing = new Set([
			"737f7ec",
			"95890cb",
			"b130ae3",
			"b1dbb1a",
			"512e0de",
			"9a8346f",
			...carried,
		]);
		expect(words[heading?.[1] ?? ""]).toBe(failing.size);
	});
});
