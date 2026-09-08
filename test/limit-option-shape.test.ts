import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const moduleRoot = new URL("../src/core/limit/", import.meta.url);

/** S-RATE-7 forbids the two answers a rate limiter is usually written with: holding the caller,
 * and locking the account. Neither can be configured if neither has a name. */
const A_DELAY_OR_A_LOCK = [
	"delay",
	"lock",
	"block",
	"ban",
	"freeze",
	"penal",
	"sleep",
	"backoff",
	"throttle",
	"suspend",
	"quarantine",
	"cooldown",
];

/** A word boundary never falls inside `accountLockoutSeconds`, so the name is split on its case
 * changes first. Matching the whole name instead would report `clock`. */
function wordsOf(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word !== "");
}

function namesADelayOrALock(name: string): boolean {
	return wordsOf(name).some((word) => A_DELAY_OR_A_LOCK.some((stem) => word.startsWith(stem)));
}

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

describe("T-RATE-7 — the option surface offers no delay and no lock (S-RATE-7)", () => {
	it("finds members to inspect at all, so a passing scan means something", () => {
		const members = declaredMembers();

		expect(limitModuleFiles().length).toBeGreaterThan(3);
		expect(members.length).toBeGreaterThan(15);
		expect(members.map((member) => member.name)).toContain("refillPerSecond");
	});

	it("names no option for holding a caller or for locking an account", () => {
		const offenders = declaredMembers()
			.filter((member) => namesADelayOrALock(member.name))
			.map((member) => `${member.file}: ${member.name}`);

		expect(offenders).toEqual([]);
	});

	/** The first form of this check read the whole name with a word boundary in front of the
	 * stem, and `accountLockoutSeconds` has no boundary before `Lockout`. It passed a planted
	 * option, and the self-test below passed with it because `lockoutSeconds` starts with the
	 * stem — the probe was aimed at the one spelling the fault could not take. */
	it("reports a planted option however it is spelled", () => {
		expect(DECLARED_MEMBER.exec("	readonly lockoutSeconds?: number;")?.[1]).toBe("lockoutSeconds");
		for (const planted of [
			"lockoutSeconds",
			"accountLockoutSeconds",
			"delayInMilliseconds",
			"artificialDelay",
			"banUntil",
			"perAccountCooldownSeconds",
		]) {
			expect(namesADelayOrALock(planted)).toBe(true);
		}
	});

	it("reports none of the names this module actually uses", () => {
		for (const kept of ["refillPerSecond", "capacity", "clock", "routeFlood", "observedAt"]) {
			expect(namesADelayOrALock(kept)).toBe(false);
		}
	});
});
