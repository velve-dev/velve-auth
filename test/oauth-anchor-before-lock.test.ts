import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

//minimumVersion is asked before the account lock so no connection holds the lock while it waits on the application (S-INTEG-6)

const source = readFileSync(new URL("../src/core/oauth/service.ts", import.meta.url), "utf8");

function bodyOf(name: string): string {
	const start = source.indexOf(`async function ${name}(`);
	expect(start).toBeGreaterThan(-1);
	const next = source.indexOf("\n\tasync function ", start + 1);
	return source.slice(start, next === -1 ? undefined : next);
}

describe("the OAuth sign-in asks the anchor before it takes the account lock (S-INTEG-6)", () => {
	it("checks a linked identity's account with the anchor asked before theIdentityUnderItsAccountLock", () => {
		const body = bodyOf("accountForSignIn");
		const lock = body.indexOf("theIdentityUnderItsAccountLock(");
		const anchorAsked = body.indexOf("checkedIdentityOf(");
		expect({ lock, anchorAsked }).toSatisfy(
			({ lock, anchorAsked }: { lock: number; anchorAsked: number }) =>
				lock === -1 || anchorAsked === -1 || anchorAsked < lock,
		);
	});

	it("seals the automatic link with the anchor asked before theJoinableAccountUnderItsLock", () => {
		const body = bodyOf("accountForSignIn");
		const lock = body.indexOf("theJoinableAccountUnderItsLock(");
		const anchorAsked = body.indexOf("sealChange(");
		expect({ lock, anchorAsked }).toSatisfy(
			({ lock, anchorAsked }: { lock: number; anchorAsked: number }) =>
				lock === -1 || anchorAsked === -1 || anchorAsked < lock,
		);
	});
});
