import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const moduleRoot = new URL("../src/core/limit/", import.meta.url);

/**
 * S-RATE-7 forbids the two answers a rate limiter is usually written with: holding the caller,
 * and locking the account. This is an allowlist rather than a list of forbidden stems, because a
 * denylist can only say "no stem I know of matched" — it passed `minimumResponseTime`, which is
 * the most natural good-faith name there is for the artificial delay the requirement forbids
 * (E-394). Every member below has been read and is not a delay and not a lock. **A name that is
 * not on this list fails the build until somebody adds it, and adding one is the moment to ask
 * what it does.**
 */
const REVIEWED_MEMBERS: Readonly<Record<string, string>> = {
	addressChecksObserved: "how many address checks this route has taken on this instance",
	alerted: "whether the alarm has already fired for the current exhaustion",
	bucketKey: "the primary key of the row the statement writes",
	capacity: "how many requests the bucket holds",
	clock: "where the instant of a check comes from",
	config: "the optional configuration below",
	driver: "the database the one statement runs on",
	draw: "take one token and report the level that is left",
	keys: "the KeyProvider the account digest is taken under",
	lifetimeInSeconds: "how long the row lives before a sweep may remove it",
	network: "a trusted proxy entry masked to its prefix",
	observe: "record one address check against a route",
	observedAt: "the instant the check was measured at",
	onAlert: "the alarm sink, which refuses nothing",
	prefixLengths: "how many leading bits of an address a comparison keeps",
	refillPerSecond: "how fast tokens flow back into the bucket",
	routeFlood: "the per-route alarm",
	routeName: "the resolved route name a key is scoped to",
	rule: "a capacity and a refill rate",
	schema: "the PostgreSQL schema holding velve.rate_bucket",
	tokens: "the level a bucket currently holds",
	updatedAt: "when the level was last written",
};

const DECLARED_MEMBER = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?:(]/;

interface Member {
	readonly file: string;
	readonly name: string;
}

function limitModuleFiles(): string[] {
	return readdirSync(moduleRoot).filter((entry) => entry.endsWith(".ts"));
}

/** Every member of every declared type in the module, which is a superset of the option types
 * and therefore cannot miss one by being pointed at the wrong interface. */
function declaredMembers(): Member[] {
	const members: Member[] = [];
	for (const file of limitModuleFiles()) {
		const text = readFileSync(fileURLToPath(new URL(file, moduleRoot)), "utf8");
		let insideType = false;
		for (const line of text.split("\n")) {
			if (/^(?:export )?interface [\w$]+/.test(line)) {
				insideType = true;
				continue;
			}
			if (line.startsWith("}")) {
				insideType = false;
				continue;
			}
			const member = insideType ? DECLARED_MEMBER.exec(line) : null;
			if (member !== null) {
				members.push({ file, name: String(member[1]) });
			}
		}
	}
	return members;
}

/** The names the gate planted against the first form of this check and got past it, plus the
 * six it caught. A denylist answered "no stem matched" for the first six; an allowlist answers
 * "this name was never reviewed" for all twelve. */
const PLANTED_NAMES = [
	"minimumResponseTime",
	"waitMs",
	"pauseBeforeAnswerMs",
	"holdForMs",
	"slowResponseFloorMs",
	"jitterMs",
	"lockoutSeconds",
	"accountLockoutSeconds",
	"delayInMilliseconds",
	"artificialDelay",
	"banUntil",
	"perAccountCooldownSeconds",
];

describe("T-RATE-7 — the option surface offers no delay and no lock (S-RATE-7)", () => {
	it("finds members to inspect at all, so a passing scan means something", () => {
		const members = declaredMembers();

		expect(limitModuleFiles().length).toBeGreaterThan(3);
		expect(members.length).toBeGreaterThan(15);
		expect(members.map((member) => member.name)).toContain("refillPerSecond");
	});

	it("declares no member that has not been read and allowed", () => {
		const unreviewed = declaredMembers()
			.filter((member) => !Object.hasOwn(REVIEWED_MEMBERS, member.name))
			.map((member) => `${member.file}: ${member.name}`);

		expect(unreviewed).toEqual([]);
	});

	/** An allowlist that outlives the names it allows stops being a list of what is there and
	 * becomes a list of what once was, which is how the next planted name finds a slot waiting
	 * for it. */
	it("allows no name the module no longer declares", () => {
		const declared = new Set(declaredMembers().map((member) => member.name));
		const stale = Object.keys(REVIEWED_MEMBERS).filter((name) => !declared.has(name));

		expect(stale).toEqual([]);
	});

	it("would report every name the gate planted, including the six a denylist let through", () => {
		const unreviewed = PLANTED_NAMES.filter((name) => !Object.hasOwn(REVIEWED_MEMBERS, name));

		expect(unreviewed).toEqual(PLANTED_NAMES);
	});

	/** `Object.hasOwn` rather than `in`, so a member named `toString` or `constructor` is
	 * unreviewed like any other rather than inherited from the prototype and silently allowed. */
	it("reads no name off the prototype of its own allowlist", () => {
		for (const inherited of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
			expect(Object.hasOwn(REVIEWED_MEMBERS, inherited)).toBe(false);
		}
	});
});
