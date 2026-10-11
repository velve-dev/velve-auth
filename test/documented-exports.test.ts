import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const manifest = JSON.parse(readFileSync(`${repositoryRoot}package.json`, "utf8")) as {
	exports: Record<string, string | { types?: string }>;
};

/**
 * Section 6 of the rules asks DOCUMENTATION.md to cover every exported name, and twenty-four were
 * missing before anything checked it (E-2904). A name counts as documented when it stands as a
 * whole word inside a code span or a fenced block, because prose that happens to contain the word
 * `User` documents nothing.
 */
const documentation = readFileSync(`${repositoryRoot}DOCUMENTATION.md`, "utf8");

const FENCED_BLOCK = /^```[^\n]*\n([\s\S]*?)^```$/gm;
const INLINE_SPAN = /(`+)([\s\S]+?)(?<!`)\1(?!`)/g;
const PARAGRAPH_BREAK = /\n\s*\n/;

//a code span may wrap a line but never a paragraph, so one stray backtick cannot pair across the file
function codeTextOf(markdown: string): string {
	const fenced = [...markdown.matchAll(FENCED_BLOCK)].map((match) => String(match[1]));
	const inline = markdown
		.replace(FENCED_BLOCK, "\n\n")
		.split(PARAGRAPH_BREAK)
		.flatMap((paragraph) => [...paragraph.matchAll(INLINE_SPAN)].map((match) => String(match[2])));
	return [...fenced, ...inline].join("\n");
}

const documentedCode = codeTextOf(documentation);

function isDocumented(name: string): boolean {
	return new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(documentedCode);
}

/**
 * The instance's namespace types were held back for a change that was to document them in the
 * same round. No branch carries that change, and the namespaces have since gained
 * `resolveFromHeaders` and `findByUsername`, so nothing is held back any more.
 */
const DOCUMENTED_ELSEWHERE_IN_FLIGHT: readonly string[] = [];

function declarationFilesOfEveryEntryPoint(): string[] {
	return Object.values(manifest.exports)
		.map((target) => (typeof target === "string" ? undefined : target.types))
		.filter((types): types is string => types !== undefined)
		.map((types) => `${repositoryRoot}${types.replace(/^\.\//, "")}`);
}

function exportedNames(): Map<string, string[]> {
	const files = declarationFilesOfEveryEntryPoint();
	const missing = files.filter((file) => !existsSync(file));
	if (missing.length > 0) {
		throw new Error(
			`cannot read the shipped declarations, run pnpm build first: ${missing.join(", ")}`,
		);
	}
	const program = ts.createProgram(files, {
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		noEmit: true,
	});
	const checker = program.getTypeChecker();
	const names = new Map<string, string[]>();
	for (const file of files) {
		const source = program.getSourceFile(file);
		const module = source === undefined ? undefined : checker.getSymbolAtLocation(source);
		names.set(
			file.slice(repositoryRoot.length),
			module === undefined ? [] : checker.getExportsOfModule(module).map((symbol) => symbol.name),
		);
	}
	return names;
}

const namesByEntryPoint = exportedNames();

describe("every exported name is in DOCUMENTATION.md", () => {
	it("reads names from the shipped declarations", () => {
		expect(namesByEntryPoint.get("dist/index.d.mts")?.length ?? 0).toBeGreaterThan(50);
	});

	it.each([...namesByEntryPoint])("%s", (_file, names) => {
		const undocumented = names.filter(
			(name) => !isDocumented(name) && !DOCUMENTED_ELSEWHERE_IN_FLIGHT.includes(name),
		);

		expect(undocumented).toStrictEqual([]);
	});

	it("holds back only names that are still undocumented", () => {
		expect(DOCUMENTED_ELSEWHERE_IN_FLIGHT.filter(isDocumented)).toStrictEqual([]);
	});

	it("does not count a name that appears only in prose", () => {
		expect(codeTextOf("The User signs in.\n")).not.toContain("User");
		expect(codeTextOf("The `User` signs in.\n")).toContain("User");
		expect(codeTextOf("```ts\ntype User = {}\n```\n")).toContain("User");
	});
});
