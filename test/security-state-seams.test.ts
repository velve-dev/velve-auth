import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

//the seams between the security-state parts each have a production caller and a true description (S-INTEG-6)

function sourceFiles(directory: string): string[] {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
	});
}

const SRC = new URL("../src", import.meta.url).pathname;
const sources = sourceFiles(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

describe("recordSeal after every new seal (S-INTEG-6)", () => {
	it("tells the anchor the first seal of an account an OAuth sign-in creates", () => {
		const oauth = readFileSync(new URL("../src/core/oauth/service.ts", import.meta.url), "utf8");
		expect(oauth).toContain("sealCreatedAccount(");
		expect(
			/recordSealLater|recordSealWithAnchors/.test(oauth),
			"the OAuth service records the seal sealCreatedAccount writes",
		).toBe(true);
	});
});

describe("no seam is left without a production caller", () => {
	it("keeps no beforeLockingTheOwnerOf seam that no production module passes", () => {
		const naming = sources.filter(({ text }) => text.includes("beforeLockingTheOwnerOf"));
		const callers = naming.filter(
			({ path, text }) =>
				/beforeLockingTheOwnerOf\s*:/.test(text) &&
				!path.endsWith("artefact.ts") &&
				!path.endsWith("complete.ts"),
		);
		expect(naming.length === 0 || callers.length > 0).toBe(true);
	});
});

describe("DOCUMENTATION.md describes what the instance wires", () => {
	const documentation = readFileSync(new URL("../DOCUMENTATION.md", import.meta.url), "utf8");

	it("does not say the instance passes no refusal report, which it does", () => {
		expect(documentation).not.toContain("The instance does not pass one yet");
	});
});
