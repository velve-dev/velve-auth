import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

//a confirmed address change deletes the outstanding mailed links before the account lock (E-3382)

const german = readFileSync(new URL("../VELVE-AUTH-ARCHITEKTUR.md", import.meta.url), "utf8");
const english = readFileSync(new URL("../VELVE-AUTH-ARCHITECTURE.md", import.meta.url), "utf8");

function rowOf(specification: string, testId: string): string {
	return specification.split("\n").find((line) => line.startsWith(`| ${testId} |`)) ?? "";
}

describe("section 3.18 point 3 in the binding German specification", () => {
	it("deletes every other outstanding mailed token of the account before the lock", () => {
		expect(german).toContain(
			"löscht danach, in derselben Transaktion und noch vor der Kontosperre, jeden weiteren offenen Einmal-Token des Kontos, der an eine Adresse verschickt wurde",
		);
	});

	it("no longer reads an alarm after an address change as expected", () => {
		expect(german).not.toContain("als erwartbar");
		expect(english).not.toContain("read such an alarm after an address change as expected");
	});
});

describe.each([
	["German", german, /0\*\* Alarmen/],
	["English", english, /0\*\* alarms/],
])("T-INTEG-4 in the %s specification", (_name, specification, noAlarm) => {
	it("redeems a reset link from before a library address change as a missing token without an alarm", () => {
		const row = rowOf(specification, "T-INTEG-4");
		expect(row).toMatch(noAlarm);
		expect(row).toMatch(
			/Reset-Link von vor dem Adresswechsel|reset link from before the address change/,
		);
	});
});
