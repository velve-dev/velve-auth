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
	return body.slice(headings[index]?.index, headings[index + 1]?.index ?? body.length);
}

/**
 * npm trusted publishing trusts the workflow file by its name and the repository, and nothing
 * else unless an environment is registered with it. Without one, the OIDC token a run of
 * publish.yml mints on any branch is accepted, so whoever can push a branch can change the
 * file's trigger on that branch and publish an unreviewed tree with valid provenance. A
 * deployment environment restricted to main, named on the job and in the npm registration,
 * is what ties the publish to the reviewed branch.
 */
describe("the publish job can only run for the reviewed branch", () => {
	it("runs the publish in a named deployment environment", () => {
		const region = jobRegion(publish, "publish").replace(/^\s*#.*$/gm, "");

		expect(region).toMatch(/^ {4}environment:\s*\S+/m);
	});

	/** The name is the one the npm registration and the repository's protection rule both carry, and
	 * docs/working-method.md tells the maintainer to set both under it (E-3885). */
	it("names npm-publish, and states the main-only rule in the file a reviewer reads", () => {
		const region = jobRegion(publish, "publish").replace(/^\s*#.*$/gm, "");

		expect(region).toMatch(/^ {4}environment: npm-publish$/m);
		expect(region).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main' && /m);
	});

	it("names no environment in any other job", () => {
		const elsewhere = publish.replace(jobRegion(publish, "publish"), "").replace(/^\s*#.*$/gm, "");

		expect(elsewhere).not.toMatch(/^\s+environment:/m);
	});
});
