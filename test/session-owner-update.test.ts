import { describe, expect, it } from "vitest";
import {
	reassignsSessionOwner,
	reportOn,
	scanTree,
	statementsIn,
} from "../tools/session-owner-update.mjs";
import fixtures from "./fixtures/session-owner-sql.json" with { type: "json" };

const flags = (source: string, opener = "//") =>
	statementsIn(source, opener).some(reassignsSessionOwner);

const cases = (name: keyof typeof fixtures) =>
	fixtures[name].map(([label, sql]) => [label, sql] as [string, string]);

describe("session owner reassignment detector", () => {
	it.each(cases("reassignments"))("flags %s", (_label, sql) => {
		expect(reassignsSessionOwner(sql)).toBe(true);
	});

	it.each(cases("permitted"))("leaves %s alone", (_label, sql) => {
		expect(reassignsSessionOwner(sql)).toBe(false);
	});

	it.each(cases("evasions"))("sees through %s", (_label, source) => {
		expect(flags(source)).toBe(true);
	});

	it.each(cases("ignoredInContext"))("still ignores %s", (_label, source) => {
		expect(flags(source)).toBe(false);
	});

	it.each(cases("ignoredInSqlComments"))("still ignores %s", (_label, source) => {
		expect(flags(source, "--")).toBe(false);
	});
});

const SCANNED_NOTHING = { offenders: [], statementsScanned: 0 };
const SCANNED_CLEANLY = { offenders: [], statementsScanned: 42 };
const NO_BUILD = { ...SCANNED_NOTHING, built: false };
const CLEAN_BUILD = { offenders: [], statementsScanned: 21, built: true };
const ACCUSES = "a session owner is reassigned in SQL";
const REFUSES = "refusing to report";
const ADVICE = "move it into a comment";

/**
 * §5 asks a check to tell *found nothing* from *could not look*, and this one answered both with the
 * words of a security violation: with no `dist/` at all it printed the accusation, named no offender
 * and exited 1 (E-1624). The two conditions are separated here rather than at the call site, so a
 * step that is one `console.error` away from conflating them again reddens instead.
 */
describe("what the step reports, and which of the two it is reporting", () => {
	it("accuses nobody when the built package is missing, and says the scan could not look", () => {
		const { refusals, findings, exitCode } = reportOn(SCANNED_CLEANLY, NO_BUILD);

		expect(exitCode).toBe(1);
		expect(refusals.join("\n")).toContain(REFUSES);
		expect(refusals.join("\n")).toContain("dist/");
		expect(findings).toEqual([]);
		expect([...refusals, ...findings].join("\n")).not.toContain(ACCUSES);
		expect([...refusals, ...findings].join("\n")).not.toContain(ADVICE);
	});

	/** `scanBuiltPackage` calls a build present on the strength of one `.mjs`, so an interrupted
	 * `tsdown` leaves a dist/ that is read and yields nothing. That is *could not look* wearing the
	 * face of *found nothing*, one surface along from the gap this step was repaired for (E-1662). */
	it("accuses nobody when dist/ holds modules but no statement was read from them", () => {
		const { refusals, findings, exitCode } = reportOn(SCANNED_CLEANLY, {
			offenders: [],
			statementsScanned: 0,
			built: true,
		});

		expect(exitCode).toBe(1);
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toContain(REFUSES);
		expect(refusals[0]).toContain("dist/");
		expect(findings).toEqual([]);
		expect([...refusals, ...findings].join("\n")).not.toContain(ACCUSES);
	});

	/** One refusal, not two: an absent dist/ reads no statement by construction, and saying so twice
	 * would make the louder answer the one with less behind it. */
	it("says the build is missing once when it is missing, rather than once for each symptom", () => {
		expect(reportOn(SCANNED_CLEANLY, NO_BUILD).refusals).toHaveLength(1);
	});

	it("accuses nobody when the working tree yielded no statement either", () => {
		const { refusals, findings, exitCode } = reportOn(SCANNED_NOTHING, CLEAN_BUILD);

		expect(exitCode).toBe(1);
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toContain(REFUSES);
		expect(findings).toEqual([]);
	});

	it("names the file and the statement when it does accuse, and offers the advice", () => {
		const offender = "src/core/db/plant.ts: UPDATE velve.session SET user_id = $2 WHERE id = $1";
		const { refusals, findings, exitCode } = reportOn(
			{ offenders: [offender], statementsScanned: 42 },
			CLEAN_BUILD,
		);

		expect(exitCode).toBe(1);
		expect(refusals).toEqual([]);
		expect(findings[0]).toContain(ACCUSES);
		expect(findings.join("\n")).toContain(offender);
		expect(findings.at(-1)).toContain(ADVICE);
	});

	/** The advice says to move prose into a comment. `statementsIn` has already dropped every comment
	 * by then, so it can only be about source; a built module carries no prose to move. */
	it("withholds the advice from an offender that exists only in the built package", () => {
		const { findings } = reportOn(SCANNED_CLEANLY, {
			offenders: ["dist/index.mjs: UPDATE velve.session SET user_id = $2"],
			statementsScanned: 21,
			built: true,
		});

		expect(findings[0]).toContain(ACCUSES);
		expect(findings.join("\n")).toContain("dist/index.mjs");
		expect(findings.join("\n")).not.toContain(ADVICE);
	});

	it("reports both when the build is missing and the tree does carry an offender", () => {
		const { refusals, findings, exitCode } = reportOn(
			{
				offenders: ["src/core/db/plant.ts: UPDATE velve.session SET user_id = $2"],
				statementsScanned: 42,
			},
			NO_BUILD,
		);

		expect(exitCode).toBe(1);
		expect(refusals).toHaveLength(1);
		expect(findings[0]).toContain(ACCUSES);
	});

	it("says how much it read, and says nothing else, when there is nothing to report", () => {
		const { refusals, findings, summary, exitCode } = reportOn(SCANNED_CLEANLY, CLEAN_BUILD);

		expect(exitCode).toBe(0);
		expect([...refusals, ...findings]).toEqual([]);
		expect(summary).toBe(
			"S-FIX-2: 42 source and 21 built statements scanned, no session owner reassignment",
		);
	});
});

/** A count the scan reports rather than only prints: a filter that matched no file reports no
 * offender, which is the shape three of this repository's checks were written in (E-1609). */
describe("the scan over the tree reads something", () => {
	it("finds statements to inspect in the working tree", () => {
		expect(scanTree().statementsScanned).toBeGreaterThan(20);
	});
});
