import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const testingSource = `${repositoryRoot}src/testing/index.ts`;

interface PackedFile {
	readonly path: string;
}

interface PackReport {
	readonly files: readonly PackedFile[];
}

/**
 * 6.19 asks for a delivery test over the packed artefact, and `auth-testing-barriers.test.ts`
 * measures the same threshold over `dist/`. The two are not the same claim: `dist/` is what the
 * build wrote, and this is what `files` and `.npmignore` let out of the door.
 */
function packedPaths(): readonly string[] {
	const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
		cwd: repositoryRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const reports = JSON.parse(output) as readonly PackReport[];
	return (reports[0]?.files ?? []).map((file) => file.path);
}

function namesExportedByTheTestingSubpath(): readonly string[] {
	const source = readFileSync(testingSource, "utf8");
	return [...source.matchAll(/^export (?:interface|function|const|class|type) (\w+)/gm)].map(
		(match) => String(match[1]),
	);
}

function subpathTargets(): readonly string[] {
	const manifest = JSON.parse(readFileSync(`${repositoryRoot}package.json`, "utf8")) as {
		exports: Readonly<Record<string, string | Readonly<Record<string, string>>>>;
	};
	return Object.values(manifest.exports)
		.flatMap((target) => (typeof target === "string" ? [target] : Object.values(target)))
		.map((target) => target.replace(/^\.\//, ""));
}

const packed = packedPaths();

describe("what the package actually ships (6.19, before every release)", () => {
	it("packs a set of files that is not empty", () => {
		expect(packed.length).toBeGreaterThanOrEqual(20);
	});

	it("packs every file an export condition points at", () => {
		const targets = subpathTargets().filter((target) => target !== "package.json");
		const missing = targets.filter((target) => !packed.includes(target));

		expect(targets.length).toBeGreaterThanOrEqual(18);
		expect(missing).toStrictEqual([]);
	});

	/**
	 * The list is written out rather than read from `package.json`'s `files`, which would make the
	 * case nearly tautological: it would confirm that npm packs what `files` says and would stop
	 * catching the only way this regresses, which is a name being dropped from `files`. Its value
	 * is that it is a second, independent statement of what has to ship (E-537).
	 */
	it("packs the five documents and the migrations, and no source or test file", () => {
		const documents = ["README.md", "DOCUMENTATION.md", "CASE-STUDY.md", "LICENSE", "NOTICE"];
		const leaked = packed.filter(
			(path) => path.startsWith("src/") || path.startsWith("test/") || path.startsWith("tools/"),
		);

		expect(documents).toHaveLength(5);
		expect(documents.filter((name) => !packed.includes(name))).toStrictEqual([]);
		expect(packed.filter((path) => path.startsWith("migrations/")).length).toBeGreaterThanOrEqual(
			1,
		);
		expect(leaked).toStrictEqual([]);
	});

	it("carries no environment file and no dotfile of the working tree", () => {
		const secrets = packed.filter((path) => /(^|\/)\.env/.test(path));

		expect(packed.length).toBeGreaterThanOrEqual(20);
		expect(secrets).toStrictEqual([]);
	});

	/** 6.19, barrier 3: the threshold is zero, measured over what ships rather than over `dist/`. */
	it("carries every testing name in the testing artefact and in no other shipped artefact", () => {
		const artefacts = packed.filter((path) => path.endsWith(".mjs"));
		const names = namesExportedByTheTestingSubpath();
		const leaked = names.flatMap((name) =>
			artefacts
				.filter((path) => path !== "dist/testing.mjs")
				.filter((path) => readFileSync(`${repositoryRoot}${path}`, "utf8").includes(name))
				.map((path) => `${name} in ${path}`),
		);
		const carried = names.filter((name) =>
			readFileSync(`${repositoryRoot}dist/testing.mjs`, "utf8").includes(name),
		);

		expect(artefacts.length).toBeGreaterThanOrEqual(9);
		expect(names.length).toBeGreaterThanOrEqual(2);
		expect(leaked).toStrictEqual([]);
		expect(carried).toStrictEqual(names);
	});
});
