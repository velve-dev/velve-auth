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

function declaredFiles(): readonly string[] {
	const manifest = JSON.parse(readFileSync(`${repositoryRoot}package.json`, "utf8")) as {
		files: readonly string[];
	};
	return manifest.files;
}

/**
 * npm reads a `files` entry as a path, a directory or a glob, so a name resolves if a packed path
 * is it, sits under it, or matches it as a pattern. `*` stops at a separator and `**` does not.
 * `?` is escaped rather than translated: the manifest has never carried one, and an entry using
 * it would be reported as resolving to nothing rather than quietly matching the wrong thing.
 */
function matchesPackedPath(entry: string, packedPath: string): boolean {
	if (packedPath === entry || packedPath.startsWith(`${entry}/`)) {
		return true;
	}
	const pattern = entry.replace(/\*\*|\*|[.+^${}()|[\]\\?]/g, (token) => {
		if (token === "**") {
			return ".*";
		}
		return token === "*" ? "[^/]*" : `\\${token}`;
	});
	return new RegExp(`^${pattern}$`).test(packedPath);
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

	/**
	 * `files` is the part of the manifest nothing here reads. A name in it that resolves to no
	 * file is invisible to the publish rehearsal, to `npm pack`, to `publint`, to `attw` and to
	 * every other case in this tier: all of them exit 0 and none prints the name (E-1436). The
	 * case above writes its expected list by hand on purpose and catches a name being **dropped**
	 * from `files`; this is the converse, which adding a name that matches nothing walks past
	 * because it adds nothing, removes nothing and leaves every existing assertion passing.
	 */
	it("resolves every name in files to at least one packed path", () => {
		const declared = declaredFiles();
		const unresolved = declared.filter(
			(entry) => !packed.some((path) => matchesPackedPath(entry, path)),
		);

		expect(declared.length).toBeGreaterThanOrEqual(7);
		expect(declared.filter((entry) => entry.startsWith("!"))).toStrictEqual([]);
		expect(unresolved).toStrictEqual([]);
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
