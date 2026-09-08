import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const documentation = readFileSync(new URL("../DOCUMENTATION.md", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	exports: Record<string, { default: string } | string>;
};

const IMPORT_STATEMENT = /import\s*\{([^}]*)\}\s*from\s*"(@velve\/auth[^"]*)"/g;

interface DocumentedImport {
	readonly subpath: string;
	readonly names: readonly string[];
}

function documentedImports(): DocumentedImport[] {
	const found: DocumentedImport[] = [];
	for (const match of documentation.matchAll(IMPORT_STATEMENT)) {
		const names = (match[1] ?? "")
			.split(",")
			.map((name) => name.trim())
			.filter((name) => name !== "" && !name.startsWith("type "));
		found.push({ subpath: (match[2] ?? "").replace("@velve/auth", "."), names });
	}
	return found;
}

async function builtModule(subpath: string): Promise<Record<string, unknown>> {
	const target = manifest.exports[subpath === "." ? "." : subpath];
	if (typeof target !== "object") {
		throw new Error(`${subpath} is not a declared subpath`);
	}
	return (await import(new URL(target.default, new URL("../", import.meta.url)).href)) as Record<
		string,
		unknown
	>;
}

describe("every import the documentation shows", () => {
	it("finds import statements to check, so a passing run means something", () => {
		expect(documentedImports().length).toBeGreaterThan(2);
	});

	it("resolves against the built package", async () => {
		for (const documented of documentedImports()) {
			const built = await builtModule(documented.subpath);
			for (const name of documented.names) {
				expect({ subpath: documented.subpath, name, present: name in built }).toEqual({
					subpath: documented.subpath,
					name,
					present: true,
				});
			}
		}
	});
});
