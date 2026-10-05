import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The German says of a missing `Origin` header that the library *vergleichen dürfte*, which is a
 * statement of what the library is permitted to compare. S-CSRF-1 and D.3 render it as *would be
 * allowed to compare*; a rendering as *could compare* turns permission into ability, and the rules
 * do not let a translation change what a reason says.
 */

function textOf(file: string): string {
	return readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8").replace(/\s+/g, " ");
}

describe("the English renders vergleichen dürfte as permission every time", () => {
	it("has as many 'would be allowed to compare' as the German has 'vergleichen dürfte'", () => {
		const german = textOf("../VELVE-AUTH-ARCHITEKTUR.md").split("vergleichen dürfte").length - 1;
		const english =
			textOf("../VELVE-AUTH-ARCHITECTURE.md").split("would be allowed to compare").length - 1;

		expect(german).toBeGreaterThan(0);
		expect(english).toBe(german);
	});
});
