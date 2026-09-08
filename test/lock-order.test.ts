import { describe, expect, it } from "vitest";
import { lockOrderViolations } from "../tools/lock-order.mjs";
import fixtures from "./fixtures/lock-order-sql.json" with { type: "json" };

const cases = (name: keyof typeof fixtures) =>
	fixtures[name].map(([label, sql]) => [label, sql] as [string, string]);

describe("lock order", () => {
	it.each(cases("permitted"))("allows %s", (_label, sql) => {
		expect(lockOrderViolations(sql)).toEqual([]);
	});

	it.each(cases("forbidden"))("refuses %s", (_label, sql) => {
		expect(lockOrderViolations(sql).length).toBeGreaterThan(0);
	});
});
