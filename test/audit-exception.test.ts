import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const manifest = JSON.parse(readFileSync(`${repositoryRoot}package.json`, "utf8")) as {
	pnpm?: { auditConfig?: { ignoreGhsas?: string[] } };
};

/**
 * pnpm ignores an advisory by its id across the whole tree, `--prod` included, so the scope the
 * exception claims is held here rather than by the setting: every ignored advisory names the one
 * package it is against, that package is reached by no production dependency, and the exception
 * goes as soon as the package leaves the tree (E-2901).
 */
const IGNORED_ADVISORY_PACKAGES: Record<string, string> = {
	"GHSA-vfj7-8cjw-p6xm": "braces",
};

interface WhyRoot {
	dependencies?: Record<string, unknown>;
	optionalDependencies?: Record<string, unknown>;
	devDependencies?: Record<string, unknown>;
}

async function pathsTo(packageName: string, productionOnly: boolean): Promise<WhyRoot> {
	const flags = productionOnly ? ["--prod"] : [];
	const { stdout } = await run("pnpm", ["why", ...flags, packageName, "--json"], {
		cwd: repositoryRoot,
	});
	const roots = JSON.parse(stdout) as WhyRoot[];
	return roots[0] ?? {};
}

describe("the audit exception covers development dependencies only", () => {
	it("names exactly the advisories this file holds a package for", () => {
		expect([...(manifest.pnpm?.auditConfig?.ignoreGhsas ?? [])].sort()).toStrictEqual(
			Object.keys(IGNORED_ADVISORY_PACKAGES).sort(),
		);
	});

	it.each(Object.entries(IGNORED_ADVISORY_PACKAGES))(
		"%s is against %s, which nothing that ships reaches",
		async (_advisory, packageName) => {
			const shipped = await pathsTo(packageName, true);

			expect(shipped.dependencies ?? {}).toStrictEqual({});
			expect(shipped.optionalDependencies ?? {}).toStrictEqual({});
		},
	);

	it.each(Object.entries(IGNORED_ADVISORY_PACKAGES))(
		"%s is against %s, which is still in the tree and so still needs the exception",
		async (_advisory, packageName) => {
			const everything = await pathsTo(packageName, false);

			expect(Object.keys(everything.devDependencies ?? {})).not.toStrictEqual([]);
		},
	);
});
