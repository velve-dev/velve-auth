import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

//the map of the ways into an account is one list written three times and these checks keep the three equal (E-3873)

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

interface Guard {
	readonly guard: string;
	readonly requirement: string | null;
	readonly enforcedIn: string;
	readonly legitimateTest: string | null;
	readonly attackTest: string | null;
}

interface WayIn {
	readonly id: string;
	readonly title: string;
	readonly guards: readonly Guard[];
}

interface MapSection {
	readonly heading: string;
	readonly none: readonly string[];
}

const GERMAN: MapSection = { heading: "### 5.22 ", none: ["— keine —", "— keiner —"] };
const ENGLISH: MapSection = { heading: "### 5.22 ", none: ["— none —"] };

const wayIns: readonly WayIn[] = JSON.parse(
	readFileSync(`${repositoryRoot}/test/attacks/map.json`, "utf8"),
);
const german = readFileSync(`${repositoryRoot}/VELVE-AUTH-ARCHITEKTUR.md`, "utf8");
const english = readFileSync(`${repositoryRoot}/VELVE-AUTH-ARCHITECTURE.md`, "utf8");

class UnreadableMapError extends Error {
	constructor(what: string) {
		super(`cannot read the map: ${what}`);
		this.name = "UnreadableMapError";
	}
}

function mapSectionOf(specification: string, section: MapSection): string {
	const start = specification.indexOf(`\n${section.heading}`);
	if (start < 0) {
		throw new UnreadableMapError(`no heading reads ${section.heading}`);
	}
	const end = specification.indexOf("\n## 6.", start);
	if (end < 0) {
		throw new UnreadableMapError(`no section 6 follows ${section.heading}`);
	}
	return specification.slice(start, end);
}

interface TableRow {
	readonly guard: string;
	readonly requirement: string | null;
	readonly enforcedIn: string;
	readonly legitimateTest: string | null;
	readonly attackTest: string | null;
}

function unquoted(cell: string, none: readonly string[]): string | null {
	if (none.includes(cell)) {
		return null;
	}
	return /^`[^`]+`$/.test(cell) ? cell.slice(1, -1) : cell;
}

/** every way the section names, with the rows of the table under its heading */
function waysInOf(text: string, none: readonly string[]): Map<string, TableRow[]> {
	const ways = new Map<string, TableRow[]>();
	let current: TableRow[] | null = null;
	for (const line of text.split("\n")) {
		const heading = /^#### `(W-[A-Z0-9-]+)`/.exec(line);
		if (heading !== null) {
			current = [];
			ways.set(String(heading[1]), current);
			continue;
		}
		if (current === null || !line.startsWith("| ") || line.startsWith("|---")) {
			continue;
		}
		const cells = line
			.slice(2, -2)
			.split(" | ")
			.map((cell) => cell.trim());
		if (cells.length !== 5 || !/^`src\//.test(String(cells[2]))) {
			continue;
		}
		const [guard = "", requirement = "", enforcedIn = "", legitimate = "", attack = ""] = cells;
		current.push({
			guard,
			requirement: unquoted(requirement, none),
			enforcedIn: unquoted(enforcedIn, none) ?? "",
			legitimateTest: unquoted(legitimate, none),
			attackTest: unquoted(attack, none),
		});
	}
	return ways;
}

function declaresFunction(source: string, name: string): boolean {
	return new RegExp(
		`function\\*?\\s+${name}\\b|(?:const|let)\\s+${name}\\s*=|^[\\t ]*(?:async[\\t ]+)?${name}[\\t ]*\\(|\\b${name}\\s*:\\s*(?:async\\s*)?\\(`,
		"m",
	).test(source);
}

/** every enforcement point that names no file of the tree or no function declared in it */
function unenforced(ways: readonly WayIn[], root: string): string[] {
	return ways.flatMap((way) =>
		way.guards.flatMap((guard) => {
			const [file = "", name = ""] = guard.enforcedIn.split(":");
			const path = `${root}/${file}`;
			if (name === "" || !existsSync(path)) {
				return [`${way.id}: ${guard.enforcedIn}`];
			}
			return declaresFunction(readFileSync(path, "utf8"), name)
				? []
				: [`${way.id}: ${guard.enforcedIn}`];
		}),
	);
}

/** every requirement a guard cites that the German specification does not define */
function undefinedRequirements(ways: readonly WayIn[], specification: string): string[] {
	const defined = new Set([
		...[...specification.matchAll(/^- \*\*(S-[A-Z]+-\d+):\*\*/gm)].map((match) => String(match[1])),
		...[...specification.matchAll(/^\*\*([LO]-\d+) — /gm)].map((match) => String(match[1])),
	]);
	return ways.flatMap((way) =>
		way.guards
			.filter((guard) => guard.requirement !== null && !defined.has(guard.requirement))
			.map((guard) => `${way.id}: ${guard.requirement}`),
	);
}

function missingTestFiles(ways: readonly WayIn[], root: string): string[] {
	return ways.flatMap((way) =>
		way.guards
			.flatMap((guard) => [guard.legitimateTest, guard.attackTest])
			.filter((test): test is string => test !== null && !existsSync(`${root}/${test}`))
			.map((test) => `${way.id}: ${test}`),
	);
}

function rowsOfTheJson(way: WayIn, withGuardText: boolean): TableRow[] {
	return way.guards.map((guard) => ({
		guard: withGuardText ? guard.guard : "",
		requirement: guard.requirement,
		enforcedIn: guard.enforcedIn,
		legitimateTest: guard.legitimateTest,
		attackTest: guard.attackTest,
	}));
}

function withoutGuardText(rows: readonly TableRow[]): TableRow[] {
	return rows.map((row) => ({ ...row, guard: "" }));
}

describe("the map of the ways into an account", () => {
	const inGerman = waysInOf(mapSectionOf(german, GERMAN), GERMAN.none);
	const inEnglish = waysInOf(mapSectionOf(english, ENGLISH), ENGLISH.none);

	it("names more than one way in every one of its three copies, so an empty comparison is a finding", () => {
		expect(wayIns.length).toBeGreaterThan(1);
		expect(inGerman.size).toBeGreaterThan(1);
		expect(inEnglish.size).toBeGreaterThan(1);
	});

	it("names the same ways in the same order in map.json and in both specification files", () => {
		const ids = wayIns.map((way) => way.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect([...inGerman.keys()]).toStrictEqual(ids);
		expect([...inEnglish.keys()]).toStrictEqual(ids);
	});

	it("carries every guard of map.json as a row of the English table, word for word", () => {
		for (const way of wayIns) {
			expect(inEnglish.get(way.id), way.id).toStrictEqual(rowsOfTheJson(way, true));
		}
	});

	it("carries every guard of map.json as a row of the German table, translated", () => {
		for (const way of wayIns) {
			expect(withoutGuardText(inGerman.get(way.id) ?? []), way.id).toStrictEqual(
				rowsOfTheJson(way, false),
			);
		}
	});

	it("names for every guard a file of the tree and a function declared in it", () => {
		expect(unenforced(wayIns, repositoryRoot)).toStrictEqual([]);
	});

	it("cites only requirements, decided gaps and open gaps the German specification defines", () => {
		expect(undefinedRequirements(wayIns, german)).toStrictEqual([]);
	});

	it("names only test files that exist", () => {
		expect(missingTestFiles(wayIns, repositoryRoot)).toStrictEqual([]);
	});
});

describe("the checks above find a planted fault", () => {
	const planted: WayIn = {
		id: "W-PLANTED",
		title: "a planted way",
		guards: [
			{
				guard: "a planted guard",
				requirement: "S-PLANTED-1",
				enforcedIn: "src/core/http/pipeline.ts:aFunctionNobodyWrote",
				legitimateTest: "test/a-test-nobody-wrote.test.ts",
				attackTest: null,
			},
		],
	};

	it("reports a function the named file does not declare, and a file the tree does not hold", () => {
		const elsewhere: WayIn = {
			...planted,
			guards: [{ ...(planted.guards[0] as Guard), enforcedIn: "src/core/nowhere.ts:runRoute" }],
		};
		expect(unenforced([planted, elsewhere], repositoryRoot)).toHaveLength(2);
	});

	it("does not report a function the named file declares", () => {
		const declared: WayIn = {
			...planted,
			guards: [
				{ ...(planted.guards[0] as Guard), enforcedIn: "src/core/http/pipeline.ts:runRoute" },
			],
		};
		expect(unenforced([declared], repositoryRoot)).toStrictEqual([]);
	});

	it("reports a requirement the specification does not define", () => {
		expect(undefinedRequirements([planted], german)).toStrictEqual(["W-PLANTED: S-PLANTED-1"]);
	});

	it("reports a test file that does not exist", () => {
		expect(missingTestFiles([planted], repositoryRoot)).toStrictEqual([
			"W-PLANTED: test/a-test-nobody-wrote.test.ts",
		]);
	});

	it("tells a way the specification drops from one it keeps", () => {
		const dropped = mapSectionOf(english, ENGLISH).replace(/^#### `W-EVERY-ROUTE`.*$/m, "");
		expect([...waysInOf(dropped, ENGLISH.none).keys()]).not.toContain("W-EVERY-ROUTE");
	});

	it("refuses to answer when the section cannot be found", () => {
		expect(() => mapSectionOf("# no map here\n## 6. Test plan\n", ENGLISH)).toThrow(
			UnreadableMapError,
		);
	});
});
