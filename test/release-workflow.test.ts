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
const publish = workflow("publish.yml");
const publishJobs = jobRegions(publish);
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

function job(name: string, jobs: Map<string, string> = releaseJobs): string {
	const region = jobs.get(name);
	if (region === undefined) {
		throw new Error(`the workflow declares no job named ${name}`);
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

	/** No registry credential exists to be named: publish.yml authenticates with GitHub's OIDC
	 * token through trusted publishing, and a reference left in any workflow is a secret somebody
	 * would recreate to make it work (E-2760, E-3540). The OIDC token is asked for in one job of one
	 * file, and is read below the job heading so that a grant anywhere else stays a finding. */
	it.each(readdirSync(`${repositoryRoot}.github/workflows`))(
		"names no registry credential, and asks for an OIDC token only in the publish job, in %s",
		(name) => {
			const source = workflow(name);
			const outsideThePublishJob =
				name === "publish.yml" ? source.replace(job("publish", publishJobs), "") : source;

			expect(source).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken|registry-url/);
			expect(source).not.toMatch(/secrets\./);
			expect(withoutYamlComments(outsideThePublishJob)).not.toMatch(/id-token|: write$/m);
		},
	);

	/**
	 * `${{ needs.dist-tag.outputs.value }}` is not a property access: an Actions expression parses
	 * the hyphen as subtraction, so it evaluates to the empty string, every job stays green and
	 * the value arrives nowhere. The release that found it published nothing only because
	 * `check:release-tag` refuses an empty dist-tag rather than guessing one (E-1880).
	 */
	it.each([ci, release, publish])(
		"dereferences no job id that an expression cannot read",
		(source) => {
			const dereferenced = [
				...withoutYamlComments(source).matchAll(/\bneeds\.([A-Za-z0-9_-]+)\./g),
			].map((match) => String(match[1]));

			expect(dereferenced.filter((id) => id.includes("-"))).toStrictEqual([]);
		},
	);

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

/** The `key: value` lines indented under a job's `permissions:` line, as a map. */
function jobPermissions(region: string): Record<string, string> {
	const block = /^ {4}permissions:\n((?: {6}[a-z-]+: [a-z]+\n)+)/m.exec(region);
	return Object.fromEntries(
		String(block?.[1] ?? "")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => line.trim().split(": ") as [string, string]),
	);
}

/**
 * A push to main publishes through npm trusted publishing: npm trusts publish.yml in this
 * repository and takes GitHub's OIDC token as the proof, so no credential is stored anywhere
 * (E-3540). Each case was shown red on a fault planted into the file before it was trusted green.
 */
describe("the publish workflow", () => {
	const publishCommands = commands(job("publish", publishJobs));

	it("is fired by a push to main and by nothing else", () => {
		const triggers = publish.slice(publish.indexOf("\non:\n"), publish.indexOf("\nconcurrency:"));

		expect(withoutYamlComments(triggers).replace(/\n+/g, "\n")).toBe(
			"\non:\n  push:\n    branches: [main]\n",
		);
	});

	it("declares exactly the jobs a publish is made of, each waiting for the one before", () => {
		expect([...publishJobs.keys()]).toStrictEqual(["decide", "verify", "publish"]);
		expect(needsOf(job("verify", publishJobs))).toStrictEqual(["decide"]);
		expect(needsOf(job("publish", publishJobs))).toStrictEqual(["decide", "verify"]);
	});

	/** A second push waits rather than cancelling a publish halfway, and then finds its version on
	 * the registry (E-3541). */
	it("runs one publish at a time and cancels none", () => {
		const block = publish.slice(
			publish.indexOf("\nconcurrency:"),
			publish.indexOf("\npermissions:"),
		);

		expect(block).toBe("\nconcurrency:\n  group: publish\n  cancel-in-progress: false\n");
	});

	it("verifies and publishes only a version the registry does not have", () => {
		const unpublished = "    if: needs.decide.outputs.published == 'false'\n";

		expect(job("decide", publishJobs)).toContain('npm view "$NAME@$VERSION" version');
		expect(job("verify", publishJobs)).toContain(unpublished);
		expect(job("publish", publishJobs)).toContain(unpublished);
	});

	/** The whole gate and the release tier on the commit before it is published (E-3542). */
	it("runs the tag check, the gate and the release tier before the publish", () => {
		const verify = commands(job("verify", publishJobs));

		expect(verify).toContain('pnpm check:release-tag "v$VERSION" "$DIST_TAG"');
		expect(verify.indexOf("./tools/start-dex.sh")).toBeLessThan(verify.indexOf("pnpm gate"));
		expect(verify).toContain("pnpm gate");
		expect(verify).toContain("pnpm test:release");
		expect(job("verify", publishJobs)).toContain("fetch-depth: 0");
	});

	it("publishes with provenance, publicly, under the dist-tag the version decides", () => {
		expect(publishCommands.filter((command) => command.startsWith("npm publish"))).toStrictEqual([
			'npm publish --provenance --access public --tag "$DIST_TAG"',
		]);
		expect(commands(job("decide", publishJobs))).toContain("pnpm run release-dist-tag");
	});

	it("runs npm publish in no other job and no other workflow", () => {
		const elsewhere = readdirSync(`${repositoryRoot}.github/workflows`).flatMap((name) =>
			[...jobRegions(workflow(name))]
				.filter(([jobName]) => !(name === "publish.yml" && jobName === "publish"))
				.flatMap(([, region]) => commands(region))
				.filter((command) => /\bnpm publish\b/.test(command)),
		);

		expect(elsewhere).toStrictEqual([]);
	});

	/** Trusted publishing needs npm 11.5.1 or newer (E-3543). */
	it("installs an npm that supports trusted publishing before it publishes", () => {
		const install = publishCommands.findIndex((command) =>
			command.startsWith("npm install --global npm@"),
		);
		const [major = 0, minor = 0, patch = 0] = (
			/npm@(\d+)\.(\d+)\.(\d+)$/.exec(publishCommands[install] ?? "") ?? []
		)
			.slice(1)
			.map(Number);

		expect(install).toBeGreaterThanOrEqual(0);
		expect(install).toBeLessThan(
			publishCommands.findIndex((command) => command.startsWith("npm publish")),
		);
		expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(11_005_001);
	});

	it("grants the publish job an OIDC token and write access to contents, and nothing more", () => {
		expect(jobPermissions(job("publish", publishJobs))).toStrictEqual({
			"id-token": "write",
			contents: "write",
		});
		expect(publish).toContain("\npermissions:\n  contents: read\n\n");
	});

	/** The tag is cut where a refusal costs nothing and pushed once the version is on the registry,
	 * and the registry check reads what the publish made (E-2765, E-3543). */
	it("cuts the tag before the publish, pushes it after, and then checks the registry", () => {
		const region = job("publish", publishJobs);
		const order = [
			'git tag --annotate "v$VERSION"',
			"npm publish ",
			'git push origin "refs/tags/v$VERSION"',
			'pnpm check:published-version "$DIST_TAG"',
		].map((text) => region.indexOf(text));

		expect(order.every((position) => position > 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toStrictEqual(order);
	});
});
