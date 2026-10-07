import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

//every alarm reason, the constant-time clause, every mass revocation and the sealed disabled state have a threshold in section 6.24 of the german specification and its translation (E-3355)

function sectionStartingWith(specification: string, heading: string): string {
	const start = specification.indexOf(heading);
	const end = specification.indexOf("\n### ", start + heading.length);
	return specification.slice(start, end === -1 ? undefined : end);
}

function rowOf(specification: string, testId: string): string {
	const row = specification.split("\n").find((line) => line.startsWith(`| ${testId} |`));
	return row ?? "";
}

const alarmReasons = [
	"seal_missing",
	"seal_mismatch",
	"key_version_unknown",
	"version_below_anchor",
	"anchor_unavailable",
	"anchor_mismatch",
	"token_binding_mismatch",
	"envelope_binding_mismatch",
	"key_unusable",
];

describe.each([
	["the binding German specification", "../VELVE-AUTH-ARCHITEKTUR.md"],
	["its English translation", "../VELVE-AUTH-ARCHITECTURE.md"],
])("section 6.24 against section 3.18 and 5.21 in %s", (_which, file) => {
	const specification = readFileSync(new URL(file, import.meta.url), "utf8");
	const testsOfTheClass = sectionStartingWith(specification, "### 6.24 INTEG");

	it.each(alarmReasons)("raises the alarm reason %s in at least one case", (reason) => {
		expect(testsOfTheClass).toContain(reason);
	});

	it("gives the constant-time clause of section 5.21 a threshold in T-INTEG-4", () => {
		expect(rowOf(specification, "T-INTEG-4").toLowerCase()).toMatch(/konstant|constant/);
	});

	it("re-inserts a session row after every mass revocation section 3.18 lists, the address-confirmation sweep among them", () => {
		const row = rowOf(specification, "T-INTEG-9");
		expect(row).toContain("S-LINK-4");
		expect(row).toMatch(/redeemReset|requestReset|password\.set|recovery code/);
	});

	it("returns the disabled state a reseal ratifies, since the seal covers disabled_at (E-3315)", () => {
		const returned = specification.slice(
			specification.indexOf("interface SealedSecurityState"),
			specification.indexOf("```", specification.indexOf("interface SealedSecurityState")),
		);
		expect(returned).toMatch(/disabled/i);
	});
});
