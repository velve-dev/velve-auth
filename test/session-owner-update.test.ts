import { describe, expect, it } from "vitest";
import { reassignsSessionOwner, statementsIn } from "../tools/session-owner-update.mjs";
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
