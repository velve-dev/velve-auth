import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

//only a seal the check verified may be written to the anchor, or the writer reaches its store through the library (E-3380)

const german = readFileSync(new URL("../VELVE-AUTH-ARCHITEKTUR.md", import.meta.url), "utf8");
const english = readFileSync(new URL("../VELVE-AUTH-ARCHITECTURE.md", import.meta.url), "utf8");

function sentenceContaining(text: string, fragment: string): string {
	return text.split(/(?<=\.)\s+/).find((sentence) => sentence.includes(fragment)) ?? "";
}

describe("section 3.18 Anchor, the re-record of a stored version above the anchor's", () => {
	it("restricts the re-record to a seal whose digest the check verified, in both languages", () => {
		const de = sentenceContaining(german, "zeichnet das Siegel beim Anker nach");
		const en = sentenceContaining(english, "re-records the seal at the anchor");
		expect(de).not.toBe("");
		expect(en).not.toBe("");
		expect({
			german: /(geprüft|verifiziert|gültig|bestanden|übereinstimm)/.test(de),
			english: /(verified|valid|passed|matches)/.test(en),
		}).toStrictEqual({ german: true, english: true });
	});
});
