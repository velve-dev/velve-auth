import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const workflowDirectory = `${repositoryRoot}.github/workflows`;

/**
 * A workflow without a top-level `permissions:` gets the repository's default GITHUB_TOKEN, which
 * is write-all on a repository created before February 2023 or set so by the organisation. ci.yml
 * runs every pushed branch's own code, so a branch nobody reviewed would hold that token. Stating
 * `contents: read` at the top of every workflow makes the token's reach a property of this tree
 * rather than of a setting no reviewer sees.
 */
describe("every workflow states the token it runs with", () => {
	it("declares top-level permissions in every workflow file", () => {
		const undeclared = readdirSync(workflowDirectory)
			.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
			.filter((name) => {
				const source = readFileSync(`${workflowDirectory}/${name}`, "utf8");
				return !/^permissions:/m.test(source);
			});

		expect(undeclared).toStrictEqual([]);
	});

	/** The top-level block is the floor every job inherits, so it grants reading the repository and
	 * nothing else; a write is stated on the one job that needs it (E-3888). */
	it.each(readdirSync(workflowDirectory))("grants only contents: read at the top of %s", (name) => {
		const source = readFileSync(`${workflowDirectory}/${name}`, "utf8");
		const block = /^permissions:\n((?: {2}.+\n)*)/m.exec(source);

		expect(block?.[1]).toBe("  contents: read\n");
		expect(source.match(/^permissions:/gm)).toHaveLength(1);
	});
});
