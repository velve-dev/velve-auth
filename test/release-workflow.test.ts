import { readdirSync, readFileSync } from "node:fs";
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

const SCRIPTS_RUNNING_THE_UNIT_PROJECT = Object.entries(manifest.scripts)
	.filter(([, body]) => /\bvitest\b/.test(body) && /--project unit\b/.test(body))
	.map(([script]) => script);

function scriptNamedBy(command: string): string | undefined {
	if (!command.startsWith("pnpm ")) {
		return undefined;
	}
	return command
		.split(/\s+/)
		.slice(1)
		.find((word) => !word.startsWith("-") && word !== "run");
}

function runsTheUnitProject(command: string): boolean {
	const script = scriptNamedBy(command);
	return script !== undefined && SCRIPTS_RUNNING_THE_UNIT_PROJECT.includes(script);
}

/** `needs: a` and `needs: [a, b]` are the same declaration, and the chain below reads both. */
/** A comment is prose about the file, and the comment beside the job below states the very
 * expression it warns against — reading it as code reports the repaired file as broken. */
function withoutYamlComments(source: string): string {
	return source.replace(/^\s*#.*$/gm, "");
}

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
		expect([...releaseJobs.keys()]).toStrictEqual(["dist_tag", "ci", "tiers", "version"]);
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

	it("lets each step gate the next, from ci.yml to the tag check", () => {
		const chain: [string, string][] = [
			["tiers", "ci"],
			["version", "tiers"],
		];

		for (const [dependent, required] of chain) {
			expect(needsOf(job(dependent))).toContain(required);
		}
		expect(job("ci")).not.toContain("needs:");
		expect(needsOf(job("dist_tag"))).toStrictEqual([]);
	});

	/** An allowlist of every command the workflow runs, in order. A step that is not a `pnpm`
	 * line is a step like any other here, which is the point: an added `npm publish` is a step. */
	it("runs these commands and no others", () => {
		expect(commands(release)).toStrictEqual([
			"pnpm install --frozen-lockfile",
			"pnpm run release-dist-tag",
			"pnpm install --frozen-lockfile",
			"pnpm build",
			"./tools/start-dex.sh",
			"pnpm test:nightly",
			"pnpm test:release",
			"pnpm install --frozen-lockfile",
			'pnpm check:release-tag "$GITHUB_REF_NAME" "$DIST_TAG"',
		]);
	});

	/** The maintainer publishes and pushes the tag afterwards, so the workflow meets a version
	 * already on the registry, where the npm it runs refuses even a dry run (E-2762). */
	it("publishes nothing and rehearses no publish", () => {
		expect(commands(release).filter((command) => command.startsWith("npm "))).toStrictEqual([]);
		expect(release).not.toContain("DIST_TAG: next");
		expect(release).not.toContain("DIST_TAG: latest");
	});

	/** The publish runs on the maintainer's machine so that no registry credential is stored on
	 * GitHub, and a reference left in any workflow is a secret somebody would recreate to make
	 * it work (E-2760). A rehearsal needs no credential and no OIDC token either. */
	it.each(readdirSync(`${repositoryRoot}.github/workflows`))(
		"names no registry credential and asks for no OIDC token in %s",
		(name) => {
			const source = workflow(name);

			expect(source).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|registry-url|id-token/);
			expect(source).not.toMatch(/secrets\./);
		},
	);

	/**
	 * `${{ needs.dist-tag.outputs.value }}` is not a property access: an Actions expression parses
	 * the hyphen as subtraction, so it evaluates to the empty string, every job stays green and
	 * the value arrives nowhere. The release that found it published nothing only because
	 * `check:release-tag` refuses an empty dist-tag rather than guessing one (E-1880).
	 */
	it.each([ci, release])("dereferences no job id that an expression cannot read", (source) => {
		const dereferenced = [
			...withoutYamlComments(source).matchAll(/\bneeds\.([A-Za-z0-9_-]+)\./g),
		].map((match) => String(match[1]));

		expect(dereferenced.filter((id) => id.includes("-"))).toStrictEqual([]);
	});

	/** Every job an expression reads has to be a job the file declares, and one it waits for. */
	it("reads outputs only from jobs it declares and depends on", () => {
		const readers = [...releaseJobs].flatMap(([name, region]) =>
			[...withoutYamlComments(region).matchAll(/\bneeds\.([A-Za-z0-9_-]+)\./g)].map((match) => ({
				name,
				required: String(match[1]),
			})),
		);

		expect(readers.length).toBeGreaterThan(0);
		for (const { name, required } of readers) {
			expect(releaseJobs.has(required)).toBe(true);
			expect(needsOf(job(name))).toContain(required);
		}
	});

	/**
	 * `pnpm <name>` prefers pnpm's own subcommand over a package script of the same name and says
	 * nothing about it: `pnpm dist-tag` ran pnpm's registry query, the tool never executed, and the
	 * step went green with nothing written to $GITHUB_OUTPUT (E-1881). `pnpm run <name>` cannot be
	 * shadowed, so the step that produces a value for a later job is required to use it.
	 */
	it("produces the dist-tag through a form no pnpm subcommand can shadow", () => {
		const decide = commands(job("dist_tag")).filter((command) => command.includes("dist-tag"));

		expect(decide).toStrictEqual(["pnpm run release-dist-tag"]);
	});

	/**
	 * The acceptance case fails rather than skips without a provider, so every workflow that runs
	 * the suite has to start one. It was in the gate and not in the release tiers, and the tag
	 * found it: `tiers` failed and nothing was published (E-1906). One script, called by both,
	 * because two copies of the block are the drift E-1429 argued against.
	 */
	it("starts the provider in every workflow that runs the suite", () => {
		const runsTheSuite = [ci, release].map((source) => commands(source));

		for (const source of runsTheSuite) {
			expect(source.filter((command) => command.includes("start-dex"))).not.toStrictEqual([]);
		}
		expect(commands(job("tiers"))).toContain("./tools/start-dex.sh");
	});

	/**
	 * The case above names two workflows, and the nightly tier ran the acceptance case without a
	 * provider every night because it was the third (E-2900). This one reads every workflow, finds
	 * every job that runs a script whose vitest call includes the unit project, and requires the
	 * provider to be started earlier in that same job.
	 */
	it.each(readdirSync(`${repositoryRoot}.github/workflows`))(
		"starts the provider before the unit project in every job of %s",
		(name) => {
			for (const [jobName, region] of jobRegions(workflow(name))) {
				const steps = commands(region);
				const firstSuiteRun = steps.findIndex(runsTheUnitProject);
				if (firstSuiteRun === -1) {
					continue;
				}
				expect(
					steps.slice(0, firstSuiteRun),
					`${name} job ${jobName} runs the unit project before starting the provider`,
				).toContain("./tools/start-dex.sh");
			}
		},
	);

	it("recognises every script that runs the unit project", () => {
		expect(SCRIPTS_RUNNING_THE_UNIT_PROJECT).toContain("test");
		expect(SCRIPTS_RUNNING_THE_UNIT_PROJECT).toContain("test:nightly");
		expect(SCRIPTS_RUNNING_THE_UNIT_PROJECT).not.toContain("test:release");
	});

	it("names only scripts package.json declares", () => {
		const invoked = commands(release)
			.filter((command) => command.startsWith("pnpm "))
			.map(
				(command) =>
					command
						.split(/\s+/)
						.slice(1)
						.find((word) => !word.startsWith("-") && word !== "run") ?? "",
			)
			.filter((script) => script !== "install");

		expect(invoked.length).toBeGreaterThanOrEqual(5);
		expect(invoked.filter((script) => manifest.scripts[script] === undefined)).toStrictEqual([]);
	});
});
