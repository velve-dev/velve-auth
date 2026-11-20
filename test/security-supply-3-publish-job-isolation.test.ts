import { readFileSync } from "node:fs";
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
			/uses: actions\/checkout@\S+\n\s+with:\n(?:\s+\S+: .+\n)*?\s+persist-credentials: false/,
		);
	});
});
