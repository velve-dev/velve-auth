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

function anchorAskedBefore(lockCall: string, branch: (body: string) => string): boolean {
	const body = branch(bodyOf("accountForSignIn"));
	const asked = body.indexOf("consultAnchors(");
	const lock = body.indexOf(lockCall);
	return asked !== -1 && lock !== -1 && asked < lock;
}

describe("the OAuth sign-in asks the anchor before it takes the account lock (S-INTEG-6)", () => {
	it("checks a linked identity's account with the anchor asked before theIdentityUnderItsAccountLock", () => {
		const linked = (body: string) => body.slice(0, body.indexOf("accountAnAutomaticLinkMayJoin("));

		expect(anchorAskedBefore("theIdentityUnderItsAccountLock(", linked)).toBe(true);
		expect(bodyOf("checkedIdentityOf")).toContain("anchorReading");
	});

	it("seals the automatic link with the anchor asked before theJoinableAccountUnderItsLock", () => {
		const joining = (body: string) => body.slice(body.indexOf("accountAnAutomaticLinkMayJoin("));

		expect(anchorAskedBefore("theJoinableAccountUnderItsLock(", joining)).toBe(true);
		expect(joining(bodyOf("accountForSignIn"))).toContain("anchorReading: anchored");
	});

	it("asks no anchor inside a function that holds the lock", () => {
		for (const name of ["theIdentityUnderItsAccountLock", "theJoinableAccountUnderItsLock"]) {
			expect(bodyOf(name)).not.toContain("consultAnchors(");
		}
	});
});
