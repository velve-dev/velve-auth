import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Section 3.18 *Sealing* puts the consumption first where CLAUDE.md section 7 and E-1616 do, and
// the account lock after it. Resetting the password is such a change: it consumes its one-time
// token before it reaches the account lock. The case holds that order. Its earlier comment and
// title described the snapshot rule of E-3209, which E-3280 abandoned (E-3302).

function bodyOf(source: string, from: string, to: string): string {
	const start = source.indexOf(from);
	const end = source.indexOf(to, start + from.length);
	return source.slice(start, end);
}

describe("the order of consumption and account lock in a sealing change (section 3.18, Sealing)", () => {
	it("consumes the reset token before it reaches the account lock", () => {
		const source = readFileSync("src/core/flows/reset.ts", "utf8");
		const redeem = bodyOf(source, "export async function redeemReset(", "export async function");
		const consumeAt = redeem.indexOf("redeemOrRefuse(");
		const lockReachedThrough = redeem.indexOf("replacePassword(");
		expect(consumeAt).toBeGreaterThan(-1);
		expect(lockReachedThrough).toBeGreaterThan(-1);
		expect(consumeAt).toBeLessThan(lockReachedThrough);
	});
});
