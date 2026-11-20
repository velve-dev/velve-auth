import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const publish = readFileSync(`${repositoryRoot}.github/workflows/publish.yml`, "utf8");

function jobRegion(source: string, name: string): string {
	const body = source.slice(source.indexOf("\njobs:\n"));
	const headings = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)];
	const index = headings.findIndex((heading) => heading[1] === name);
	if (index < 0) {
		throw new Error(`publish.yml declares no job named ${name}`);
	}
	return body
		.slice(headings[index]?.index, headings[index + 1]?.index ?? body.length)
		.replace(/^\s*#.*$/gm, "");
}

const publishJob = jobRegion(publish, "publish");
const commands = [...publishJob.matchAll(/^\s+(?:- )?run: (.+)$/gm)].map((match) =>
	String(match[1]),
);

/**
 * Every step of a job with `id-token: write` can mint the token npm accepts in place of a
 * credential, and with checkout's default the job's `contents: write` token sits in .git/config.
 * The publish job installs the whole dev tree and runs the bundler there, so the code of every
 * build-time dependency runs next to both: one compromised devDependency publishes what it likes
 * or pushes to the repository. It also publishes a tree it built itself rather than the one the
 * verify job ran the gate over.
 */
describe("the job that can publish runs no dependency code", () => {
	it("installs no dependencies and builds nothing in the job holding the OIDC token", () => {
		const dependencyCode = commands.filter((command) =>
			/^(?:pnpm (?:install|i|build|run build|gate)|npm (?:install|ci)(?! --global npm@))\b/.test(
				command,
			),
		);

		expect(dependencyCode).toStrictEqual([]);
	});

	it("does not leave the contents-write token in the checkout for later steps", () => {
		expect(publishJob).toMatch(
			/uses: actions\/checkout@\S+(?: # \S+)?\n\s+with:\n(?:\s+\S+: .+\n)*?\s+persist-credentials: false/,
		);
	});

	/** The verify job ran the gate and the release tier over its tree, so the tarball is packed there,
	 * after both, and the publish job publishes exactly that file under the version's own name. */
	it("publishes the tarball the verify job packed after the gate and the release tier", () => {
		const verifyJob = jobRegion(publish, "verify");
		const verify = [...verifyJob.matchAll(/^\s+(?:- )?run: (.+)$/gm)].map((match) =>
			String(match[1]),
		);
		const packed = verify.findIndex((command) => command.startsWith("npm pack "));

		expect(packed).toBeGreaterThan(verify.indexOf("pnpm gate"));
		expect(packed).toBeGreaterThan(verify.indexOf("pnpm test:release"));
		expect(verify.indexOf("pnpm gate")).toBeGreaterThanOrEqual(0);
		expect(verifyJob.slice(verifyJob.indexOf("npm pack "))).toMatch(
			/- uses: actions\/upload-artifact@[0-9a-f]{40} # \S+\n\s+with:\n\s+name: package\n/,
		);
		expect(publishJob).toMatch(
			/- uses: actions\/download-artifact@[0-9a-f]{40} # \S+\n\s+with:\n\s+name: package\n/,
		);
		expect(commands.filter((command) => command.startsWith("npm publish"))).toStrictEqual([
			'npm publish "$RUNNER_TEMP/package/velve-auth-$VERSION.tgz" --ignore-scripts --provenance --access public --tag "$DIST_TAG"',
		]);
	});

	/** pnpm/action-setup downloads pnpm, and a restored cache is a store a previous run wrote; the
	 * job that can publish needs neither, because it installs nothing. */
	it("sets up no package manager and restores no cache in the job holding the OIDC token", () => {
		expect(publishJob).not.toMatch(/uses: pnpm\/action-setup@/);
		expect(publishJob).not.toMatch(/^\s+cache:/m);
	});

	/** The repository token is named once in the job, in the environment of the step that pushes the
	 * tag, so no other step of the job is handed it. */
	it("hands the repository token to the tag push and to no other step", () => {
		const steps = publishJob.split(/\n(?= {6}- )/);
		const holding = steps.filter((step) => /github\.token|GITHUB_TOKEN|secrets\./.test(step));

		expect(holding).toHaveLength(1);
		expect(holding[0]).toContain('git push origin "refs/tags/v$VERSION"');
	});
});

/** Every checkout in every workflow drops its credential: no job but the publish pushes, and that
 * one pushes with a token handed to the single step that needs it (E-3887). */
describe("no checkout keeps its token for later steps", () => {
	const workflows = readdirSync(`${repositoryRoot}.github/workflows`);

	it.each(workflows)("sets persist-credentials: false on every checkout of %s", (name) => {
		const source = readFileSync(`${repositoryRoot}.github/workflows/${name}`, "utf8");
		const checkouts = [
			...source.matchAll(/^( +)- uses: actions\/checkout@.+\n((?:\1 {2}.+\n)*)/gm),
		];

		expect(
			checkouts.filter((checkout) => !/^\s+persist-credentials: false$/m.test(String(checkout[2]))),
		).toStrictEqual([]);
	});
});
