import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VELVE_AUTH_VERSION } from "../src/index.js";

type ExportTarget = string | { types: string; default: string };

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	name: string;
	version: string;
	type: string;
	files: string[];
	exports: Record<string, ExportTarget>;
};

const subpathExports = Object.entries(manifest.exports).filter(
	([subpath]) => subpath !== "./package.json",
);

describe("package manifest", () => {
	it("reports the published version through the public entry point", () => {
		expect(VELVE_AUTH_VERSION).toBe(manifest.version);
	});

	it("declares every subpath from architecture section 3.1", () => {
		expect(Object.keys(manifest.exports).sort()).toEqual([
			".",
			"./client",
			"./http",
			"./import",
			"./neon",
			"./package.json",
			"./pg",
			"./postgres-js",
			"./schema",
			"./testing",
		]);
	});

	it("carries an explicit types condition per subpath", () => {
		for (const [, target] of subpathExports) {
			expect(typeof target).toBe("object");
			expect((target as { types: string }).types).toMatch(/^\.\/dist\/.+\.d\.mts$/);
		}
	});

	it("ships ESM only", () => {
		expect(manifest.type).toBe("module");
		for (const [, target] of subpathExports) {
			expect((target as { default: string }).default).toMatch(/\.mjs$/);
		}
	});

	it("publishes the documents the readme links to", () => {
		expect(manifest.files).toContain("README.md");
		expect(manifest.files).toContain("DOCUMENTATION.md");
		expect(manifest.files).toContain("CASE-STUDY.md");
	});
});
