import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/** The two shell blocks a maintainer pastes to publish, read from the document that states them,
 * so these cases hold the sequence that is written down and not a copy of it. */
function publishingBlocks(): [string, string] {
	const method = readFileSync(`${repositoryRoot}docs/working-method.md`, "utf8");
	const start = method.indexOf("### Publishing a version");
	const section = method.slice(start, method.indexOf("\n## ", start));
	const blocks = [...section.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => String(match[1]));
	expect(blocks).toHaveLength(2);
	return [String(blocks[0]), String(blocks[1])];
}

const scratch: string[] = [];

afterEach(() => {
	for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratchDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "velve-publish-"));
	scratch.push(directory);
	return directory;
}

/** Stand-ins for the commands the blocks call. Each records its arguments in one log, in the order
 * the shell ran them, and exits with the status `failing` names for it, zero otherwise. */
function standIns(failing: Record<string, number>, realGit: boolean): { bin: string; log: string } {
	const bin = scratchDirectory();
	const log = join(bin, "calls.log");
	const tools = realGit ? ["npm", "pnpm"] : ["npm", "pnpm", "git"];
	for (const tool of tools) {
		const failures = Object.entries(failing)
			.filter(([prefix]) => prefix.startsWith(`${tool} `))
			.map(
				([prefix, status]) =>
					`case "${tool} $*" in "${prefix}"*) echo "${tool} $*" >> "${log}"; exit ${status};; esac`,
			)
			.join("\n");
		writeFileSync(
			join(bin, tool),
			`#!/bin/sh\n${failures}\necho "${tool} $*" >> "${log}"\ncase "$*" in "run --silent release-dist-tag") echo latest;; esac\nexit 0\n`,
		);
		chmodSync(join(bin, tool), 0o755);
	}
	writeFileSync(log, "");
	return { bin, log };
}

function runInOneShell(script: string, cwd: string, bin: string): void {
	const { VERSION: _version, DIST_TAG: _distTag, ...inherited } = process.env;
	const environment = { ...inherited, PATH: `${bin}:${process.env.PATH ?? ""}` };
	spawnSync("bash", ["-c", script], { cwd, env: environment, encoding: "utf8" });
}

function calls(log: string): string[] {
	return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

const PUBLISH = /^npm publish (?!.*--dry-run)/;

function manifestDirectory(): string {
	const directory = scratchDirectory();
	writeFileSync(join(directory, "package.json"), '{"name":"@velve/auth","version":"1.2.0"}\n');
	return directory;
}

/**
 * The second block is pasted on its own, and nothing in it asks whether the first block finished.
 * Both variables it reads are assigned before the first block's last two steps, so a rehearsal or
 * a tag check that refused leaves them set, and a shell that never ran the first block leaves them
 * empty — and either way the publish runs.
 */
describe("the publish block runs only after the rehearsal block finished", () => {
	it("publishes nothing in a shell where the rehearsal block never ran", () => {
		const [, publish] = publishingBlocks();
		const { bin, log } = standIns({}, false);

		runInOneShell(publish, manifestDirectory(), bin);

		expect(calls(log).filter((call) => PUBLISH.test(call))).toStrictEqual([]);
	});

	it("publishes nothing after the tag check in the rehearsal block refused", () => {
		const [rehearse, publish] = publishingBlocks();
		const { bin, log } = standIns({ "pnpm check:release-tag": 1 }, false);

		runInOneShell(`${rehearse}\n${publish}`, manifestDirectory(), bin);

		expect(calls(log).filter((call) => PUBLISH.test(call))).toStrictEqual([]);
	});

	it("publishes nothing after the rehearsal itself refused", () => {
		const [rehearse, publish] = publishingBlocks();
		const { bin, log } = standIns({ "npm publish --dry-run": 1 }, false);

		runInOneShell(`${rehearse}\n${publish}`, manifestDirectory(), bin);

		expect(calls(log).filter((call) => PUBLISH.test(call))).toStrictEqual([]);
	});
});

/**
 * The document says the first block refuses a stale checkout. `git pull --ff-only` exits zero on a
 * local `main` that is ahead of `origin/main`, so a commit no pull request merged passes as current.
 */
describe("the rehearsal block refuses a checkout that is not origin/main", () => {
	it("stops before the rehearsal on a main carrying an unpushed commit", () => {
		const [rehearse] = publishingBlocks();
		const origin = scratchDirectory();
		const clone = scratchDirectory();
		const git = (cwd: string, ...argv: string[]) =>
			execFileSync(
				"git",
				[
					"-c",
					"user.name=release test",
					"-c",
					"user.email=release@example.invalid",
					"-c",
					"commit.gpgsign=false",
					...argv,
				],
				{ cwd, encoding: "utf8" },
			);
		git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
		git(clone, "init", "--quiet", "--initial-branch=main");
		writeFileSync(join(clone, "package.json"), '{"name":"@velve/auth","version":"1.2.0"}\n');
		git(clone, "add", "package.json");
		git(clone, "commit", "--quiet", "-m", "chore: merged");
		git(clone, "remote", "add", "origin", origin);
		git(clone, "push", "--quiet", "--set-upstream", "origin", "main");
		writeFileSync(join(clone, "unreviewed.txt"), "never merged\n");
		git(clone, "add", "unreviewed.txt");
		git(clone, "commit", "--quiet", "-m", "chore: not merged");
		const { bin, log } = standIns({}, true);

		runInOneShell(rehearse, clone, bin);

		expect(calls(log).filter((call) => call.startsWith("npm publish"))).toStrictEqual([]);
	});
});

/**
 * Architecture 6.19 puts the packed-artefact case "vor jedem Release", and it lives in the release
 * tier. The tag that runs that tier is pushed after the publish now, and the nightly run over
 * `main` is consulted by nobody: neither block runs the tier or asks whether it passed on the
 * commit being published.
 */
describe("the release tier has passed over the published commit before the publish", () => {
	it("runs the release tier, or asks for its result on HEAD, before the publish", () => {
		const [rehearse] = publishingBlocks();

		expect(rehearse).toMatch(/pnpm test:release|release-tier/);
	});
});

/**
 * `git tag -s` needs a signing key, which a maintainer's machine may not have configured. Run after
 * the publish, its refusal leaves a published version without the tag DOCUMENTATION.md names as
 * what ties it to its source, and without the registry check that follows it.
 */
describe("the signed tag exists before the version is published", () => {
	it("creates the tag before the publish, and pushes it after", () => {
		const [rehearse, publish] = publishingBlocks();
		const { bin, log } = standIns({}, false);

		runInOneShell(`${rehearse}\n${publish}`, manifestDirectory(), bin);
		const order = calls(log);
		const tagged = order.findIndex((call) => call.startsWith("git tag"));
		const published = order.findIndex((call) => PUBLISH.test(call));

		expect(published).toBeGreaterThanOrEqual(0);
		expect(tagged).toBeGreaterThanOrEqual(0);
		expect(tagged).toBeLessThan(published);
	});
});
