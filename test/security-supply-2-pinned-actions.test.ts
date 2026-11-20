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

	/** GitHub's own actions are pinned as well: their tags move like anyone else's, and the publish
	 * job runs them. The trailing comment names the release the hash was resolved from, so a reader
	 * and an update tool can tell which one is pinned (E-3886). */
	it("pins every action in every workflow, GitHub's own included, and names the release beside it", () => {
		const unpinned = readdirSync(workflowDirectory).flatMap((name) =>
			[...readFileSync(`${workflowDirectory}/${name}`, "utf8").matchAll(/^\s+(?:- )?uses: (.+)$/gm)]
				.map((match) => String(match[1]))
				.filter((reference) => !reference.startsWith("./"))
				.filter((reference) => !/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/.test(reference))
				.map((reference) => `${name}: ${reference}`),
		);

		expect(unpinned).toStrictEqual([]);
	});

	/** One action at one release is one hash, so two hashes for the same action in the tree are two
	 * releases nobody chose to run side by side. */
	it("pins each action to one release across every workflow", () => {
		const pinned = new Map<string, Set<string>>();
		for (const name of readdirSync(workflowDirectory)) {
			for (const match of readFileSync(`${workflowDirectory}/${name}`, "utf8").matchAll(
				/uses: ([\w.-]+\/[\w.-]+)@([0-9a-f]{40})/g,
			)) {
				const hashes = pinned.get(String(match[1])) ?? new Set<string>();
				hashes.add(String(match[2]));
				pinned.set(String(match[1]), hashes);
			}
		}

		expect([...pinned].filter(([, hashes]) => hashes.size > 1)).toStrictEqual([]);
		expect(pinned.size).toBeGreaterThanOrEqual(3);
	});
});
