import { describe, expect, it } from "vitest";
import { locksSomethingBeforeUser } from "../tools/lock-order.mjs";
import fixtures from "./fixtures/lock-order-sql.json" with { type: "json" };

const cases = (name: keyof typeof fixtures) =>
	fixtures[name].map(([label, sql]) => [label, sql] as [string, string]);

describe("lock order", () => {
	it.each(cases("permitted"))("allows locking %s", (_label, sql) => {
		expect(locksSomethingBeforeUser(sql)).toEqual([]);
	});

	it.each(cases("forbidden"))("refuses locking %s", (_label, sql) => {
		expect(locksSomethingBeforeUser(sql).length).toBeGreaterThan(0);
	});
});
