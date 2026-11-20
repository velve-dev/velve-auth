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
		const linked = (body: string) => body.slice(0, body.indexOf("createAccountFor("));

		expect(anchorAskedBefore("theIdentityUnderItsAccountLock(", linked)).toBe(true);
		expect(bodyOf("checkedIdentityOf")).toContain("anchorReading");
	});

	//the automatic link that sealed an existing account under its lock is gone (E-3895)
	it("takes no lock on an existing account after the linked-identity branch", () => {
		const creating = (body: string) => body.slice(body.indexOf("createAccountFor("));

		expect(creating(bodyOf("accountForSignIn"))).not.toContain("lockAccountRow(");
		expect(creating(bodyOf("accountForSignIn"))).not.toContain("sealChange(");
	});

	it("asks no anchor inside a function that holds the lock", () => {
		expect(bodyOf("theIdentityUnderItsAccountLock")).not.toContain("consultAnchors(");
	});
});
