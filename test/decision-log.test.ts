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
interface EntryForm {
	readonly heading: RegExp;
	readonly read: (match: RegExpExecArray) => { number: number; title: string };
	readonly requiredParts: readonly string[];
}

/** The log moved to English headings partway through the build; entries written before
 * that were neither renumbered nor rewritten, so both forms have to be readable. */
const ENTRY_FORMS: readonly EntryForm[] = [
	{
		heading: /^\*\*E-(\d+) — (.+?)\*\*/gm,
		read: (match) => ({ number: Number(match[1]), title: String(match[2]) }),
		requiredParts: ["*Kontext:*", "*Verworfen:*", "*Grund:*", "*Preis:*"],
	},
	{
		heading: /^### (.+)\n`E-(\d+)` · /gm,
		read: (match) => ({ number: Number(match[2]), title: String(match[1]) }),
		requiredParts: ["**Context.**", "**Rejected.**", "**Reason.**", "**Price.**"],
	},
];

interface Entry {
	readonly number: number;
	readonly title: string;
	readonly body: string;
	readonly requiredParts: readonly string[];
}

function entries(): Entry[] {
	const headings = ENTRY_FORMS.flatMap((form) =>
		[...caseStudy.matchAll(form.heading)].map((match) => ({
			at: match.index,
			requiredParts: form.requiredParts,
			...form.read(match),
		})),
	).sort((one, other) => one.at - other.at);

	return headings.map((heading, position) => ({
		number: heading.number,
		title: heading.title,
		requiredParts: heading.requiredParts,
		body: caseStudy.slice(heading.at, headings[position + 1]?.at ?? caseStudy.length),
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
			const missing = entry.requiredParts.filter((part) => !entry.body.includes(part));
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
