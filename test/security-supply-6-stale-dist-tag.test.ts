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
});
