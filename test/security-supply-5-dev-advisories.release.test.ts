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

interface AuditReport {
	advisories?: Record<
		string,
		{
			github_advisory_id: string;
			module_name: string;
			severity: string;
			vulnerable_versions: string;
		}
	>;
}

async function auditOfEveryDependencyKind(): Promise<AuditReport> {
	try {
		const { stdout } = await run("pnpm", ["audit", "--json"], {
			cwd: repositoryRoot,
			maxBuffer: 64 * 1024 * 1024,
		});
		return JSON.parse(stdout) as AuditReport;
	} catch (failure) {
		const stdout = (failure as { stdout?: string }).stdout ?? "";
		if (!stdout.trim().startsWith("{")) {
			throw new Error("pnpm audit could not reach the advisory database, so this proves nothing");
		}
		return JSON.parse(stdout) as AuditReport;
	}
}

/**
 * The nightly audit job runs `pnpm audit` over every dependency kind and fails on any advisory not
 * in `pnpm.auditConfig.ignoreGhsas`. The lock file pins a vitest, a vite and a zod with published
 * advisories, so the job meant to report a vulnerable dependency is red for known reasons, and a
 * new advisory against the build tools that run in the publish job would land in an already red job.
 *
 * It is a case of the release tier and not of `pnpm test`: the advisory database changes without
 * this repository changing, which E-1841 keeps out of the blocking gate, and the release tier is
 * what runs over the commit before it is published.
 */
describe("the lock file resolves no dependency with an open advisory", () => {
	it("reports no advisory outside the stated exceptions", async () => {
		const ignored = new Set(manifest.pnpm?.auditConfig?.ignoreGhsas ?? []);
		const report = await auditOfEveryDependencyKind();
		const open = Object.values(report.advisories ?? {})
			.filter((advisory) => !ignored.has(advisory.github_advisory_id))
			.map(
				(advisory) =>
					`${advisory.severity} ${advisory.module_name} ${advisory.vulnerable_versions} ${advisory.github_advisory_id}`,
			)
			.sort();

		expect(open).toStrictEqual([]);
	}, 120_000);
});
