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

/** A registry that answers the two reads the check makes, so only the dist-tags vary. It holds
 * no attestation, as the registry holds none for a version published from the maintainer's
 * machine, and every path it does not know answers 404 as the registry's does (E-2761). */
const attestationReads: string[] = [];

async function registryWhere(version: string, distTags: Record<string, string>): Promise<string> {
	const server = createServer((request, response) => {
		if (request.url?.includes("/attestations/")) {
			attestationReads.push(request.url);
			response.writeHead(404, { "content-type": "application/json" });
			response.end("{}");
			return;
		}
		const body = request.url?.includes("/dist-tags") ? distTags : { version };
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	});
	registry = server;
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function check(
	registryUrl: string,
	distTag: string,
	version: string,
): Promise<{ stdout: string; stderr: string }> {
	return run(process.execPath, [TOOL, distTag, NAME, version], {
		env: { ...process.env, VELVE_REGISTRY: registryUrl, VELVE_REGISTRY_DEADLINE_MS: "2000" },
	});
}

async function refusalFrom(checking: Promise<unknown>): Promise<string> {
	return checking.then(
		() => "",
		(failure: { stderr?: string }) => failure.stderr ?? "",
	);
}

const STUCK = "which is a prerelease, so a bare install";

/**
 * The clause asked whether `latest` names *this* version, so publishing 1.0.0-next.2 while
 * `latest` sat on 1.0.0-next.1 was green — the two are unequal, and `latest` went on naming a
 * prerelease, and an older one than `next` (E-1774).
 */
describe("latest naming any prerelease is the finding, not latest naming this one", () => {
	it("refuses a release whose latest is stuck on an older prerelease", async () => {
		const url = await registryWhere("1.0.0-next.2", {
			next: "1.0.0-next.2",
			latest: "1.0.0-next.1",
		});

		expect(await refusalFrom(check(url, "next", "1.0.0-next.2"))).toContain(STUCK);
	});

	it("still refuses the case it always caught, where latest is this prerelease", async () => {
		const url = await registryWhere("1.0.0-next.1", {
			next: "1.0.0-next.1",
			latest: "1.0.0-next.1",
		});

		expect(await refusalFrom(check(url, "next", "1.0.0-next.1"))).toContain(STUCK);
	});

	it("passes a stable release that takes latest", async () => {
		const url = await registryWhere("1.0.0", { next: "1.0.0-next.2", latest: "1.0.0" });

		const { stdout } = await check(url, "latest", "1.0.0");

		expect(stdout).toContain("latest points at it");
	});

	/** After a stable version holds `latest`, a further prerelease under `next` is fine — which is
	 * the case the widened clause must not start refusing. */
	it("passes a later prerelease once latest is a stable version", async () => {
		const url = await registryWhere("1.1.0-next.1", { next: "1.1.0-next.1", latest: "1.0.0" });

		const { stdout } = await check(url, "next", "1.1.0-next.1");

		expect(stdout).toContain("next points at it");
	});
});

/**
 * npm mints a provenance attestation only from a CI provider's OIDC token, and the publish now runs
 * on the maintainer's machine, so a version without one is the expected outcome and not a
 * finding. The check required one until then, and would refuse every release it is now run on.
 */
describe("a version published without a provenance attestation", () => {
	it("passes, without asking the registry for an attestation", async () => {
		attestationReads.length = 0;
		const url = await registryWhere("1.2.0", { next: "1.0.0-next.2", latest: "1.2.0" });

		const { stdout } = await check(url, "latest", "1.2.0");

		expect(stdout).toContain("latest points at it");
		expect(stdout).not.toContain("provenance");
		expect(attestationReads).toStrictEqual([]);
	});
});
