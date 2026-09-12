import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * These cases read the two workflows as text rather than as YAML — this repository has no YAML
 * parser and adding one for a test is a dependency decision — so what they see is the set of
 * jobs a file declares and the exact commands its steps run, not the document's structure.
 *
 * Two things they are shaped by, because an earlier version of this file missed both (E-1429):
 * it compared only one job's `pnpm` commands, so a whole job could go missing from the release
 * and an arbitrary shell step could be added to it, and neither was visible. Job sets are
 * compared, and every `run:` line is compared, not the ones that happen to start with `pnpm`.
 */
function workflow(name: string): string {
	return readFileSync(`${repositoryRoot}.github/workflows/${name}`, "utf8");
}

const JOB_HEADING = /^ {2}([A-Za-z0-9_-]+):$/gm;
const EVERY_RUN_LINE = /^\s+(?:- )?run: (.+)$/gm;
const BASE_FETCH = /^\s+run: git fetch .*origin\/main$/gm;
const GUARDED_BASE_FETCH = /^\s+if: (.+)\n\s+run: git fetch .*origin\/main$/gm;
const TAG_REF_GUARD = "startsWith(github.ref, 'refs/tags/')";

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

function commands(region: string): string[] {
	return [...region.matchAll(EVERY_RUN_LINE)].map((match) => String(match[1]));
}

const ci = workflow("ci.yml");
const release = workflow("release.yml");
const releaseJobs = jobRegions(release);
const manifest = JSON.parse(readFileSync(`${repositoryRoot}package.json`, "utf8")) as {
	scripts: Record<string, string>;
};

/** `needs: a` and `needs: [a, b]` are the same declaration, and the chain below reads both. */
function needsOf(region: string): string[] {
	const match = /^\s+needs: (.+)$/m.exec(region);
	if (match === null) {
		return [];
	}
	const declared = String(match[1]).trim();
	return declared.startsWith("[")
		? declared
				.slice(1, -1)
				.split(",")
				.map((name) => name.trim())
		: [declared];
}

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

	it("declares exactly the jobs a release is made of", () => {
		expect([...releaseJobs.keys()]).toStrictEqual([
			"dist-tag",
			"ci",
			"tiers",
			"version",
			"publish",
			"verify",
		]);
	});

	/** The release runs everything ci.yml runs because it runs ci.yml, rather than because a
	 * copy of it was kept in step. A tag ref matches neither of ci.yml's own triggers, so
	 * without this call nothing scans anything at the moment a version is published. */
	it("runs ci.yml itself, and ci.yml is callable and still carries both its jobs", () => {
		expect(job("ci")).toContain("uses: ./.github/workflows/ci.yml");
		expect(ci.slice(ci.indexOf("\non:\n"), ci.indexOf("\nconcurrency:"))).toContain(
			"workflow_call:",
		);
		expect([...jobRegions(ci).keys()]).toStrictEqual(["gate", "attribution"]);
	});

	/** Both jobs that resolve `origin/main` fetch it, and only where a tag is the ref.
	 * `actionlint` type-checks the expression and cannot see a well-formed one with the wrong
	 * value or the wrong context, and each of those restores the hole silently (E-1441). */
	it("guards both of ci.yml's base fetches on a tag ref", () => {
		const guards = [...ci.matchAll(GUARDED_BASE_FETCH)].map((match) => String(match[1]));

		expect([...ci.matchAll(BASE_FETCH)]).toHaveLength(2);
		expect(guards).toStrictEqual([TAG_REF_GUARD, TAG_REF_GUARD]);
	});

	it("runs both tiers section 6 puts before a release", () => {
		expect(commands(job("tiers"))).toContain("pnpm test:nightly");
		expect(commands(job("tiers"))).toContain("pnpm test:release");
	});

	it("lets each step gate the next, from ci.yml to the registry", () => {
		const chain: [string, string][] = [
			["tiers", "ci"],
			["version", "tiers"],
			["publish", "version"],
			["verify", "publish"],
		];

		for (const [dependent, required] of chain) {
			expect(needsOf(job(dependent))).toContain(required);
		}
		expect(job("ci")).not.toContain("needs:");
		expect(needsOf(job("dist-tag"))).toStrictEqual([]);
	});

	/** An allowlist of every command the workflow runs, in order. A step that is not a `pnpm`
	 * line is a step like any other here, which is the point: the job below it publishes. */
	it("runs these commands and no others", () => {
		expect(commands(release)).toStrictEqual([
			"pnpm install --frozen-lockfile",
			"pnpm dist-tag",
			"pnpm install --frozen-lockfile",
			"pnpm build",
			"pnpm test:nightly",
			"pnpm test:release",
			"pnpm install --frozen-lockfile",
			'pnpm check:release-tag "$GITHUB_REF_NAME" "$DIST_TAG"',
			"pnpm build",
			'npm publish --dry-run --provenance --access public --tag "$DIST_TAG"',
			"pnpm install --frozen-lockfile",
			"pnpm build",
			"npm --version",
			'npm publish --provenance --access public --tag "$DIST_TAG"',
			'pnpm check:published-version "$DIST_TAG"',
		]);
	});

	it("rehearses the publish before the gate is spent, and publishes only after it", () => {
		expect(commands(job("version"))).toContain(
			'npm publish --dry-run --provenance --access public --tag "$DIST_TAG"',
		);
		expect(commands(job("publish"))).toContain(
			'npm publish --provenance --access public --tag "$DIST_TAG"',
		);
		expect(release).not.toContain("DIST_TAG: next");
		expect(release).not.toContain("DIST_TAG: latest");
		expect(job("publish")).toContain("id-token: write");
	});

	it("resolves the published version back from the registry afterwards", () => {
		expect(commands(job("verify"))).toStrictEqual(['pnpm check:published-version "$DIST_TAG"']);
	});

	/** A credential named in a second place is a credential that survives the migration to
	 * trusted publishing, which is the deletion of the first one (E-1416). */
	it("names a credential in exactly one step, and never in a command", () => {
		const references = [...release.matchAll(/secrets\.[A-Z_]+/g)].map((match) => match[0]);

		expect(references).toStrictEqual(["secrets.NPM_TOKEN"]);
		expect(release).toMatch(/NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
		expect(release).not.toMatch(/^\s+(?:- )?run: .*(NODE_AUTH_TOKEN|NPM_TOKEN)/m);
	});

	it("names only scripts package.json declares", () => {
		const invoked = commands(release)
			.filter((command) => command.startsWith("pnpm "))
			.map(
				(command) =>
					command
						.split(/\s+/)
						.slice(1)
						.find((word) => !word.startsWith("-")) ?? "",
			)
			.filter((script) => script !== "install");

		expect(invoked.length).toBeGreaterThanOrEqual(7);
		expect(invoked.filter((script) => manifest.scripts[script] === undefined)).toStrictEqual([]);
	});
});
