import { describe, expect, it } from "vitest";
import { reassignsSessionOwner, statementsIn } from "../tools/session-owner-update.mjs";

const flags = (source: string, opener = "//") =>
	statementsIn(source, opener).some(reassignsSessionOwner);

const REASSIGNMENTS = [
	["a plain update", "UPDATE velve.session SET user_id = $1 WHERE id = $2"],
	["line breaks and lower case", "update\n  velve.session\nset\n  user_id = $1,\n  ip = $2"],
	["another column set first", "UPDATE velve.session SET last_used_at = now(), user_id = $1"],
	["a comment between the keywords", "UPDATE /* re-owner */ velve.session SET user_id = $1"],
	["an alias", "UPDATE velve.session s SET user_id = $1 FROM velve.user u WHERE u.id = s.user_id"],
	["row syntax", "UPDATE velve.session SET (user_id, ip) = ($1, $2) WHERE id = $3"],
	["an unqualified table", "UPDATE session SET user_id = $1"],
	[
		"an upsert",
		"INSERT INTO velve.session (id, user_id) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id",
	],
	[
		"a merge",
		"MERGE INTO velve.session s USING incoming i ON s.id = i.id WHEN MATCHED THEN UPDATE SET user_id = i.user_id",
	],
] as const;

const PERMITTED = [
	[
		"touching other session columns",
		"UPDATE velve.session SET last_used_at = now() WHERE token_sha256 = $1",
	],
	["another table's owner", "UPDATE velve.identity SET user_id = $1 WHERE id = $2"],
	["a similarly named table", "UPDATE velve.session_backup SET user_id = $1"],
	["a semicolon inside a literal", "UPDATE velve.session SET note = 'a;b', last_used_at = now()"],
] as const;

const EVASIONS = [
	[
		"dynamic SQL inside a single-quoted string",
		"EXECUTE format('UPDATE velve.session SET user_id = %L', 1);",
	],
	[
		"a double-quoted string that looks like a block comment",
		'const pattern = "/*";\nconst q = "UPDATE velve.session SET user_id = $1";',
	],
	[
		"a url whose slashes look like a line comment",
		'const u = "https://a";\nconst q = `UPDATE velve.session SET user_id = $1`;',
	],
] as const;

const IGNORED_IN_CONTEXT = [
	["prose in a line comment", "// never write UPDATE velve.session SET user_id"],
	["prose in a block comment", "/* UPDATE velve.session SET user_id is forbidden */"],
] as const;

describe("session owner reassignment detector", () => {
	it.each(REASSIGNMENTS)("flags %s", (_name, sql) => {
		expect(reassignsSessionOwner(sql)).toBe(true);
	});

	it.each(PERMITTED)("leaves %s alone", (_name, sql) => {
		expect(reassignsSessionOwner(sql)).toBe(false);
	});

	it.each(EVASIONS)("sees through %s", (_name, source) => {
		expect(flags(source)).toBe(true);
	});

	it.each(IGNORED_IN_CONTEXT)("still ignores %s", (_name, source) => {
		expect(flags(source)).toBe(false);
	});

	it("is not blinded by a decrement in TypeScript", () => {
		expect(flags("let i = 0;\ni--;\nconst q = `UPDATE velve.session SET user_id = $1`;")).toBe(
			true,
		);
	});

	it("still treats -- as a comment in SQL", () => {
		expect(flags("-- UPDATE velve.session SET user_id is forbidden", "--")).toBe(false);
	});
});
