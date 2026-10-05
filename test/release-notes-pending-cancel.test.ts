import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * E-2830 made `auth.pending.cancel` take the call fields, so a 1.1 caller passing `{ pendingToken }`
 * alone no longer compiles, and its Price says the release notes have to name the break. The
 * release is 2.0.0 (E-3020), and its notes open with every break before anything else (E-3023).
 */

const { version } = JSON.parse(
	readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { version: string };

const notes = readFileSync(
	fileURLToPath(new URL(`../docs/releases/${version}.md`, import.meta.url)),
	"utf8",
);

function between(startMarker: string, endMarker: string): string {
	const start = notes.indexOf(startMarker);
	const end = notes.indexOf(endMarker, start + startMarker.length);
	if (start < 0 || end < 0) {
		throw new Error(`the passage from ${startMarker} to ${endMarker} was not found`);
	}
	return notes.slice(start, end);
}

function breakingList(): string {
	return between("Can break compilation:", "Additive:");
}

function breakingChanges(): string {
	return between("\n## Breaking changes\n", "\n## ");
}

describe(`the ${version} release notes (E-2830, E-3023)`, () => {
	it("are titled with the version package.json states", () => {
		expect(notes.split("\n")[0]).toBe(`# @velve/auth ${version}`);
	});

	it("name pending.cancel among the changes that can break compilation", () => {
		expect(breakingList()).toContain("pending.cancel");
	});

	it("open with the breaking changes, before the upgrade steps and every other section", () => {
		const headings = notes.split("\n").filter((line) => line.startsWith("## "));

		expect(headings.slice(0, 3)).toStrictEqual([
			"## Summary",
			"## Breaking changes",
			"## Upgrading from 1.x",
		]);
	});

	it.each([
		"@velve/auth/postgres-js",
		"@velve/auth/neon",
		"@velve/auth/import",
		"findByEmail",
		"pending.cancel",
		"session.cookieName",
		"beforeSessionRevoke",
		"beforeSignIn",
		"perIpAddress",
		"plugin_route_without_address_rate_limit",
		"rate_limit_bucket_unusable",
		"plugin_migration_table_not_an_identifier",
		"absoluteTimeout",
		"RevokeReason",
		"sessionCookieName",
	])("list %s among the breaking changes", (name) => {
		expect(breakingChanges()).toContain(name);
	});

	it("say that 1.x gets no further releases", () => {
		expect(between("## Summary", "\n## Breaking changes")).toMatch(/1\.x gets no further releases/);
	});
});
