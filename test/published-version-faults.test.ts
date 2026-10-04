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

/** A registry whose answer to each of the two reads is set by the case: a status and a body. */
async function registryAnswering(
	version: { status: number; body?: unknown },
	distTags: { status: number; body?: unknown },
): Promise<string> {
	const server = createServer((request, response) => {
		const answer = request.url?.includes("/dist-tags") ? distTags : version;
		response.writeHead(answer.status, { "content-type": "application/json" });
		response.end(JSON.stringify(answer.body ?? {}));
	});
	registry = server;
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function outcome(
	registryUrl: string,
	argv: string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
	return run(process.execPath, [TOOL, ...argv], {
		env: { ...process.env, VELVE_REGISTRY: registryUrl, VELVE_REGISTRY_DEADLINE_MS: "0" },
	}).then(
		({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
		(failure: { code?: number; stdout?: string; stderr?: string }) => ({
			status: failure.code ?? -1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
		}),
	);
}

const PASSED = "published version:";
const COULD_NOT_CHECK = "The published version cannot be checked";

/**
 * With the attestation gone the check has two reads left, and each of them has to be able to fail
 * it. CLAUDE.md section 5 asks a check to tell found nothing from found a fault, so each fault is
 * planted here and the pass line is required to be absent (E-2761).
 */
describe("the registry check after the publish leaves CI", () => {
	it("reports a dist-tag still pointing at the previous version", async () => {
		const url = await registryAnswering(
			{ status: 200, body: { version: "1.2.0" } },
			{ status: 200, body: { latest: "1.1.0", next: "1.0.0-next.2" } },
		);

		const result = await outcome(url, ["latest", NAME, "1.2.0"]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("The dist-tag latest points at 1.1.0 and not at 1.2.0.");
		expect(result.stdout).not.toContain(PASSED);
	});

	it("reports a version the registry says is absent", async () => {
		const url = await registryAnswering(
			{ status: 404 },
			{ status: 200, body: { latest: "1.2.0" } },
		);

		const result = await outcome(url, ["latest", NAME, "1.2.0"]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(`${NAME}@1.2.0 is absent from`);
		expect(result.stdout).not.toContain(PASSED);
	});

	it("refuses rather than passes when the registry could not be asked", async () => {
		const url = await registryAnswering({ status: 503 }, { status: 503 });

		const result = await outcome(url, ["latest", NAME, "1.2.0"]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(COULD_NOT_CHECK);
		expect(result.stdout).not.toContain(PASSED);
	});

	it("refuses a run that names no dist-tag", async () => {
		const url = await registryAnswering(
			{ status: 200, body: { version: "1.2.0" } },
			{ status: 200, body: { latest: "1.2.0" } },
		);

		const result = await outcome(url, []);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("no dist-tag was given");
	});
});
