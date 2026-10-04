import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * `@velve/auth/postgres-js`, `/neon` and `/import` are declared and export nothing (E-2902), so a
 * paragraph or a table row that names one of them has to say so, or it promises a module that is
 * not there.
 */
const RESERVED_SUBPATH = /(?:@velve\/auth)?\/(?:postgres-js|neon|import)\b/;
const SAYS_IT_IS_EMPTY = /\b(?:reserved|exports? nothing|export nothing|does not ship)\b/i;

function passagesNamingAReservedSubpath(markdown: string): string[] {
	return markdown
		.split(/\n\s*\n/)
		.flatMap((paragraph) =>
			paragraph.trimStart().startsWith("|") ? paragraph.split("\n") : [paragraph],
		)
		.filter((passage) => RESERVED_SUBPATH.test(passage))
		.filter((passage) => !SAYS_IT_IS_EMPTY.test(passage));
}

describe("the three empty subpaths are never offered as working", () => {
	it.each(["README.md", "DOCUMENTATION.md", "docs/releases/1.2.0.md"])("%s", (file) => {
		const markdown = readFileSync(`${repositoryRoot}${file}`, "utf8");

		expect(passagesNamingAReservedSubpath(markdown)).toStrictEqual([]);
	});

	it("reads a passage that offers one as a finding", () => {
		expect(
			passagesNamingAReservedSubpath("| `database` | the driver from `/pg` or `/neon` |\n"),
		).toHaveLength(1);
		expect(
			passagesNamingAReservedSubpath("| `@velve/auth/neon` | reserved; exports nothing yet |\n"),
		).toStrictEqual([]);
	});
});
