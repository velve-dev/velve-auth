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

/** CLAUDE.md §1 made the log English; every entry is still German until the migration
 * pass runs, so both forms are accepted until it has. */
const GERMAN_ENTRY = /^\*\*E-(\d+) — (.+?)\*\*/gm;
const ENGLISH_ENTRY = /^### (.+?)\n`E-(\d+)` · ([^·\n]+) · (.+?)$/gm;
const GERMAN_PARTS = ["*Kontext:*", "*Verworfen:*", "*Grund:*", "*Preis:*"];
const ENGLISH_PARTS = ["**Context.**", "**Rejected.**", "**Reason.**", "**Price.**"];

/** A heading opens a markdown block, so it follows a blank line or an ATX heading; a
 * wrapped prose line never does, which is what keeps a citation at a line start out. */
const OPENS_A_BLOCK = /^(?:#{1,6}[ \t]|[ \t]*$)/;
const CLAIM_LINE =
	/^[ \t]*(?:[#>]+[ \t]*|[-*+][ \t]+|\*{1,2}|`)*E-\d+(?:`|\*{1,2})?[ \t]*(?:$|[—–\-:·])/;

/** Entries written in the German format, from before CLAUDE.md §1 made the log English. They
 * name no owner, so not one of them can be attributed; the count is here so that a new entry
 * written without an owner fails instead of joining a set nothing looks at. It only comes down. */
const ENTRIES_THAT_NAME_NO_OWNER = 167;

type Heading = {
	number: number;
	title: string;
	owner: string | null;
	parts: string[];
	start: number;
	numberLineStart: number;
};

function label(entry: { number: number; title: string }): string {
	return `E-${String(entry.number).padStart(2, "0")} (${entry.title})`;
}

function headings(): Heading[] {
	const german = [...caseStudy.matchAll(GERMAN_ENTRY)].map((match) => ({
		number: Number(match[1]),
		title: String(match[2]),
		owner: null,
		parts: GERMAN_PARTS,
		start: Number(match.index),
		numberLineStart: Number(match.index),
	}));
	const english = [...caseStudy.matchAll(ENGLISH_ENTRY)].map((match) => ({
		number: Number(match[2]),
		title: String(match[1]),
		owner: String(match[3]).trim(),
		parts: ENGLISH_PARTS,
		start: Number(match.index),
		numberLineStart: Number(match.index) + String(match[1]).length + "### \n".length,
	}));
	return [...german, ...english].sort((a, b) => a.start - b.start);
}

function entries(): (Heading & { body: string })[] {
	const found = headings();
	return found.map((heading, index) => ({
		...heading,
		body: caseStudy.slice(heading.start, found[index + 1]?.start ?? caseStudy.length),
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

/** A row names its owner as a backticked feature where it has one. Where it names none, the
 * row's own name is what it opens with, up to the first comma — the clause after the comma is
 * prose about the row, not a second owner — and an entry may cite that name in full or the
 * words it starts with, which is how `gate` and `gate and infrastructure` are the same owner
 * and `which belongs to no wave` is not one at all (E-159). */
function ownersDeclaredBy(row: string): string[] {
	const features = [...row.matchAll(/`([^`]+)`/g)].map((match) => String(match[1]));
	if (features.length > 0) {
		return features;
	}
	const words = (row.split(",")[0] ?? "").trim().split(/\s+/);
	return words.map((_, index) => words.slice(0, index + 1).join(" "));
}

function everyTrackedFile(): string[] {
	// `--others --exclude-standard` as well as the index: a citation in a file that is written but
	// not yet added is a citation, and reading only the index skipped one beside four it reported
	// (E-1659).
	const listed = execFileSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		{ cwd: repositoryRoot, encoding: "utf8" },
	);
	return listed
		.split("\0")
		.filter(Boolean)
		.filter((path) => !BINARY_DIRECTORY.test(path))
		.filter((path) => !NOT_A_CITATION_SITE.has(path));
}

function claimedHeadings(): { offset: number; line: number; text: string }[] {
	const lines = caseStudy.split("\n");
	const claims: { offset: number; line: number; text: string }[] = [];
	let offset = 0;
	for (const [index, line] of lines.entries()) {
		const previous = lines[index - 1];
		const opensABlock = previous === undefined || OPENS_A_BLOCK.test(previous);
		if (opensABlock && CLAIM_LINE.test(line)) {
			claims.push({ offset, line: index + 1, text: line.trim() });
		}
		offset += line.length + 1;
	}
	return claims;
}

describe("decision log", () => {
	const log = entries();

	it("parses every heading that claims a decision number", () => {
		const parsed = new Set(log.map((entry) => entry.numberLineStart));
		const unparsed = claimedHeadings()
			.filter((claim) => !parsed.has(claim.offset))
			.map((claim) => `CASE-STUDY.md:${claim.line} heads no entry: ${claim.text}`);
		expect(unparsed).toEqual([]);
		expect(log.length).toBeGreaterThan(0);
	});

	it("sees the heading of every entry it parses", () => {
		const claimed = new Set(claimedHeadings().map((claim) => claim.offset));
		const invisible = log.filter((entry) => !claimed.has(entry.numberLineStart)).map(label);
		expect(invisible).toEqual([]);
	});

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
			return missing.length === 0 ? [] : [`${label(entry)} lacks ${missing.join(", ")}`];
		});
		expect(incomplete).toEqual([]);
	});

	it("keeps every decision inside a range CLAUDE.md reserves for it", () => {
		const ranges = reservedRanges();
		expect(ranges.length).toBeGreaterThan(0);
		const outside = log
			.filter((entry) => !ranges.some((r) => entry.number >= r.first && entry.number <= r.last))
			.map(label);
		expect(outside).toEqual([]);
	});

	// CLAUDE.md §6 says the ranges exist so that a feature quietly taking a number it does not own
	// fails on its own branch. Sitting inside some range is not owning it: E-300 sits in
	// password's second range and, renumbered to 295, in session's, and a test that asks only
	// whether a range contains the number passes both ways round (E-159).
	it("keeps every decision inside a range reserved for the owner it names", () => {
		const ranges = reservedRanges();
		const misattributed = log
			.filter((entry) => entry.owner !== null)
			.filter((entry) => {
				const range = ranges.find((r) => entry.number >= r.first && entry.number <= r.last);
				return range === undefined || !ownersDeclaredBy(range.owner).includes(entry.owner ?? "");
			})
			.map((entry) => `${label(entry)} claims ${entry.owner}, which does not reserve it`);
		expect(misattributed).toEqual([]);
	});

	// A check that steps over what it cannot read reports success for it. This one says how many
	// entries it attributed and how many it could not, so neither number can drift unnoticed.
	it("counts the entries it cannot attribute, so none of them is skipped in silence", () => {
		const attributed = log.filter((entry) => entry.owner !== null);
		const unattributable = log.filter((entry) => entry.owner === null).map(label);

		expect(attributed.length).toBeGreaterThan(60);
		expect(attributed.length + unattributable.length).toBe(log.length);
		expect(unattributable).toHaveLength(ENTRIES_THAT_NAME_NO_OWNER);
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
