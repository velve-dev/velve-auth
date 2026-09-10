import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { testFilesOtherThan, testSuiteCitations } from "./requirement-citations.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const specification = readFileSync(`${repositoryRoot}/VELVE-AUTH-ARCHITEKTUR.md`, "utf8");

const REQUIREMENTS_HEADING = "## 5. Sicherheitsanforderungen";
const TEST_PLAN_HEADING = "## 6. Prüfplan";
const DECISION_LOG_HEADING = "## 7. Entscheidungsprotokoll";

const REQUIREMENT_DEFINITION = /^- \*\*(S-[A-Z]+-\d+):\*\*/gm;
const TEST_CASE_ROW = /^\| (T-[A-Z]+-\d+) \| (S-[A-Z]+-\d+) \|/gm;

class UnreadableSpecificationError extends Error {
	constructor(what: string) {
		super(`cannot read the specification: ${what}`);
		this.name = "UnreadableSpecificationError";
	}
}

/**
 * A scan over the whole document would report the same emptiness for a renamed heading as for a
 * section that genuinely states nothing, so the bounds are looked up rather than assumed.
 */
function section(opening: string, closing: string): string {
	const start = specification.indexOf(opening);
	if (start < 0) {
		throw new UnreadableSpecificationError(`no heading reads ${opening}`);
	}
	const end = specification.indexOf(closing, start);
	if (end < 0) {
		throw new UnreadableSpecificationError(`no heading reads ${closing} after ${opening}`);
	}
	return specification.slice(start, end);
}

function statedRequirements(): string[] {
	const body = section(REQUIREMENTS_HEADING, TEST_PLAN_HEADING);
	const stated = [...body.matchAll(REQUIREMENT_DEFINITION)].map((match) => String(match[1]));
	if (stated.length === 0) {
		throw new UnreadableSpecificationError(`${REQUIREMENTS_HEADING} states no requirement`);
	}
	return [...new Set(stated)].sort();
}

function requirementsWithATestCase(): string[] {
	const body = section(TEST_PLAN_HEADING, DECISION_LOG_HEADING);
	const covered = [...body.matchAll(TEST_CASE_ROW)].map((match) => String(match[2]));
	if (covered.length === 0) {
		throw new UnreadableSpecificationError(`${TEST_PLAN_HEADING} names no test case`);
	}
	return [...new Set(covered)].sort();
}

/**
 * A requirement no test file so much as names, with the reason it is not named. The list is exact:
 * a requirement that gains a citation fails here until its line is removed, so a reason cannot
 * outlive the state it describes. A line here is a reported finding, never a permission.
 */
const NAMED_BY_NO_TEST: ReadonlyMap<string, string> = new Map([
	[
		"S-REDIR-1",
		"T-REDIR-1 counts redirect-carrying fields of the route declarations that are typed `string` and requires zero. The requirement itself is met: `acceptedRedirectPath` refuses a URL at run time and `test/oauth-redirect-corpus.test.ts` drives a corpus at it. A typing that satisfies the census and 3.15 B.1 at once exists and was built: unbranding `RedirectPath` inside `ServerMethodOf` and `ClientMethodOf`, after which the declaration resolves to `Validator<RedirectPath | undefined>` and the method parameter resolves to `string`. What excludes it is 3.15 D.2, which allows exactly one difference between a route declaration and its signatures and gives `caller` as the one that makes it; the unbranding introduces a second, across the whole surface. That reading of D.2 is a ruling on German prose and not an `S-` requirement, and if it is wrong the case can be met by that shape. Reported rather than built (E-1335, E-1337).",
	],
]);

describe("every requirement of section 5 has a test case in section 6", () => {
	it("states a requirement and a test case for each other, and neither without the other", () => {
		const stated = statedRequirements();
		const tested = requirementsWithATestCase();

		expect(tested).toEqual(stated);
	});

	it("refuses to answer when the requirements section cannot be found", () => {
		expect(() => section("## 5. Something Else Entirely", TEST_PLAN_HEADING)).toThrow(
			UnreadableSpecificationError,
		);
	});
});

describe("no requirement of section 5 goes unnamed by the test suite", () => {
	it("reads citations out of more than one test file, so an empty result is a finding", () => {
		const files = testFilesOtherThan(import.meta.url);
		const citations = testSuiteCitations(files);

		expect(files.length).toBeGreaterThan(1);
		expect(citations.size).toBeGreaterThan(1);
	});

	it("names every requirement except the ones listed here with a reason", () => {
		const stated = statedRequirements();
		const cited = testSuiteCitations(testFilesOtherThan(import.meta.url));
		const unnamed = stated.filter((requirement) => !cited.has(requirement));

		expect(unnamed).toEqual([...NAMED_BY_NO_TEST.keys()].sort());
	});

	it("lists no requirement that a test does name, so a stale reason cannot survive", () => {
		const cited = testSuiteCitations(testFilesOtherThan(import.meta.url));
		const stale = [...NAMED_BY_NO_TEST.keys()].filter((requirement) => cited.has(requirement));

		expect(stale).toEqual([]);
	});

	it("gives every listed requirement a reason and lists nothing section 5 does not state", () => {
		const stated = new Set(statedRequirements());
		const listed = [...NAMED_BY_NO_TEST];

		expect(listed.filter(([, reason]) => reason.trim() === "")).toEqual([]);
		expect(listed.filter(([requirement]) => !stated.has(requirement)).map(([id]) => id)).toEqual(
			[],
		);
	});
});
