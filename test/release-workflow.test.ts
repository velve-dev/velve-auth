import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * The release workflow carries a copy of ci.yml's gate, because a release that skips a check the
 * ordinary pull request runs is worse than no workflow (E-1417). Nothing else notices the copy
 * drifting. These cases read the two files as text rather than as YAML — this repository has no
 * YAML parser and adding one for a test is a dependency decision — so what they see is the
 * ordered list of commands a job runs and the lines a job declares, and not the document's
 * structure. A step reordered inside a job is caught; a job renamed in a way that still parses
 * is not.
 */
function workflow(name: string): string {
	return readFileSync(`${repositoryRoot}.github/workflows/${name}`, "utf8");
}

const JOB_HEADING = /^ {2}([A-Za-z0-9_-]+):$/gm;

function jobRegions(source: string): Map<string, string> {
	const body = source.slice(source.indexOf("\njobs:\n"));
	const headings = [...body.matchAll(JOB_HEADING)];
	return new Map(
		headings.map((heading, index) => [
			String(heading[1]),
			body.slice(heading.index, headings[index + 1]?.index ?? body.length),
		]),
	);
}

function packageManagerCommands(region: string): string[] {
	return [...region.matchAll(/^\s+run: (pnpm .+)$/gm)].map((match) => String(match[1]));
}

const ci = workflow("ci.yml");
const release = workflow("release.yml");
const releaseJobs = jobRegions(release);
const manifest = JSON.parse(readFileSync(`${repositoryRoot}package.json`, "utf8")) as {
	scripts: Record<string, string>;
};

function job(name: string): string {
	const region = releaseJobs.get(name);
	if (region === undefined) {
		throw new Error(`release.yml declares no job named ${name}`);
	}
	return region;
}

describe("the release workflow", () => {
	it("is fired by a version tag and by nothing else", () => {
		const triggers = release.slice(release.indexOf("\non:\n"), release.indexOf("\nconcurrency:"));

		expect(triggers).toContain('tags: ["v*"]');
		expect(triggers).not.toContain("workflow_dispatch");
		expect(triggers).not.toContain("schedule");
	});

	it("runs the gate ci.yml runs, in the order ci.yml runs it", () => {
		const gateOfCi = jobRegions(ci).get("gate");

		expect(gateOfCi).toBeDefined();
		expect(packageManagerCommands(job("gate"))).toStrictEqual(
			packageManagerCommands(String(gateOfCi)),
		);
	});

	it("gates on the same PostgreSQL service and the same Node matrix as ci.yml", () => {
		const gateOfCi = String(jobRegions(ci).get("gate"));

		for (const declaration of [
			'node: ["20.19", "26"]',
			"image: postgres:16-alpine",
			"VELVE_TEST_DATABASE_URL: postgres://velve:velve@localhost:5432/velve_test",
			"fetch-depth: 0",
		]) {
			expect(job("gate")).toContain(declaration);
			expect(gateOfCi).toContain(declaration);
		}
	});

	it("runs both tiers section 6 puts before a release", () => {
		expect(packageManagerCommands(job("tiers"))).toContain("pnpm test:nightly");
		expect(packageManagerCommands(job("tiers"))).toContain("pnpm test:release");
	});

	it("lets each step gate the next, from the gate to the registry", () => {
		const chain: [string, string][] = [
			["tiers", "gate"],
			["version", "tiers"],
			["publish", "version"],
			["verify", "publish"],
		];

		for (const [dependent, required] of chain) {
			expect(job(dependent)).toContain(`needs: ${required}`);
		}
		expect(job("gate")).not.toContain("needs:");
	});

	it("compares the tag with the manifest before anything is published", () => {
		expect(packageManagerCommands(job("version"))).toStrictEqual([
			'pnpm check:release-tag "$GITHUB_REF_NAME" "$DIST_TAG"',
		]);
	});

	it("publishes under the dist-tag with provenance and public access", () => {
		expect(release).toContain("DIST_TAG: next");
		expect(job("publish")).toContain('npm publish --provenance --access public --tag "$DIST_TAG"');
		expect(job("publish")).toContain("id-token: write");
	});

	it("resolves the published version back from the registry afterwards", () => {
		expect(packageManagerCommands(job("verify"))).toStrictEqual([
			'pnpm check:published-version "$DIST_TAG"',
		]);
	});

	/** A credential named in a second place is a credential that survives the migration to
	 * trusted publishing, which is the deletion of the first one (E-1416). */
	it("names a credential in exactly one step, and never in a command", () => {
		const references = [...release.matchAll(/secrets\.[A-Z_]+/g)].map((match) => match[0]);

		expect(references).toStrictEqual(["secrets.NPM_TOKEN"]);
		expect(release).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
		expect(release).not.toMatch(/^\s+run: .*(NODE_AUTH_TOKEN|NPM_TOKEN)/m);
	});

	it("names only scripts package.json declares", () => {
		const invoked = [...release.matchAll(/^\s+run: pnpm ([a-z:-]+)/gm)]
			.map((match) => String(match[1]))
			.filter((script) => script !== "install");

		expect(invoked.length).toBeGreaterThanOrEqual(15);
		expect(invoked.filter((script) => manifest.scripts[script] === undefined)).toStrictEqual([]);
	});
});
