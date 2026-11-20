import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const TOOL = `${repositoryRoot}tools/check-published-version.mjs`;
const NAME = "@velve/auth";

let registry: Server | undefined;

afterEach(async () => {
	if (registry !== undefined) {
		await new Promise((resolve) => registry?.close(resolve));
		registry = undefined;
	}
});

/** A registry answering the two reads the check makes, so only the dist-tags vary. The review
 * asked the live registry, which holds the stale tag today and would turn green only once the
 * maintainer removes it; this asks the check itself, which is what holds the property afterwards. */
async function registryWhere(version: string, distTags: Record<string, string>): Promise<string> {
	const server = createServer((request, response) => {
		const body = request.url?.includes("/dist-tags") ? distTags : { version };
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	});
	registry = server;
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function check(registryUrl: string, distTag: string, version: string): Promise<string> {
	return run(process.execPath, [TOOL, distTag, NAME, version], {
		env: { ...process.env, VELVE_REGISTRY: registryUrl, VELVE_REGISTRY_DEADLINE_MS: "2000" },
	}).then(
		() => "",
		(failure: { stderr?: string }) => failure.stderr ?? "",
	);
}

/**
 * `npm install @velve/auth@next` installs whatever the `next` dist-tag names. The publish path
 * moves `latest` and never `next`, so `next` still names the first prerelease of 1.0.0, which
 * lacks every security fix since, and a reader who takes `next` for the newest line installs it.
 */
describe("no dist-tag on the registry names a version older than latest", () => {
	it("refuses a registry whose next names a version older than latest", async () => {
		const url = await registryWhere("2.0.1", { latest: "2.0.1", next: "1.0.0-next.2" });

		expect(await check(url, "latest", "2.0.1")).toContain("next points at 1.0.0-next.2");
	});

	/** The finding names the command, because only the maintainer can move a tag and the check is
	 * what tells them to (E-3890). */
	it("names the command that removes the tag", async () => {
		const url = await registryWhere("2.0.1", { latest: "2.0.1", next: "1.0.0-next.2" });

		expect(await check(url, "latest", "2.0.1")).toContain("npm dist-tag rm @velve/auth next");
	});

	/** A release outranks each of its own prereleases, so a `next` left on the prerelease of the
	 * version `latest` now names is as stale as one left a major behind. Any tag counts, not `next`. */
	it.each([
		[{ latest: "3.0.0", next: "3.0.0-next.4" }, "next"],
		[{ latest: "3.0.0", beta: "2.9.9" }, "beta"],
		[{ latest: "3.0.0", next: "3.0.0-rc.1", legacy: "1.1.0" }, "legacy"],
		[{ latest: "1.0.0-next.10", next: "1.0.0-next.9" }, "next"],
	])("refuses %o, naming %s", async (tags, stale) => {
		const url = await registryWhere("3.0.0", tags);

		expect(await check(url, "latest", "3.0.0")).toContain(`The dist-tag ${stale} points at`);
	});

	it.each([
		{ latest: "3.0.0" },
		{ latest: "3.0.0", next: "3.0.0" },
		{ latest: "3.0.0", next: "3.0.1-next.1" },
		{ latest: "3.0.0", next: "3.1.0-next.10" },
		{ latest: "3.0.0", next: "10.0.0-alpha" },
	])("passes %o, where no tag is behind latest", async (tags) => {
		const url = await registryWhere("3.0.0", tags);

		expect(await check(url, "latest", "3.0.0")).toBe("");
	});

	/** Precedence is semver's and not the string order: 3.0.0 sorts before 10.0.0 as text and after
	 * it as a version, and a prerelease number compares as a number. */
	it("compares the numbers as numbers", async () => {
		const url = await registryWhere("10.0.0", { latest: "10.0.0", next: "9.10.0" });

		expect(await check(url, "latest", "10.0.0")).toContain("next points at 9.10.0");
	});

	it("reports a tag it cannot rank rather than passing it", async () => {
		const url = await registryWhere("3.0.0", { latest: "3.0.0", odd: "not-a-version" });

		expect(await check(url, "latest", "3.0.0")).toContain("cannot be compared with latest");
	});
});
