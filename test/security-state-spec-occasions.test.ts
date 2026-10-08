import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

//every alarm occasion has a case in section 6.24 and a path in section 3.18 that raises it (E-3381)

function sectionStartingWith(specification: string, heading: string): string {
	const start = specification.indexOf(heading);
	const end = specification.indexOf("\n### ", start + heading.length);
	return specification.slice(start, end === -1 ? undefined : end);
}

const occasions = [
	"sign_in",
	"factor_check",
	"session_resolve",
	"token_redemption",
	"change",
	"maintenance",
	"aggregate",
];

describe.each([
	["the binding German specification", "../VELVE-AUTH-ARCHITEKTUR.md"],
	["its English translation", "../VELVE-AUTH-ARCHITECTURE.md"],
])("section 6.24 in %s", (_which, file) => {
	const tests = sectionStartingWith(
		readFileSync(new URL(file, import.meta.url), "utf8"),
		"### 6.24 INTEG",
	);

	it.each(occasions)("asserts an alarm with the occasion %s", (occasion) => {
		expect(tests).toMatch(new RegExp(`\`${occasion}\`|occasion: "${occasion}"`));
	});
});

describe("section 3.18 names which path raises which occasion", () => {
	it.each(["factor_check", "session_resolve", "token_redemption", "change"])(
		"in the German specification outside the interface for %s",
		(occasion) => {
			const specification = readFileSync(
				new URL("../VELVE-AUTH-ARCHITEKTUR.md", import.meta.url),
				"utf8",
			);
			const prose = sectionStartingWith(specification, "### 3.18").split("*Der Alarm.*")[1] ?? "";
			const mentions = prose.split(`\`${occasion}\``).length - 1;
			expect(mentions).toBeGreaterThanOrEqual(2);
		},
	);
});
