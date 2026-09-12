import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const TOOL = `${repositoryRoot}tools/check-release-tag.mjs`;

/**
 * The tool reads the manifest from its own location, so a fixture is a copy of the real file
 * beside a manifest of our own. Reading the repository's version instead — which this file did
 * until 1.0.0 — survives a bump from one prerelease to the next and breaks on the bump to a
 * stable version, because the clause under test only fires for a prerelease (E-1806).
 */
const VERSION = "1.0.0-next.1";
const PRERELEASE = "next.1";

function toolBesideAManifest(version: string): string {
	const directory = mkdtempSync(join(tmpdir(), "velve-release-tag-"));
	mkdirSync(join(directory, "tools"));
	copyFileSync(TOOL, join(directory, "tools", "check-release-tag.mjs"));
	writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "@velve/auth", version }));
	return join(directory, "tools", "check-release-tag.mjs");
}

let registry: Server | undefined;

afterEach(async () => {
	if (registry !== undefined) {
		await new Promise((resolve) => registry?.close(resolve));
		registry = undefined;
	}
});

/** A scoped package that is not published answers 401 rather than 404, because the registry
 * will not say whether a private one is there; both are what absence looks like. */
async function registryAnswering(status: number, body: string): Promise<string> {
	registry = createServer((_request, response) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(body);
	});
	const listening = registry;
	await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
}

function checkAgainst(registryUrl: string): Promise<{ stdout: string; stderr: string }> {
	return run(process.execPath, [toolBesideAManifest(VERSION), `v${VERSION}`, "next"], {
		env: { ...process.env, VELVE_REGISTRY: registryUrl },
	});
}

const FIRST_PUBLISH = "npm points latest at a package's first version";
const UNKNOWN = "could not be asked whether";

/**
 * The release of `1.0.0-next.1` passed `check:release-tag` and was published under `next`, and
 * npm pointed `latest` at it anyway — `check:published-version` found it afterwards, when the
 * publish could no longer be taken back. The clause that reasons about `latest` reads the
 * dist-tag that was asked for, and the one case it cannot see is a package's first publish.
 */
describe("the first publish of a package takes latest whatever --tag says (E-1771)", () => {
	it("says so before the publish when the registry does not hold the package", async () => {
		const { stdout, stderr } = await checkAgainst(await registryAnswering(401, "{}"));

		expect(stderr).toContain(FIRST_PUBLISH);
		expect(stderr).toContain(`${VERSION} will therefore carry latest as well as next`);
		expect(stdout).toContain(`a prerelease (${PRERELEASE}) published under next`);
	});

	it.each([404, 401])("reads HTTP %s as the package being absent", async (status) => {
		const { stderr } = await checkAgainst(await registryAnswering(status, "{}"));

		expect(stderr).toContain(FIRST_PUBLISH);
	});

	it("says nothing where the package is already published, because latest is settled", async () => {
		const published = JSON.stringify({ next: "1.0.0-next.0", latest: "0.9.0" });

		const { stderr } = await checkAgainst(await registryAnswering(200, published));

		expect(stderr).toBe("");
	});

	/** A registry that could not be asked is not a registry that answered no: reporting the
	 * first-publish case from an unreachable one would warn on every release run without network. */
	it("distinguishes a registry it could not reach from one that said absent", async () => {
		const { stderr } = await run(
			process.execPath,
			[toolBesideAManifest(VERSION), `v${VERSION}`, "next"],
			{
				env: { ...process.env, VELVE_REGISTRY: "http://127.0.0.1:1" },
			},
		);

		expect(stderr).toContain(UNKNOWN);
		expect(stderr).not.toContain(FIRST_PUBLISH);
	});

	/** It reports rather than refuses, so a first publish is possible at all; that is the whole
	 * of what it buys, and the entry says what it does not buy. */
	it("exits zero in every one of the three states", async () => {
		const absent = await checkAgainst(await registryAnswering(401, "{}"));
		expect(absent.stdout).toContain(`release tag: v${VERSION} matches`);
	});
});
