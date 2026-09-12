import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const TOOL = `${repositoryRoot}tools/dist-tag.mjs`;

/**
 * The tool resolves the manifest from its own location rather than from the working directory, so
 * a fixture is a copy of the real file beside a manifest of our own — not a second implementation.
 */
async function distTagFor(version: unknown): Promise<{ stdout: string; output: string }> {
	const directory = mkdtempSync(join(tmpdir(), "velve-dist-tag-"));
	mkdirSync(join(directory, "tools"));
	copyFileSync(TOOL, join(directory, "tools", "dist-tag.mjs"));
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify(version === undefined ? {} : { version }),
	);
	const outputFile = join(directory, "github-output");
	writeFileSync(outputFile, "");

	const { stdout } = await run(process.execPath, [join(directory, "tools", "dist-tag.mjs")], {
		env: { ...process.env, GITHUB_OUTPUT: outputFile },
	});
	return { stdout: stdout.trim(), output: readFileSync(outputFile, "utf8") };
}

/**
 * Until 1.0.0 the workflow wrote `DIST_TAG: next` as a literal, which would have published the
 * stable line under the prerelease tag and left `latest` on the first prerelease for good.
 * This decides it from the version instead, and it is the value a publish is made under.
 */
describe("the dist-tag follows from the version (E-1777)", () => {
	it.each(["1.0.0", "2.3.4", "10.0.0", "1.0.0+build.5"])(
		"sends the stable version %s to latest",
		async (version) => {
			expect((await distTagFor(version)).stdout).toBe("latest");
		},
	);

	it.each(["1.0.0-next.1", "1.0.0-next.2", "2.0.0-rc.1", "1.0.0-0", "1.0.0-alpha.1+build.5"])(
		"sends the prerelease %s to next",
		async (version) => {
			expect((await distTagFor(version)).stdout).toBe("next");
		},
	);

	/** The tool writes the step output itself, so a refusal is the step's exit status rather than
	 * an empty tag handed on by a command substitution that exited zero. */
	it("writes the answer to GITHUB_OUTPUT as well as to stdout", async () => {
		expect((await distTagFor("1.0.0")).output).toBe("value=latest\n");
		expect((await distTagFor("1.0.0-next.2")).output).toBe("value=next\n");
	});

	it.each([
		["a version that is not semantic", "1.0"],
		["a version that is not a string", 100],
		["no version at all", undefined],
	])("refuses %s rather than guessing a tag", async (_case, version) => {
		const refusal = await distTagFor(version).then(
			() => null,
			(failure: { code?: number; stderr?: string }) => failure,
		);

		expect(refusal?.code).toBe(1);
		expect(refusal?.stderr).toContain("The dist-tag cannot be decided");
		expect(refusal?.stderr).not.toContain("latest");
	});

	it("agrees with the version this repository is about to publish", async () => {
		const { version } = JSON.parse(readFileSync(`${repositoryRoot}package.json`, "utf8")) as {
			version: string;
		};
		const { stdout } = await run(process.execPath, [TOOL]);

		expect(stdout.trim()).toBe(version.includes("-") ? "next" : "latest");
	});
});
