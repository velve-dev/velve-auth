import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

//a session issue that inserts nothing answers with the failure of the path it completes and never session_required (E-3384)

describe.each([
	[
		"German",
		"../VELVE-AUTH-ARCHITEKTUR.md",
		"wird mit dem gewöhnlichen Fehlschlag des Weges beantwortet, den sie abschließt",
		"und nie mit `session_required`",
	],
	[
		"English",
		"../VELVE-AUTH-ARCHITECTURE.md",
		"is answered with the ordinary failure of the path it completes",
		"and never with `session_required`",
	],
])("Outward in the %s specification", (_name, file, answer, never) => {
	const specification = readFileSync(new URL(file, import.meta.url), "utf8");

	it("answers a missed session issue with the completing path's ordinary failure", () => {
		expect(specification).toContain(answer);
	});

	it("never answers it with session_required", () => {
		expect(specification).toContain(never);
	});
});
