import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	reassignsSessionOwner,
	scanBuiltPackage,
	scanTree,
	statementsIn,
} from "../tools/session-owner-update.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY = "src/core/db/repositories/session.ts";
const source = readFileSync(`${repositoryRoot}${REPOSITORY}`, "utf8");

const IDLE_DEADLINE_ASSIGNMENT = "SET last_used_at = now(), idle_expires_at = now() + $3::interval";

function flags(text: string): boolean {
	return statementsIn(text, "//").some(reassignsSessionOwner);
}

/** The fault S-FIX-2 exists to reject, written the way an author of this module would write it. */
function withOwnerReassignment(text: string): string {
	const planted = text.replace(
		IDLE_DEADLINE_ASSIGNMENT,
		`SET user_id = $5, last_used_at = now(), idle_expires_at = now() + $3::interval`,
	);
	if (planted === text) {
		throw new Error("the planted fault did not apply; the statement this test edits has moved");
	}
	return planted;
}

/** The same module with the schema resolved, which is what actually reaches the database. */
function withSchemaSpelledOut(text: string): string {
	const spelled = text.replace(/UPDATE \$\{table\}/, "UPDATE velve.session");
	if (spelled === text) {
		throw new Error("the interpolated table name this test replaces has moved");
	}
	return spelled;
}

describe("S-FIX-2: the gate that rejects an owner reassignment in the source", () => {
	it("rejects a reassignment planted in the module that writes velve.session", () => {
		expect(flags(withOwnerReassignment(source))).toBe(true);
	});

	it("leaves the legitimate idle-deadline write alone once it can read the statement", () => {
		expect(flags(withSchemaSpelledOut(source))).toBe(false);
	});
});

describe("how far the blindness reaches", () => {
	it("catches the same fault as soon as the table name is a literal, so the pattern is not the cause", () => {
		expect(flags(withSchemaSpelledOut(withOwnerReassignment(source)))).toBe(true);
	});

	it("looks at one statement of this module and cannot see the session table in it", () => {
		const considered = statementsIn(source, "//").filter((statement) =>
			/\b(update|merge)\b/i.test(statement),
		);
		const naming = considered.filter((statement) =>
			/\b(?:velve\s*\.\s*)?session\b/i.test(statement),
		);

		expect(considered.length).toBeGreaterThan(0);
		expect(naming).toEqual([]);
	});

	it("finds no statement of this module in the tree scan either", () => {
		const scanned = scanTree();

		expect(scanned.offenders).toEqual([]);
		expect(scanned.statementsScanned).toBeGreaterThan(0);
	});

	it("cannot reach the module through the built package, which does not contain it", () => {
		const built = scanBuiltPackage();

		expect(built.built).toBe(true);
		expect(existsSync(`${repositoryRoot}dist/core/db/repositories/session.mjs`)).toBe(false);
	});
});
