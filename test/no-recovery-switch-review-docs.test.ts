import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Review of E-3746: a reseal of a broken state of an account whose switch is off now refuses
 * unless the caller names `recoveryDisabled`, which changes every caller of
 * `resealSecurityState` written before 3.0.0. An operator upgrading reads the chapter's
 * *Upgrading* section, so the change belongs there and not only in the decision log.
 */

function upgradingSectionOfTheSwitch(): string {
	const documentation = readFileSync(new URL("../DOCUMENTATION.md", import.meta.url), "utf8");
	const chapter = documentation.split("\n## The no-recovery switch\n")[1]?.split("\n## ")[0] ?? "";
	return chapter.split("\n### Upgrading\n")[1]?.split("\n### ")[0] ?? "";
}

describe("the upgrade notes of the no-recovery switch", () => {
	it("tell an existing reseal caller that a broken state now needs the switch named", () => {
		const upgrading = upgradingSectionOfTheSwitch();

		expect(upgrading).not.toBe("");
		expect(upgrading).toContain("resealSecurityState");
		expect(upgrading).toContain("recoveryDisabled");
	});
});
