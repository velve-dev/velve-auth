import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const caseStudy = readFileSync(`${repositoryRoot}/CASE-STUDY.md`, "utf8");

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git", "coverage"]);
const SKIPPED_FILES = new Set(["VELVE-AUTH-ARCHITEKTUR.md"]);
const CITATION = /\bE-(\d+)\b/g;
const ENTRY_HEADING = /^\*\*E-(\d+) — (.+?)\*\*/gm;
const REQUIRED_PARTS = ["*Kontext:*", "*Verworfen:*", "*Grund:*", "*Preis:*"];

function entries(): { number: number; title: string; body: string }[] {
	const found = [...caseStudy.matchAll(ENTRY_HEADING)];
	return found.map((match, index) => ({
		number: Number(match[1]),
		title: match[2] as string,
		body: caseStudy.slice(
			match.index,
			index + 1 < found.length ? found[index + 1]?.index : caseStudy.length,
		),
	}));
}

function everyTrackedFile(): string[] {
	const found: string[] = [];
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory)) {
			if (SKIPPED_DIRECTORIES.has(entry) || SKIPPED_FILES.has(entry)) continue;
			const path = `${directory}/${entry}`;
			if (statSync(path).isDirectory()) walk(path);
			else if (/\.(ts|mts|mjs|sql|md|json|yml)$/.test(entry)) found.push(path);
		}
	};
	walk(repositoryRoot.replace(/\/$/, ""));
	return found;
}

describe("decision log", () => {
	const log = entries();

	it("numbers every decision exactly once", () => {
		const counts = new Map<number, number>();
		for (const entry of log) counts.set(entry.number, (counts.get(entry.number) ?? 0) + 1);
		const repeated = [...counts.entries()]
			.filter(([, count]) => count > 1)
			.map(([number]) => `E-${String(number).padStart(2, "0")}`);
		expect(repeated).toEqual([]);
	});

	it("gives every decision all four parts", () => {
		const incomplete = log.flatMap((entry) => {
			const missing = REQUIRED_PARTS.filter((part) => !entry.body.includes(part));
			return missing.length === 0
				? []
				: [
						`E-${String(entry.number).padStart(2, "0")} (${entry.title}) lacks ${missing.join(", ")}`,
					];
		});
		expect(incomplete).toEqual([]);
	});

	it("resolves every decision cited anywhere in the repository", () => {
		const known = new Set(log.map((entry) => entry.number));
		const dangling: string[] = [];
		for (const path of everyTrackedFile()) {
			for (const [citation, digits] of readFileSync(path, "utf8").matchAll(CITATION)) {
				if (!known.has(Number(digits))) {
					dangling.push(
						`${path.replace(repositoryRoot, "")} cites ${citation}, which does not exist`,
					);
				}
			}
		}
		expect(dangling).toEqual([]);
	});
});
