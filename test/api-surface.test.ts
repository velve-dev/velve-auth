import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distDirectory = fileURLToPath(new URL("../dist", import.meta.url));

const EXPORT_LIST = /^(export \{)([^}]*)(\};)$/gm;
const MEMBER_LINE = /^(\s+)(?:readonly )?(?:\[[^\]]+\]|[A-Za-z_$][\w$]*)\??: .*;$/;
const STRING_LITERAL_UNION = /"[^"\\]*"(?: \| "[^"\\]*")+/g;

class UnreadableDistributionError extends Error {
	constructor(what: string) {
		super(`cannot read the shipped declarations: ${what}`);
		this.name = "UnreadableDistributionError";
	}
}

/**
 * The whole export list arrives on one physical line, so three features each adding a name meet in
 * one three-way conflict resolvable only by regenerating. One name per line makes their additions
 * disjoint hunks (E-776).
 */
function oneExportPerLine(body: string): string {
	return body.replace(EXPORT_LIST, (_whole, open: string, names: string, close: string) => {
		const listed = names
			.split(",")
			.map((name) => name.trim())
			.filter((name) => name !== "");
		return `${open}\n${listed.map((name) => `\t${name},`).join("\n")}\n${close}`;
	});
}

/**
 * Two orderings the build does not hold fixed, measured over sixteen clean builds of an unchanged
 * tree: the members of an inferred object type, and the constituents of a union of string literals
 * (E-1377). Neither is API, and sorting them hides a reordering and nothing else — a member or a
 * constituent added, removed or retyped still moves the line it is on.
 */
function inTheOrderTheBuildDoesNotDecide(body: string): string {
	const sortedUnions = body.replace(STRING_LITERAL_UNION, (union) =>
		union.split(" | ").sort().join(" | "),
	);
	const lines = sortedUnions.split("\n");
	const normalised: string[] = [];
	let run: string[] = [];
	let indent: string | null = null;
	const flushRun = () => {
		normalised.push(...run.toSorted());
		run = [];
		indent = null;
	};
	for (const line of lines) {
		const member = MEMBER_LINE.exec(line);
		if (member === null) {
			flushRun();
			normalised.push(line);
			continue;
		}
		if (indent !== null && String(member[1]) !== indent) {
			flushRun();
		}
		indent = String(member[1]);
		run.push(line);
	}
	flushRun();
	return normalised.join("\n");
}

function declarationFilesUnder(directory: string): readonly string[] {
	if (!existsSync(directory)) {
		throw new UnreadableDistributionError(`${directory} is missing — run \`pnpm build\` first`);
	}
	const declarations = readdirSync(directory, { recursive: true, encoding: "utf8" })
		.filter((file) => file.endsWith(".d.mts"))
		.map((file) => file.replaceAll("\\", "/"))
		.sort();
	if (declarations.length === 0) {
		throw new UnreadableDistributionError(`${directory} holds no declaration file`);
	}
	return declarations;
}

function readPublicSurface(): string {
	return declarationFilesUnder(distDirectory)
		.map((file) => {
			const shipped = readFileSync(`${distDirectory}/${file}`, "utf8").trimEnd();
			const body = inTheOrderTheBuildDoesNotDecide(oneExportPerLine(shipped));
			return `## ${file}\n\n${body === "" ? "(empty)" : body}`;
		})
		.join("\n\n");
}

describe("public API surface", () => {
	/**
	 * What this does not catch.
	 *
	 * It compares the shipped declarations against a recorded copy, and re-recording is one
	 * command. So it reports a change nobody wrote down, and never a change that is unwise — what
	 * it buys is the announcement, not the refusal.
	 *
	 * It reads `dist/`, so it is a statement about the last build. `pnpm test` rebuilds first and
	 * `pnpm api` does not, so run alone it can compare a stale tree and pass.
	 *
	 * Every one of these files is on the type-resolution path of a published entry point, but not
	 * every declaration in them is reachable from one: a module-level export that no entry
	 * re-exports is recorded here too, so the step reddens for changes that are not changes to the
	 * public surface.
	 *
	 * It says nothing about `dist/*.mjs`. A behaviour change under an unchanged type is invisible.
	 */
	it("matches the committed snapshot", async () => {
		await expect(readPublicSurface()).toMatchFileSnapshot("./__snapshots__/api-surface.md");
	});

	/**
	 * The fault this file was blind to until E-1376: `readdirSync` without `recursive` read the nine
	 * barrels and none of the seventy files the members of a published type live in, so a field
	 * added to an exported class moved nothing here.
	 */
	it("reads the declarations below the top level, not only the entry points", () => {
		const files = declarationFilesUnder(distDirectory);
		const nested = files.filter((file) => file.includes("/"));

		expect(files.filter((file) => !file.includes("/")).length).toBeGreaterThan(1);
		expect(nested.length).toBeGreaterThan(1);
		expect(nested).toContain("core/auth/startup.d.mts");
	});

	it("refuses to answer where the directory it was pointed at is not there", () => {
		expect(() => declarationFilesUnder(`${distDirectory}/no-such-directory`)).toThrow(
			UnreadableDistributionError,
		);
	});

	it("refuses to answer where the directory it was pointed at declares nothing", () => {
		expect(() =>
			declarationFilesUnder(fileURLToPath(new URL("./fixtures", import.meta.url))),
		).toThrow(UnreadableDistributionError);
	});

	it("holds the two orderings the build does not decide, and nothing else", () => {
		const oneWay = 'interface A {\n  b: "x" | "y";\n  a: string;\n}\n';
		const theOther = 'interface A {\n  a: string;\n  b: "y" | "x";\n}\n';
		const added = 'interface A {\n  a: string;\n  b: "y" | "x";\n  c: number;\n}\n';

		expect(inTheOrderTheBuildDoesNotDecide(oneWay)).toBe(inTheOrderTheBuildDoesNotDecide(theOther));
		expect(inTheOrderTheBuildDoesNotDecide(added)).not.toBe(
			inTheOrderTheBuildDoesNotDecide(theOther),
		);
	});
});
