import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

//a trace row the maintenance step keeps under an old key version does not hold that version in the ring (E-3361)

const german = readFileSync(new URL("../VELVE-AUTH-ARCHITEKTUR.md", import.meta.url), "utf8");
const lines = german.split("\n");

function lineStartingWith(prefix: string): string {
	return lines.find((line) => line.startsWith(prefix)) ?? "";
}

describe("point 5 of 3.18 against the removal rule it states for a key version", () => {
	const maintenance = lineStartingWith("**5. Die Wartung");

	it("keeps a row that fails its check as a trace, which is what makes the conflict possible", () => {
		expect(maintenance).toContain("bleibt als Spur stehen und unbrauchbar");
	});

	it("requires zero token rows under the old version before it leaves the ring", () => {
		expect(maintenance).toMatch(
			/für die alte Version \*\*0\*\* Siegelzeilen und \*\*0\*\* Token-Zeilen/,
		);
	});

	it("says how a kept trace stops counting against that zero, or names the blocked rotation as a limit", () => {
		const limits = lineStartingWith("**Die Grenzen.**");
		const sayingSo = /Spur[^.]*(Ring|Rotation|Administrator|per SQL)|(Ring|Rotation)[^.]*Spur/;
		const tracesResolved = sayingSo.test(maintenance) || sayingSo.test(limits);
		expect(tracesResolved).toBe(true);
	});
});
