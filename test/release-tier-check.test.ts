import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const TOOL = `${repositoryRoot}tools/check-release-tier.mjs`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";

const PASSED = "release tier:";
const FOUND_NOTHING = "No successful run of release-tier.yml";
const COULD_NOT_CHECK = "The release tier cannot be checked";

let api: Server | undefined;
const asked: string[] = [];

afterEach(async () => {
	asked.length = 0;
	if (api !== undefined) {
		await new Promise((resolve) => api?.close(resolve));
		api = undefined;
	}
});

/** A stand-in for GitHub's REST API that answers every request with one status and one body. */
async function apiAnswering(status: number, body: unknown): Promise<string> {
	const server = createServer((request, response) => {
		asked.push(request.url ?? "");
		response.writeHead(status, { "content-type": "application/json" });
		response.end(typeof body === "string" ? body : JSON.stringify(body));
	});
	api = server;
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function outcome(
	apiUrl: string,
	argv: string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
	return run(process.execPath, [TOOL, ...argv], {
		env: { ...process.env, VELVE_GITHUB_API: apiUrl },
	}).then(
		({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
		(failure: { code?: number; stdout?: string; stderr?: string }) => ({
			status: failure.code ?? -1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
		}),
	);
}

function runOf(headSha: string, conclusion: string): Record<string, unknown> {
	return { id: 1, head_sha: headSha, conclusion, html_url: "https://example.invalid/run/1" };
}

/**
 * The publish block asks this tool whether the release tier passed on the commit about to be
 * published (architecture 6.19). Each fault is planted against a stand-in API and the pass line is
 * required to be absent, and a refusal is required to read as one rather than as a finding.
 */
describe("the release tier check before a publish", () => {
	it("passes a commit the release tier ran green on, asking for exactly that commit", async () => {
		const url = await apiAnswering(200, {
			total_count: 1,
			workflow_runs: [runOf(COMMIT, "success")],
		});

		const result = await outcome(url, [COMMIT]);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain(PASSED);
		expect(asked).toStrictEqual([
			`/repos/velve-dev/velve-auth/actions/workflows/release-tier.yml/runs?head_sha=${COMMIT}&status=success&per_page=100`,
		]);
	});

	it("reports a commit with no successful run", async () => {
		const url = await apiAnswering(200, { total_count: 0, workflow_runs: [] });

		const result = await outcome(url, [COMMIT]);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(FOUND_NOTHING);
		expect(result.stdout).not.toContain(PASSED);
	});

	it("reports runs of another commit, as an API that ignored the filter would answer", async () => {
		const url = await apiAnswering(200, {
			total_count: 3,
			workflow_runs: [runOf(OTHER_COMMIT, "success")],
		});

		const result = await outcome(url, [COMMIT]);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(FOUND_NOTHING);
		expect(result.stdout).not.toContain(PASSED);
	});

	it("reports a run on the commit that did not succeed", async () => {
		const url = await apiAnswering(200, {
			total_count: 1,
			workflow_runs: [runOf(COMMIT, "failure")],
		});

		const result = await outcome(url, [COMMIT]);

		expect(result.status).toBe(1);
		expect(result.stdout).not.toContain(PASSED);
	});

	it("refuses rather than reports when the API answers with an error", async () => {
		const url = await apiAnswering(403, { message: "API rate limit exceeded" });

		const result = await outcome(url, [COMMIT]);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain(COULD_NOT_CHECK);
		expect(result.stderr).not.toContain(FOUND_NOTHING);
	});

	it("refuses an answer it cannot read", async () => {
		const url = await apiAnswering(200, "<html>not json</html>");

		const result = await outcome(url, [COMMIT]);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain(COULD_NOT_CHECK);
	});

	it("refuses an answer without the fields it counts", async () => {
		const url = await apiAnswering(200, { runs: [] });

		const result = await outcome(url, [COMMIT]);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain(COULD_NOT_CHECK);
	});

	it("refuses without asking when no full commit id was given", async () => {
		const url = await apiAnswering(200, {
			total_count: 1,
			workflow_runs: [runOf(COMMIT, "success")],
		});

		for (const argv of [[], [""], [COMMIT.slice(0, 7)], ["HEAD"]]) {
			const result = await outcome(url, argv);
			expect(result.status).toBe(2);
			expect(result.stdout).not.toContain(PASSED);
		}
		expect(asked).toStrictEqual([]);
	});

	it("refuses an API that cannot be reached", async () => {
		const url = await apiAnswering(200, {});
		await new Promise((resolve) => api?.close(resolve));
		api = undefined;

		const result = await outcome(url, [COMMIT]);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain(COULD_NOT_CHECK);
	});
});
