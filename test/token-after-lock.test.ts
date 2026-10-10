import { describe, expect, it } from "vitest";
import { scanTokenAfterLock, tokenReachedAfterAccountLock } from "../tools/token-after-lock.mjs";

const LOCK = "await lockAccountRow(transaction, schema, userId);";

/**
 * CLAUDE.md §7 states a second ordering: `velve.one_time_token` comes before `velve.user`
 * everywhere, which is what makes it safe for four redeem flows to consume a token row before they
 * can lock the account. `E-1616` found that invariant held by a reading of every call site and by
 * nothing else — `check:lock-order` decides a statement's mode, the cycle analyser exempts the
 * artefact tables by name, and a transaction closing the cycle would pass both.
 */
describe("nothing reaches one_time_token after taking the account row (E-1616)", () => {
	it("passes the shipped tree, which takes the account row and never reaches back", () => {
		const { offenders, filesScanned, locksScanned } = scanTokenAfterLock();

		expect(offenders).toStrictEqual([]);
		expect(filesScanned).toBeGreaterThan(50);
		expect(locksScanned).toBeGreaterThan(5);
	});

	it("reports raw SQL that names the table after the lock", () => {
		const source = `${LOCK}\nawait transaction.query("DELETE FROM velve.one_time_token", []);`;

		expect(tokenReachedAfterAccountLock(source)).toStrictEqual(["one_time_token"]);
	});

	it.each(["replaceOneTimeToken", "consumeOneTimeToken", "mintArtefact"])(
		"reports %s, because it is one of the other ways to that table",
		(method) => {
			expect(tokenReachedAfterAccountLock(`${LOCK}\nawait tokens.${method}({});`)).toStrictEqual([
				method,
			]);
		},
	);

	/** The order the four redeem flows actually run, and the one this rule exists to permit. */
	it("permits the token being consumed before the account row is locked", () => {
		const source = `await tokens.consumeOneTimeToken({});\n${LOCK}`;

		expect(tokenReachedAfterAccountLock(source)).toStrictEqual([]);
	});

	it("says nothing about a file that never locks the account", () => {
		expect(tokenReachedAfterAccountLock("await tokens.replaceOneTimeToken({});")).toStrictEqual([]);
	});

	/**
	 * `src/core/db/lock.ts` states this very rule in a doc comment naming the table, and every
	 * caller imports `lockAccountRow` by name before calling it. Reading either as code reports the
	 * tree as broken.
	 */
	it("reads neither a comment about the rule nor an import of the lock as reaching for the table", () => {
		const prose = `/** one_time_token is ordered before the account row. */\n${LOCK}`;
		const imported = `import { lockAccountRow } from "../db/lock.js";\nimport { consumeOneTimeToken } from "./token.js";`;

		expect(tokenReachedAfterAccountLock(prose)).toStrictEqual([]);
		expect(tokenReachedAfterAccountLock(imported)).toStrictEqual([]);
	});

	it("reports every reach after the first lock, not only the first", () => {
		const source = `${LOCK}\nawait tokens.replaceOneTimeToken({});\nawait tokens.consumeOneTimeToken({});`;

		expect(tokenReachedAfterAccountLock(source)).toStrictEqual([
			"replaceOneTimeToken",
			"consumeOneTimeToken",
		]);
	});

	/** A helper imported under another name is called by that name, which the plain names miss. */
	it("reports a mint helper the import renames, under the name it was exported as", () => {
		const source = [
			'import { mintArtefact as mint } from "./artefact.js";',
			LOCK,
			"await mint(transaction, schema, {});",
		].join("\n");

		expect(tokenReachedAfterAccountLock(source)).toStrictEqual(["mintArtefact"]);
	});

	it("reads a renamed lock as taking the account row", () => {
		const source = [
			'import { lockAccountRow as holdAccount } from "../db/lock.js";',
			"await holdAccount(transaction, schema, userId);",
			"await tokens.consumeOneTimeToken({});",
		].join("\n");

		expect(tokenReachedAfterAccountLock(source)).toStrictEqual(["consumeOneTimeToken"]);
	});

	it("does not read a renamed import of anything else as reaching for the table", () => {
		const source = [
			'import { createSessionRepository as sessions } from "../db/session.js";',
			LOCK,
			"await sessions(transaction);",
		].join("\n");

		expect(tokenReachedAfterAccountLock(source)).toStrictEqual([]);
	});
});
