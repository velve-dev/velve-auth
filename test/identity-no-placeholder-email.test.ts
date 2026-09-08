import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

/** `<id>@<ns>.placeholder.invalid` is the shape the prior art writes into its user table (E-16). */
const RESERVED_DOMAIN = /\.(?:invalid|placeholder)\b/;
const ADDRESS_FROM_TEMPLATE = /email\w*\s*[:=]\s*`[^`]*@/i;
const ADDRESS_FROM_CONCATENATION = /\+\s*["'`]@|@["'`]\s*\+/;

const PATTERNS: Readonly<Record<string, RegExp>> = {
	"reserved domain": RESERVED_DOMAIN,
	"address built in a template literal": ADDRESS_FROM_TEMPLATE,
	"address built by concatenation": ADDRESS_FROM_CONCATENATION,
};

const PLANTED: Readonly<Record<string, string>> = {
	"reserved domain": 'const address = subject + ".placeholder.invalid";',
	"address built in a template literal": "const email = `alice@example.test`;",
	"address built by concatenation": 'const address = subject + "@" + provider;',
};

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = `${directory}/${entry.name}`;
		if (entry.isDirectory()) {
			return sourceFiles(path);
		}
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

describe("no address is ever invented (E-16, S-LINK-5)", () => {
	const files = sourceFiles(sourceRoot);

	it("has source to scan", () => {
		expect(files.length).toBeGreaterThan(20);
	});

	it("recognises each fabrication it is looking for", () => {
		const missed = Object.entries(PATTERNS).filter(
			([name, pattern]) => !pattern.test(PLANTED[name] ?? ""),
		);
		expect(missed.map(([name]) => name)).toEqual([]);
	});

	it("finds none of them in the library", () => {
		const found = files.flatMap((path) => {
			const contents = readFileSync(path, "utf8");
			return Object.entries(PATTERNS)
				.filter(([, pattern]) => pattern.test(contents))
				.map(([name]) => `${path.slice(sourceRoot.length + 1)} contains an ${name}`);
		});
		expect(found).toEqual([]);
	});
});
