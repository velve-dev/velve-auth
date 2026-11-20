import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const workflowDirectory = `${repositoryRoot}.github/workflows`;

const REMOTE_ACTION = /^\s+(?:- )?uses: ([^\s#]+)/gm;
const PINNED_TO_A_COMMIT = /@[0-9a-f]{40}$/;

function remoteActionsOf(name: string): string[] {
	const source = readFileSync(`${workflowDirectory}/${name}`, "utf8");
	return [...source.matchAll(REMOTE_ACTION)]
		.map((match) => String(match[1]))
		.filter((reference) => !reference.startsWith("./"));
}

/**
 * A tag such as `@v4` is a pointer its owner can move. publish.yml runs pnpm/action-setup,
 * actions/setup-node and actions/checkout in the job that holds `id-token: write` and
 * `contents: write`, so whoever moves one of those tags publishes @velve/auth with this
 * repository's provenance. Pinning to a full commit hash is the only reference that cannot move.
 */
describe("every action a workflow runs is pinned to a commit", () => {
	it("pins every action publish.yml runs", () => {
		const unpinned = remoteActionsOf("publish.yml").filter(
			(reference) => !PINNED_TO_A_COMMIT.test(reference),
		);

		expect(unpinned).toStrictEqual([]);
	});

	it("pins every third-party action in every workflow", () => {
		const unpinned = readdirSync(workflowDirectory)
			.flatMap((name) => remoteActionsOf(name).map((reference) => `${name}: ${reference}`))
			.filter((entry) => !entry.includes(" actions/"))
			.filter((entry) => !PINNED_TO_A_COMMIT.test(entry));

		expect(unpinned).toStrictEqual([]);
	});
});
