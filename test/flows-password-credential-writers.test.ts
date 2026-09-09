import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const coreDirectory = fileURLToPath(new URL("../src/core", import.meta.url));

function coreSources(): readonly { readonly path: string; readonly text: string }[] {
	return readdirSync(coreDirectory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => `${entry.parentPath}/${entry.name}`)
		.sort()
		.map((path) => ({
			path: path.replace(`${coreDirectory}/`, ""),
			text: readFileSync(path, "utf8"),
		}));
}

const sources = coreSources();

const LOOKS_LIKE_SQL = /\b(SELECT|INSERT|UPDATE|DELETE|MERGE|CREATE)\b/i;

function statementsIn(text: string): readonly string[] {
	return [...text.matchAll(/`([^`]*)`/g)]
		.map((match) => match[1] ?? "")
		.filter((literal) => LOOKS_LIKE_SQL.test(literal));
}

/**
 * Every repository builds its table name from the configured schema, so the name is never inside
 * the statement — CLAUDE.md §7 names that trap, and a scan of SQL literals alone finds only the
 * migration. What a file reaches the table with is the quoted name it hands `qualifiedTableName`.
 */
const NAMES_THE_TABLE =
	/"password_credential"|CREATE TABLE \$\{?[a-z]*\}?\.?velve\.password_credential|velve\.password_credential/;

function reachesTheTable(source: { readonly text: string }): boolean {
	return (
		NAMES_THE_TABLE.test(source.text) ||
		statementsIn(source.text).some((sql) => sql.includes("password_credential"))
	);
}

/**
 * E-596: `set_by_session_id` is NULL for any credential written by a path that does not record it,
 * and NULL is read as a different session — so a writer that forgets loses the user's password at
 * their next first confirmation, in silence and on the legitimate path. Nothing can tell a writer
 * that records the provenance from one that does not, so what this pins is the set of files that
 * reach the table at all: a new one has to be added here, and reads the rule while doing it.
 */
const FILES_THAT_REACH_THE_CREDENTIAL_TABLE: readonly string[] = [
	"auth/user.ts",
	"db/migrations/initial-schema.ts",
	"flows/credential.ts",
	"identity/sign-in-methods.ts",
	"password/credential.ts",
];

describe("who writes velve.password_credential (E-595, E-596)", () => {
	it("has more than nothing to scan", () => {
		expect(sources.length).toBeGreaterThan(20);
	});

	it("names the table in the schema, the two repositories, the removal and this feature's provenance", () => {
		const naming = sources.filter(reachesTheTable).map((source) => source.path);

		expect(naming).toStrictEqual([...FILES_THAT_REACH_THE_CREDENTIAL_TABLE]);
	});

	it("keeps the provenance column out of every statement but this feature's two", () => {
		const naming = sources
			.filter((source) => source.text.includes("set_by_session_id"))
			.map((source) => source.path);

		expect(naming).toStrictEqual(["db/migrations/initial-schema.ts", "flows/credential.ts"]);
	});

	/**
	 * The predicate S-LINK-4 turns on. A credential survives only when a session is named on both
	 * sides and the two are the same; every other combination is a different session (E-609).
	 */
	it("deletes unless both sides name a session and the two agree", () => {
		const provenance = readFileSync(`${coreDirectory}/flows/credential.ts`, "utf8");
		const deletion = statementsIn(provenance).find((sql) => /^\s*DELETE\b/i.test(sql)) ?? "";

		expect(deletion).toContain("$2::uuid IS NULL OR set_by_session_id IS DISTINCT FROM $2::uuid");
		expect(deletion).toContain("WHERE user_id = $1");
	});
});
