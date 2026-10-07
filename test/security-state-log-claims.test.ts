import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

//a log entry that says a test cites a case stays true of the file it names (E-3349)

const log = readFileSync(new URL("../docs/decisions/log.md", import.meta.url), "utf8");

function source(path: string): string {
	return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("E-3340 and E-3344 against the test files they name", () => {
	it("keeps the sentence that mac-guards cites T-INTEG-4 true", () => {
		expect(log).toContain("`test/keys-integrity-mac-guards.test.ts` cites T-INTEG-4");
		expect(source("test/keys-integrity-mac-guards.test.ts")).toContain("T-INTEG-4");
	});

	it.each([
		["test/security-state-seal-snapshot.test.ts", "T-INTEG-3"],
		["test/security-state-session-issue.test.ts", "T-INTEG-3"],
	])("keeps %s citing %s, as E-3344 says nothing was lost from the header blocks", (path, id) => {
		expect(log).toContain("nothing in those blocks was lost");
		expect(source(path)).toContain(id);
	});
});
