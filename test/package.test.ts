import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VELVE_AUTH_VERSION } from "../src/index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	name: string;
	version: string;
	type: string;
	exports: Record<string, string>;
};

describe("package manifest", () => {
	it("reports the published version through the public entry point", () => {
		expect(VELVE_AUTH_VERSION).toBe(manifest.version);
	});

	it("declares every subpath from architecture section 3.1", () => {
		expect(Object.keys(manifest.exports).sort()).toEqual(
			[
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
			].sort(),
		);
	});

	it("ships ESM only", () => {
		expect(manifest.type).toBe("module");
		for (const [subpath, target] of Object.entries(manifest.exports)) {
			if (subpath === "./package.json") continue;
			expect(target.endsWith(".mjs")).toBe(true);
		}
	});
});
