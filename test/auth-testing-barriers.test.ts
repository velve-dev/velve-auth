import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestClock } from "../src/testing/index.js";

const coreDirectory = fileURLToPath(new URL("../src/core", import.meta.url));
const distDirectory = fileURLToPath(new URL("../dist", import.meta.url));
const testingSource = fileURLToPath(new URL("../src/testing/index.ts", import.meta.url));

/** The subpath 3.1 gives its own entry point, and the only artefact allowed to carry these names. */
const TESTING_ARTEFACT = "testing.mjs";

function filesUnder(directory: string, extension: string): readonly string[] {
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(extension))
		.map((entry) => `${entry.parentPath}/${entry.name}`)
		.sort();
}

function namesExportedByTheTestingSubpath(): readonly string[] {
	const source = readFileSync(testingSource, "utf8");
	return [...source.matchAll(/^export (?:interface|function|const|class|type) (\w+)/gm)].map(
		(match) => String(match[1]),
	);
}

describe("barrier 1: the core never imports the testing subpath (6.19)", () => {
	it("finds zero imports of `testing` in src/core, over a set that is not empty", () => {
		const sources = filesUnder(coreDirectory, ".ts");
		const importing = sources.filter((path) =>
			/from\s+["'][^"']*\/testing(\/[^"']*)?(\.js)?["']|import\s*\(\s*["'][^"']*\/testing/.test(
				readFileSync(path, "utf8"),
			),
		);

		expect(sources.length).toBeGreaterThanOrEqual(50);
		expect(importing).toStrictEqual([]);
	});
});

describe("barrier 3: no shipped artefact but the testing one carries a testing name (6.19)", () => {
	/**
	 * 6.19 names `dist/index.js` and one setter; the package ships `.mjs` (E-04), `unbundle: true`
	 * splits an entry point across files, and the setter that check was written for does not exist
	 * yet — see the hand-off in the case study. The threshold that does hold today is the wider one:
	 * every name this subpath exports, over every shipped artefact.
	 */
	it("finds each testing name in the testing artefact and in no other", () => {
		const artefacts = filesUnder(distDirectory, ".mjs");
		const names = namesExportedByTheTestingSubpath();

		const leaked = names.flatMap((name) =>
			artefacts
				.filter((path) => !path.endsWith(TESTING_ARTEFACT))
				.filter((path) => readFileSync(path, "utf8").includes(name))
				.map((path) => `${name} in ${path.slice(distDirectory.length + 1)}`),
		);
		const carried = names.filter((name) =>
			readFileSync(`${distDirectory}/${TESTING_ARTEFACT}`, "utf8").includes(name),
		);

		expect(artefacts.length).toBeGreaterThanOrEqual(9);
		expect(names.length).toBeGreaterThanOrEqual(2);
		expect(leaked).toStrictEqual([]);
		expect(carried).toStrictEqual(names);
	});
});

describe("the settable clock (6.19)", () => {
	it("answers the instant it was set to and moves only when it is moved", () => {
		const clock = createTestClock(new Date("2026-03-01T12:00:00.000Z"));

		const start = clock.now();
		clock.advanceBy(90_000);
		const later = clock.now();
		clock.set(new Date("2020-01-01T00:00:00.000Z"));

		expect(start.toISOString()).toBe("2026-03-01T12:00:00.000Z");
		expect(later.getTime() - start.getTime()).toBe(90_000);
		expect(clock.now().toISOString()).toBe("2020-01-01T00:00:00.000Z");
	});

	it("hands out a copy, so a caller cannot move it by mutating the answer", () => {
		const clock = createTestClock(new Date("2026-03-01T12:00:00.000Z"));

		clock.now().setFullYear(1999);

		expect(clock.now().toISOString()).toBe("2026-03-01T12:00:00.000Z");
	});

	it("starts at a fixed instant when it is given none, so a test that forgets is still deterministic", () => {
		expect(createTestClock().now().toISOString()).toBe(createTestClock().now().toISOString());
	});
});
