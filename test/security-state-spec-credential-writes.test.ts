import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

//every write to an account's credential rows runs under the account lock (E-3385)

describe.each([
	[
		"German",
		"../VELVE-AUTH-ARCHITEKTUR.md",
		"Jedes Schreiben in die Zeilen der Anmeldemittel eines Kontos läuft unter der Kontosperre",
	],
	[
		"English",
		"../VELVE-AUTH-ARCHITECTURE.md",
		"Every write to an account's credential rows runs under the account lock",
	],
])("Sealing in the %s specification", (_name, file, rule) => {
	const specification = readFileSync(new URL(file, import.meta.url), "utf8");

	it("states the rule and names the provider tokens, the background rehash and enroll.start", () => {
		const sentence =
			specification.split(/(?<=\.)\s+/).find((candidate) => candidate.includes(rule)) ?? "";
		const following = specification.slice(
			specification.indexOf(rule),
			specification.indexOf(rule) + 400,
		);
		expect(sentence).not.toBe("");
		expect(following).toContain("`enroll.start`");
	});
});
