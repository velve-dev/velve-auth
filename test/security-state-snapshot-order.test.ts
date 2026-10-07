import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Section 3.18 *Sealing* takes a sealing change's snapshot with the transaction's first statement,
// which is the consumption where CLAUDE.md section 7 and E-1616 put one first. Resetting the
// password is such a change: it consumes its one-time token before it reaches the account lock.
// The case holds that order, which an earlier wording of 3.18 ruled out (E-3209).

function bodyOf(source: string, from: string, to: string): string {
	const start = source.indexOf(from);
	const end = source.indexOf(to, start + from.length);
	return source.slice(start, end);
}

describe("the statement that takes a sealing change's snapshot (section 3.18, Sealing)", () => {
	it("is the consumption of the reset token, which comes before the account lock", () => {
		const source = readFileSync("src/core/flows/reset.ts", "utf8");
		const redeem = bodyOf(source, "export async function redeemReset(", "export async function");
		const consumeAt = redeem.indexOf("redeemOrRefuse(");
		const lockReachedThrough = redeem.indexOf("replacePassword(");
		expect(consumeAt).toBeGreaterThan(-1);
		expect(lockReachedThrough).toBeGreaterThan(-1);
		expect(consumeAt).toBeLessThan(lockReachedThrough);
	});
});
