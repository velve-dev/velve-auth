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

/**
 * The highest version each ignored advisory is against, as the registry's advisory states it
 * (`vulnerable_versions: "<=3.0.3"`). An installed version above it is no longer the advisory's,
 * so the exception has to go rather than outlive it (E-2907).
 */
const HIGHEST_VULNERABLE_VERSION: Record<string, string> = {
	"GHSA-vfj7-8cjw-p6xm": "3.0.3",
};

interface WhyNode {
	version?: string;
	dependencies?: Record<string, WhyNode>;
	optionalDependencies?: Record<string, WhyNode>;
	devDependencies?: Record<string, WhyNode>;
}

type WhyRoot = WhyNode;

async function pathsTo(packageName: string, productionOnly: boolean): Promise<WhyRoot> {
	const flags = productionOnly ? ["--prod"] : [];
	const { stdout } = await run("pnpm", ["why", ...flags, packageName, "--json"], {
		cwd: repositoryRoot,
	});
	const roots = JSON.parse(stdout) as WhyRoot[];
	return roots[0] ?? {};
}

function installedVersionsOf(packageName: string, node: WhyNode): string[] {
	const children = [
		...Object.entries(node.dependencies ?? {}),
		...Object.entries(node.optionalDependencies ?? {}),
		...Object.entries(node.devDependencies ?? {}),
	];
	return children.flatMap(([name, child]) => [
		...(name === packageName && child.version !== undefined ? [child.version] : []),
		...installedVersionsOf(packageName, child),
	]);
}

const RELEASE_PART = /^(\d+)\.(\d+)\.(\d+)/;

//a version that does not read as one is reported rather than assumed to be inside the range
function isAtMost(version: string, highest: string): boolean {
	const installed = RELEASE_PART.exec(version);
	const bound = RELEASE_PART.exec(highest);
	if (installed === null || bound === null) {
		return false;
	}
	for (const index of [1, 2, 3]) {
		const difference = Number(installed[index]) - Number(bound[index]);
		if (difference !== 0) {
			return difference < 0;
		}
	}
	return true;
}

function versionsOutsideTheAdvisory(versions: readonly string[], highest: string): string[] {
	return versions.filter((version) => !isAtMost(version, highest));
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

	it("holds a highest vulnerable version for every ignored advisory", () => {
		expect(Object.keys(HIGHEST_VULNERABLE_VERSION).sort()).toStrictEqual(
			Object.keys(IGNORED_ADVISORY_PACKAGES).sort(),
		);
	});

	it.each(Object.entries(IGNORED_ADVISORY_PACKAGES))(
		"%s is against %s, and every installed version of it is still inside the advisory",
		async (advisory, packageName) => {
			const highest = String(HIGHEST_VULNERABLE_VERSION[advisory]);
			const installed = installedVersionsOf(packageName, await pathsTo(packageName, false));

			expect(installed).not.toStrictEqual([]);
			expect(versionsOutsideTheAdvisory(installed, highest)).toStrictEqual([]);
		},
	);

	it("reports a planted version above the advisory's range, so the check can fail", () => {
		expect(versionsOutsideTheAdvisory(["3.0.3", "3.0.4", "3.1.0", "4.0.0"], "3.0.3")).toStrictEqual(
			["3.0.4", "3.1.0", "4.0.0"],
		);
		expect(versionsOutsideTheAdvisory(["3.0.2", "2.3.2", "3.0.3"], "3.0.3")).toStrictEqual([]);
		expect(versionsOutsideTheAdvisory(["not-a-version"], "3.0.3")).toStrictEqual(["not-a-version"]);
	});

	it("finds a planted out-of-range version in a tree shaped as pnpm why prints it", () => {
		const planted: WhyNode = {
			devDependencies: {
				knip: { version: "5.88.1", dependencies: { braces: { version: "3.0.4" } } },
			},
		};

		expect(
			versionsOutsideTheAdvisory(installedVersionsOf("braces", planted), "3.0.3"),
		).toStrictEqual(["3.0.4"]);
	});
});
