import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const netDirectory = fileURLToPath(new URL("../src/core/net", import.meta.url));

function sourceFilesUnder(directory: string): readonly string[] {
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => `${entry.parentPath}/${entry.name}`)
		.sort();
}

/** Prose about an import is not an import, and these files carry specification references. */
function withoutComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

const REACHES_OUTSIDE = [
	/^[ \t]*import\b/m,
	/^[ \t]*export\b[^;]*\bfrom\b/m,
	/\bimport[ \t]*\(/,
	/\brequire[ \t]*\(/,
];

const netSources = sourceFilesUnder(netDirectory).map((path) => ({
	path: path.slice(netDirectory.length + 1),
	code: withoutComments(readFileSync(path, "utf8")),
}));

describe("core/net imports nothing (E-500)", () => {
	it("has files to scan, so a silent zero cannot pass for a clean result", () => {
		expect(netSources.length).toBeGreaterThan(0);
	});

	it("reaches out of the module in no file", () => {
		const reaching = netSources
			.filter((source) => REACHES_OUTSIDE.some((pattern) => pattern.test(source.code)))
			.map((source) => source.path);

		expect(reaching).toEqual([]);
	});
});
