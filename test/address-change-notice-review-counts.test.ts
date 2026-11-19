import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Review of S-LINK-8's count: 3.11 now enumerates eight hook points, and every place in either
 * specification file that counts or lists the enumerated points must say so, not only the
 * sections the feature rewrote.
 */

const SPECIFICATIONS = ["VELVE-AUTH-ARCHITEKTUR.md", "VELVE-AUTH-ARCHITECTURE.md"] as const;

function linesOf(file: string): readonly string[] {
	return readFileSync(new URL(`../${file}`, import.meta.url), "utf8").split("\n");
}

describe("every count of the enumerated hook points says eight (S-LINK-8, 3.11)", () => {
	it.each(SPECIFICATIONS)("%s counts no seven enumerated points", (file) => {
		const stale = linesOf(file)
			.map((line, index) => ({ line, number: index + 1 }))
			.filter(({ line }) =>
				/\b(sieben aufgezählten? Punkte|Sieben aufgezählte Hook-Punkte|seven enumerated (hook )?points)\b/i.test(
					line,
				),
			)
			.map(({ number }) => `${file}:${number}`);

		expect(stale).toStrictEqual([]);
	});

	it.each(SPECIFICATIONS)(
		"%s lists afterEmailChange wherever it lists the after points",
		(file) => {
			const incomplete = linesOf(file)
				.map((line, index) => ({ line, number: index + 1 }))
				.filter(
					({ line }) =>
						line.includes("`afterSignIn`, `afterSessionCreate`, `afterUserCreate`") &&
						!line.includes("`afterEmailChange`"),
				)
				.map(({ number }) => `${file}:${number}`);

			expect(incomplete).toStrictEqual([]);
		},
	);

	it("3.11 itself names eight points", () => {
		const names = linesOf("VELVE-AUTH-ARCHITEKTUR.md")
			.join("\n")
			.match(/An deklarierten Punkten mithören:([^.]*)\./)?.[1]
			?.match(/`(\w+)`/g)
			?.map((quoted) => quoted.slice(1, -1));

		expect(names).toHaveLength(8);
	});
});
