import { describe, expect, it } from "vitest";
import { lockOrderViolations, scanLockOrder } from "../tools/lock-order.mjs";
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

	/* The tree holds one row lock, in `src/core/db/lock.ts`, and the counts are asserted rather than
	   only printed: a scan that matched no file reports no offender, which is the shape three of this
	   repository's checks were written in (E-1609). */
	it("finds the one row lock the tree is allowed and no other", () => {
		const { offenders, filesScanned, locksScanned } = scanLockOrder();

		expect(offenders).toEqual([]);
		expect(locksScanned).toBe(1);
		expect(filesScanned).toBeGreaterThan(100);
	});
});
