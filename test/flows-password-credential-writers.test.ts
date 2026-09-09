import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PasswordCredentialRepository } from "../src/core/password/credential.js";

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
 * The property, not the file. A census of files that reach the table cannot tell a writer that
 * records the provenance from one that does not — and the file that would forget was already on the
 * list, so a future `/password/set` calling the one write path would have tripped nothing. What
 * stops it is the signature: `write` demands `setBySessionId`, so a caller has to answer, and `null`
 * is an answer that costs the credential rather than defeating S-LINK-4 (E-596 corrected by E-626).
 */
describe("no password reaches the table without saying which session stored it (E-626)", () => {
	it("has more than nothing to scan", () => {
		expect(sources.length).toBeGreaterThan(20);
	});

	it("does not compile a write that leaves the provenance out", () => {
		const withoutProvenance = (repository: PasswordCredentialRepository) =>
			// @ts-expect-error S-LINK-4 is decided on this column, so omitting it is a compile error.
			repository.write({
				userId: "a",
				phc: "$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA",
				scheme: "argon2id",
			});
		const withProvenance = (repository: PasswordCredentialRepository) =>
			repository.write({
				userId: "a",
				phc: "$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA",
				scheme: "argon2id",
				setBySessionId: null,
			});

		expect(withoutProvenance).toBeInstanceOf(Function);
		expect(withProvenance).toBeInstanceOf(Function);
	});

	it("writes the column on the insert and on the conflict, so an upsert cannot leave a stale one", () => {
		const repository = readFileSync(`${coreDirectory}/password/credential.ts`, "utf8");
		const upsert = statementsIn(repository).find((sql) => /\bINSERT\b/i.test(sql)) ?? "";

		expect(upsert).toContain("set_by_session_id)");
		expect(upsert).toContain("set_by_session_id = EXCLUDED.set_by_session_id");
	});

	/**
	 * The second net, and the weaker one: it says which files reach the table at all, so a writer
	 * that bypasses the repository with its own statement has to be added here and reads the rule
	 * while doing it. It cannot see a writer that goes through the repository — that is what the
	 * signature above is for.
	 */
	it("reaches the table from the schema, the two repositories and the removal, and nowhere else", () => {
		const namesTheTable = /"password_credential"|velve\.password_credential/;
		const naming = sources
			.filter(
				(source) =>
					namesTheTable.test(source.text) ||
					statementsIn(source.text).some((sql) => sql.includes("password_credential")),
			)
			.map((source) => source.path);

		expect(naming).toStrictEqual([
			"auth/user.ts",
			"db/migrations/initial-schema.ts",
			"flows/credential.ts",
			"identity/sign-in-methods.ts",
			"password/credential.ts",
		]);
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
