import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

/** every line comment of a source file with more than one cited identifier, as path and line */
function commentsCitingMoreThanOne(path: string, text: string): string[] {
	return text.split("\n").flatMap((line, index) => {
		const comment = /^\s*\/\/(.*)$/.exec(line)?.[1] ?? "";
		const cited = comment.match(/\b[SE]-[A-Z0-9]+(?:-\d+)?\b/g) ?? [];
		return cited.length > 1 ? [`${path}:${index + 1}: ${line.trim()}`] : [];
	});
}

it("cites at most one identifier in every line comment under src (CLAUDE.md section 3)", () => {
	const files = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => `${entry.parentPath}/${entry.name}`);
	const offenders = files.flatMap((path) =>
		commentsCitingMoreThanOne(path.replace(`${sourceRoot}/`, ""), readFileSync(path, "utf8")),
	);

	expect(files.length).toBeGreaterThan(100);
	expect(offenders).toStrictEqual([]);
});

it("finds a planted comment that cites two identifiers", () => {
	expect(
		commentsCitingMoreThanOne("planted.ts", "\t//a planted reason (S-INTEG-1, E-3123)\n"),
	).toHaveLength(1);
});
