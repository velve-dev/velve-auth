import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

//the internal parameters of a session issue stay off the declarations a user can reach (E-3488)

function declarationsUnder(directory: string): string[] {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) {
			return declarationsUnder(path);
		}
		return path.endsWith(".d.mts") ? [path] : [];
	});
}

const INTERNAL_NAMES = [
	"IssueAuthorisation",
	"SessionIssuePath",
	"readonly authorisedBy",
	"readonly completes",
	"readonly sessionEpoch",
] as const;

describe("the shipped declarations", () => {
	it("carry none of the session issue's internal parameters", () => {
		const found: Record<string, string[]> = {};
		for (const file of declarationsUnder("dist")) {
			const text = readFileSync(file, "utf8");
			for (const name of INTERNAL_NAMES) {
				//what an administrator reseal ratified names the new epoch on purpose (E-3182)
				const ratifiedEpoch =
					name === "readonly sessionEpoch" && file.endsWith("security-state-maintenance.d.mts");
				if (text.includes(name) && !ratifiedEpoch) {
					found[name] = [...(found[name] ?? []), file];
				}
			}
		}
		expect(found).toStrictEqual({});
	});
});
