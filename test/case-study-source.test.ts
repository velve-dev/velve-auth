import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * `CASE-STUDY.md` quotes the forty-six decisions the specification started from out of the English
 * translation's section 7 (E-1970), and nothing compared the copy with its source (E-2906). An
 * entry here is its bold heading and every line up to the next blank line; the case study adds a
 * `*Where:*` line pointing into the tree, which the source cannot carry, and that line alone is
 * set aside before the two are compared. Every other entry of the case study is copied from
 * `docs/decisions/log.md` (§6 of the rules file), and is compared with the log's entry under the
 * same anchor, its `*Where:*` or `**Where.**` line set aside the same way.
 */
const ENTRY_HEADING = /^\*\*(E-\d{2}) — .*\*\*$/;
const WHERE_LINE = /^\*Where:\*/;
const BUILD_WHERE_LINE = /^(?:\*Where:\*|\*\*Where\.\*\*)/;
const ANCHOR = /^<a id="e-(\d+)"><\/a>$/;
const END_OF_ANCHORED_ENTRY = /^(?:<a id=|#{1,2} |---$)/;

function anchoredEntriesOf(markdown: string): Map<string, string> {
	const entries = new Map<string, string[]>();
	let current: string[] | undefined;
	for (const line of markdown.split("\n")) {
		const anchor = ANCHOR.exec(line);
		if (anchor !== null) {
			current = [];
			entries.set(`E-${String(anchor[1])}`, current);
		} else if (END_OF_ANCHORED_ENTRY.test(line)) {
			current = undefined;
		} else if (current !== undefined) {
			current.push(line);
		}
	}
	return new Map(
		[...entries].map(([id, lines]) => [
			id,
			lines
				.filter((line) => !BUILD_WHERE_LINE.test(line))
				.join("\n")
				.trim(),
		]),
	);
}

function entriesOf(markdown: string): Map<string, string[]> {
	const entries = new Map<string, string[]>();
	let current: string[] | undefined;
	for (const line of markdown.split("\n")) {
		const heading = ENTRY_HEADING.exec(line);
		if (heading !== null) {
			current = [line];
			entries.set(String(heading[1]), current);
		} else if (line.trim() === "") {
			current = undefined;
		} else if (current !== undefined) {
			current.push(line);
		}
	}
	return entries;
}

function sectionSevenOf(specification: string): string {
	const start = specification.indexOf("\n## 7. Decision log\n");
	if (start === -1) {
		throw new Error("VELVE-AUTH-ARCHITECTURE.md has no section 7 to compare against");
	}
	const end = specification.indexOf("\n## ", start + 1);
	return specification.slice(start, end === -1 ? undefined : end);
}

const source = entriesOf(
	sectionSevenOf(readFileSync(`${repositoryRoot}VELVE-AUTH-ARCHITECTURE.md`, "utf8")),
);
const ORIGINAL_DECISIONS = Array.from(
	{ length: 46 },
	(_, index) => `E-${String(index + 1).padStart(2, "0")}`,
);
const caseStudy = readFileSync(`${repositoryRoot}CASE-STUDY.md`, "utf8");
const log = anchoredEntriesOf(readFileSync(`${repositoryRoot}docs/decisions/log.md`, "utf8"));
const copiedFromLog = anchoredEntriesOf(caseStudy);
const BUILD_DECISIONS = [...copiedFromLog.keys()].filter((id) => !ORIGINAL_DECISIONS.includes(id));
const copy = entriesOf(caseStudy);

describe("the case study's copy of section 7", () => {
	it("finds all forty-six entries in the source and in the copy", () => {
		expect([...source.keys()]).toStrictEqual(ORIGINAL_DECISIONS);
		expect(ORIGINAL_DECISIONS.filter((id) => !copy.has(id))).toStrictEqual([]);
	});

	it.each(ORIGINAL_DECISIONS)("quotes %s as the translation states it", (id) => {
		const quoted = (copy.get(id) ?? []).filter((line) => !WHERE_LINE.test(line));

		expect(quoted).toStrictEqual(source.get(id));
	});

	it("sets aside a line only when it is a Where line", () => {
		const planted = entriesOf("**E-01 — A.**\n*Context:* x\n*Where:* y\n*Note:* z\n");

		expect((planted.get("E-01") ?? []).filter((line) => !WHERE_LINE.test(line))).toStrictEqual([
			"**E-01 — A.**",
			"*Context:* x",
			"*Note:* z",
		]);
	});
});

describe("the case study's copy of the log", () => {
	it("holds build entries beyond section 7", () => {
		expect(BUILD_DECISIONS.length).toBeGreaterThan(0);
	});

	it.each(BUILD_DECISIONS)("copies %s as the log states it", (id) => {
		expect(log.has(id)).toBe(true);
		expect(copiedFromLog.get(id)).toStrictEqual(log.get(id));
	});

	it("tells a copy changed by one word from its source", () => {
		const source = '<a id="e-100"></a>\n\n### A.\n**Context.** one\n\n## Next\n';
		const changed = source.replace("one", "two");

		expect(anchoredEntriesOf(changed).get("E-100")).not.toStrictEqual(
			anchoredEntriesOf(source).get("E-100"),
		);
	});

	it("sets aside a Where line in either form and nothing else", () => {
		const planted = anchoredEntriesOf(
			'<a id="e-100"></a>\n\n### A.\n**Context.** x\n\n*Where:* y\n\n**Where.** z\n\n**Price.** w\n',
		);

		expect(planted.get("E-100")).toBe("### A.\n**Context.** x\n\n\n\n**Price.** w");
	});
});
