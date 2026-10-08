import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

//the per-tier counts section 6 states are the rows of each tier in both languages (E-3376)

function rows(text: string): string[][] {
	return text
		.split("\n")
		.filter((line) => /^\| T-[A-Za-z0-9-]+ \|/.test(line))
		.map((line) =>
			line
				.trim()
				.replace(/^\||\|$/g, "")
				.split(" | ")
				.map((cell) => cell.trim()),
		);
}

describe.each([
	[
		"German",
		"../VELVE-AUTH-ARCHITEKTUR.md",
		/(\d+) Testfälle, von denen (\d+) jeden Commit/,
		/\x60CI bei jedem Commit\x60 \((\d+) Testfälle.*\x60CI nächtlich\x60 \((\d+).*\x60vor jedem Release\x60 \((\d+)\)/s,
		"CI bei jedem Commit",
		"CI nächtlich",
		"vor jedem Release",
	],
	[
		"English",
		"../VELVE-AUTH-ARCHITECTURE.md",
		/(\d+) test cases, of which (\d+) block every commit/,
		/\x60CI on every commit\x60 \((\d+) test cases.*\x60CI nightly\x60 \((\d+).*\x60before every release\x60 \((\d+)\)/s,
		"CI on every commit",
		"CI nightly",
		"before every release",
	],
])("%s: the tier counts", (_name, file, intro, columns, everyCommit, nightly, release) => {
	const text = readFileSync(new URL(file, import.meta.url), "utf8");
	const tiers = rows(text).map((cells) => cells.at(-1) ?? "");

	it("state the number of cases that block every commit once in the introduction and once under Columns, and both equal the rows", () => {
		const pure = tiers.filter((tier) => tier === everyCommit).length;
		const introClaim = Number(intro.exec(text)?.[2]);
		const columnClaim = Number(columns.exec(text)?.[1]);
		expect({ introClaim, columnClaim }).toStrictEqual({ introClaim: pure, columnClaim: pure });
	});

	it("state the nightly and release counts as the rows have them", () => {
		const claims = columns.exec(text);
		expect({
			nightly: Number(claims?.[2]),
			release: Number(claims?.[3]),
		}).toStrictEqual({
			nightly: tiers.filter((tier) => tier === nightly).length,
			release: tiers.filter((tier) => tier === release).length,
		});
	});
});
