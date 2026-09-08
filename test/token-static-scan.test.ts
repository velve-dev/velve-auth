import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const coreDirectory = fileURLToPath(new URL("../src/core", import.meta.url));

interface Source {
	readonly path: string;
	readonly text: string;
}

function coreSources(): readonly Source[] {
	return readdirSync(coreDirectory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => `${entry.parentPath}/${entry.name}`)
		.sort()
		.map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

const sources = coreSources();

function withoutComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function pathsMatching(pattern: RegExp): readonly string[] {
	return sources
		.filter((source) => pattern.test(withoutComments(source.text)))
		.map((source) => source.path);
}

describe("the CSPRNG has exactly one caller in the core (S-RAND-5)", () => {
	it("has more than nothing to scan", () => {
		expect(sources.length).toBeGreaterThan(20);
	});

	it("calls crypto.getRandomValues only in core/token/random.ts", () => {
		expect(pathsMatching(/getRandomValues/)).toStrictEqual([`${coreDirectory}/token/random.ts`]);
	});
});
