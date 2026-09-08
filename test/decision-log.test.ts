import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const caseStudy = readFileSync(`${repositoryRoot}/CASE-STUDY.md`, "utf8");
const rules = readFileSync(`${repositoryRoot}/CLAUDE.md`, "utf8");

/** The specification is the source E-01 to E-46 were taken from, not a citation site. */
const NOT_A_CITATION_SITE = new Set(["VELVE-AUTH-ARCHITEKTUR.md"]);
const BINARY_DIRECTORY = /^assets\//;
/** Smart punctuation and pasted text produce dashes other than the ASCII hyphen. */
const CITATION = /\bE[-‐-―−](\d+)\b/g;
const RANGE_ROW = /^\| E-(\d+) … E-(\d+) \| (.+?) \|$/gm;
/** Entries written before the log turned English keep the German form (E-189). */
const HEADING_FORMS = [
	{
		heading: /^\*\*E-(\d+) — (.+?)\*\*/gm,
		numberGroup: 1,
		titleGroup: 2,
		parts: ["*Kontext:*", "*Verworfen:*", "*Grund:*", "*Preis:*"],
	},
	{
		heading: /^### (.+)\n`E-(\d+)` · /gm,
		numberGroup: 2,
		titleGroup: 1,
		parts: ["**Context.**", "**Rejected.**", "**Reason.**", "**Price.**"],
	},
] as const;

function entries(): { number: number; title: string; body: string; parts: readonly string[] }[] {
	const found = HEADING_FORMS.flatMap((form) =>
		[...caseStudy.matchAll(form.heading)].map((match) => ({
			at: match.index,
			number: Number(match[form.numberGroup]),
			title: String(match[form.titleGroup]),
			parts: form.parts,
		})),
	).sort((one, other) => one.at - other.at);

	return found.map((entry, index) => ({
		number: entry.number,
		title: entry.title,
		parts: entry.parts,
		body: caseStudy.slice(entry.at, found[index + 1]?.at ?? caseStudy.length),
	}));
}

function reservedRanges(): { first: number; last: number; owner: string }[] {
	return [...rules.matchAll(RANGE_ROW)].map((row) => ({
		first: Number(row[1]),
		last: Number(row[2]),
		owner: String(row[3]),
	}));
}

/** A row of the reservation table names numbers that do not exist yet; that is its
 * purpose. Only whole rows, and only in the file that holds the table. */
function withoutRangeTableRows(path: string, contents: string): string {
	return path === "CLAUDE.md" ? contents.replace(RANGE_ROW, "") : contents;
}

function everyTrackedFile(): string[] {
	const listed = execFileSync("git", ["ls-files", "-z"], { cwd: repositoryRoot, encoding: "utf8" });
	return listed
		.split("\0")
		.filter(Boolean)
		.filter((path) => !BINARY_DIRECTORY.test(path))
		.filter((path) => !NOT_A_CITATION_SITE.has(path));
}

describe("decision log", () => {
	const log = entries();

	it("numbers every decision exactly once", () => {
		const counts = new Map<number, number>();
		for (const entry of log) counts.set(entry.number, (counts.get(entry.number) ?? 0) + 1);
		const repeated = [...counts.entries()]
			.filter(([, count]) => count > 1)
			.map(([number]) => `E-${String(number).padStart(2, "0")}`);
		expect(repeated).toEqual([]);
	});

	it("gives every decision all four parts", () => {
		const incomplete = log.flatMap((entry) => {
			const missing = entry.parts.filter((part) => !entry.body.includes(part));
			return missing.length === 0
				? []
				: [
						`E-${String(entry.number).padStart(2, "0")} (${entry.title}) lacks ${missing.join(", ")}`,
					];
		});
		expect(incomplete).toEqual([]);
	});

	it("keeps every decision inside a range CLAUDE.md reserves for it", () => {
		const ranges = reservedRanges();
		expect(ranges.length).toBeGreaterThan(0);
		const outside = log
			.filter((entry) => !ranges.some((r) => entry.number >= r.first && entry.number <= r.last))
			.map((entry) => `E-${String(entry.number).padStart(2, "0")} (${entry.title})`);
		expect(outside).toEqual([]);
	});

	it("reserves no number to two owners", () => {
		const ranges = reservedRanges();
		const overlapping = ranges.flatMap((range, index) =>
			ranges
				.slice(index + 1)
				.filter((other) => range.first <= other.last && other.first <= range.last)
				.map((other) => `${range.owner} overlaps ${other.owner}`),
		);
		expect(overlapping).toEqual([]);
	});

	it("resolves every decision cited anywhere in the repository", () => {
		const known = new Set(log.map((entry) => entry.number));
		const dangling: string[] = [];
		for (const path of everyTrackedFile()) {
			const contents = withoutRangeTableRows(
				path,
				readFileSync(`${repositoryRoot}${path}`, "utf8"),
			);
			for (const [citation, digits] of contents.matchAll(CITATION)) {
				if (!known.has(Number(digits))) {
					dangling.push(
						`${path.replace(repositoryRoot, "")} cites ${citation}, which does not exist`,
					);
				}
			}
		}
		expect(dangling).toEqual([]);
	});
});
