import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

//the table counts, the anchor paths, the reseal promise and the passkey bound stay stated in the german specification (E-3354)

const german = readFileSync(new URL("../VELVE-AUTH-ARCHITEKTUR.md", import.meta.url), "utf8");
const lines = german.split("\n");

function lineStartingWith(prefix: string): string {
	return lines.find((line) => line.startsWith(prefix)) ?? "";
}

function requirementId(kind: string, number: number): string {
	return ["S", kind, String(number)].join("-");
}

function requirementLine(kind: string, number: number): string {
	return `- **${requirementId(kind, number)}:**`;
}

function sectionOf(heading: string, nextHeading: string): string {
	const start = german.indexOf(heading);
	return german.slice(start, german.indexOf(nextHeading, start + heading.length));
}

describe("the cascade requirement against the fourteenth user-bound table migration 3 adds", () => {
	it("names velve.security_state among the user-bound tables its cascade must empty", () => {
		expect(lineStartingWith(requirementLine("TOKEN", 5))).toContain("security_state");
	});

	it("gives T-TOKEN-5 the threshold the catalogue test asserts (14/14), not 13/13", () => {
		expect(lineStartingWith("| T-TOKEN-5 |")).toContain("14/14");
	});

	it("no longer says the schema has sixteen tables in J37", () => {
		expect(lineStartingWith("| J37 ")).not.toContain("sechzehn");
	});
});

describe("the anchor and an unknown account at password sign-in", () => {
	it("says what replaces the minimumVersion call for an unknown account, or names the timing channel as a limit", () => {
		const integrity = sectionOf("### 3.18 Integrität", "\n## 4.");
		const mentionsTheSubstituteFloor =
			/minimumVersion[^.]*unbekannt|unbekannt[^.]*minimumVersion|Ersatz[^.]*Anker|Anker[^.]*Ersatz/.test(
				integrity,
			);
		expect(mentionsTheSubstituteFloor).toBe(true);
	});
});

describe("the anchor floor at session resolution against the one query of session resolution", () => {
	it("says how session resolution learns the account to ask minimumVersion for before its one read", () => {
		const start = german.indexOf(`*Anker (${requirementId("INTEG", 6)}).*`);
		const anchor = german.slice(start, german.indexOf("\n", start));
		expect(anchor).toMatch(/Sitzung/);
	});
});

describe("an anchor that missed the latest seal (recordSeal failed or the process crashed)", () => {
	it("names the undetected rollback to the anchor's floor among the limits of 3.18", () => {
		const limits = sectionOf("**Die Grenzen.**", "Damit umfasst das Schema");
		expect(limits).toMatch(/(Fehler in `recordSeal`|Absturz|recordSeal[^.]*(scheitert|wirft))/);
	});

	it("does not promise in the reseal requirement that only an anchor signs out every session", () => {
		expect(lineStartingWith(requirementLine("INTEG", 7))).not.toContain(
			"mit einem Anker jede bestehende Sitzung des Kontos abmeldet",
		);
	});
});

describe("the cost of a seal check against components an account holder adds", () => {
	it("bounds the passkeys of one account, since every session resolution now reads and HMACs all of them", () => {
		expect(german).toMatch(/höchstens [0-9 ]+ Passkeys/);
	});
});
