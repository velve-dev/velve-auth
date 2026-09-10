import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const testDirectory = fileURLToPath(new URL(".", import.meta.url));

const CITATION = /\bS-[A-Z]+-\d+\b/g;

/**
 * The file asking the question carries the identifiers it reports on, so counting itself would
 * make every one of them look cited.
 */
export function testFilesOtherThan(asker: string): readonly string[] {
	const excluded = fileURLToPath(asker);
	return readdirSync(testDirectory, { recursive: true, encoding: "utf8" })
		.filter((entry) => entry.endsWith(".ts"))
		.map((entry) => `${testDirectory}${entry}`)
		.filter((path) => path !== excluded);
}

export function testSuiteCitations(files: readonly string[]): ReadonlySet<string> {
	const cited = new Set<string>();
	for (const path of files) {
		for (const [identifier] of readFileSync(path, "utf8").matchAll(CITATION)) {
			cited.add(identifier);
		}
	}
	return cited;
}
