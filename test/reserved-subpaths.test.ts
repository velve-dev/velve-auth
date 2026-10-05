import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * `@velve/auth/postgres-js`, `/neon` and `/import` were declared and exported nothing (E-2902), and
 * 2.0.0 removes them (E-3021). A paragraph or a table row that still names one of them has to say
 * that it is gone, or it promises a module that is not there.
 */
const REMOVED_SUBPATH = /(?:@velve\/auth|`)\/(?:postgres-js|neon|import)(?![\w-])/;
const SAYS_IT_IS_GONE = /\b(?:removed|removes|entfernt)\b/i;
const REMOVED = ["postgres-js", "neon", "import"] as const;

function readFromRoot(file: string): string {
	return readFileSync(`${repositoryRoot}${file}`, "utf8");
}

function passagesOfferingARemovedSubpath(markdown: string): string[] {
	return markdown
		.split(/\n\s*\n/)
		.flatMap((paragraph) =>
			paragraph.trimStart().startsWith("|") ? paragraph.split("\n") : [paragraph],
		)
		.filter((passage) => REMOVED_SUBPATH.test(passage))
		.filter((passage) => !SAYS_IT_IS_GONE.test(passage));
}

/** section 7 is the architecture's own decision log and states the reasons it was taken on */
function specificationBeforeItsDecisionLog(file: string, heading: string): string {
	const text = readFromRoot(file);
	const decisionLog = text.indexOf(`\n${heading}`);
	expect(decisionLog).toBeGreaterThan(0);
	return text.slice(0, decisionLog);
}

describe("the three empty subpaths are gone (E-3021)", () => {
	it("are not exported by package.json", () => {
		const manifest = JSON.parse(readFromRoot("package.json")) as {
			exports: Record<string, unknown>;
		};

		for (const subpath of REMOVED) {
			expect(Object.keys(manifest.exports)).not.toContain(`./${subpath}`);
		}
	});

	it("are not built by tsdown", () => {
		const config = readFromRoot("tsdown.config.ts");

		for (const subpath of REMOVED) {
			expect(config).not.toContain(`src/${subpath}/`);
		}
	});

	it("have no source directory", () => {
		for (const subpath of REMOVED) {
			expect(existsSync(`${repositoryRoot}src/${subpath}`)).toBe(false);
		}
	});
});

describe("no document offers one of the three removed subpaths", () => {
	it.each(["README.md", "DOCUMENTATION.md", "docs/releases/2.0.0.md"])("%s", (file) => {
		expect(passagesOfferingARemovedSubpath(readFromRoot(file))).toStrictEqual([]);
	});

	it.each([
		["VELVE-AUTH-ARCHITEKTUR.md", "## 7. Entscheidungsprotokoll"],
		["VELVE-AUTH-ARCHITECTURE.md", "## 7. Decision log"],
	])("%s before section 7", (file, heading) => {
		expect(
			passagesOfferingARemovedSubpath(specificationBeforeItsDecisionLog(file, heading)),
		).toStrictEqual([]);
	});

	it("reads a passage that offers one as a finding", () => {
		expect(
			passagesOfferingARemovedSubpath("| `database` | the driver from `/pg` or `/neon` |\n"),
		).toHaveLength(1);
		expect(
			passagesOfferingARemovedSubpath("- `@velve/auth/neon` is removed in 2.0.0\n"),
		).toStrictEqual([]);
	});
});
