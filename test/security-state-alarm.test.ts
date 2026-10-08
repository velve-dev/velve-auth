import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createSecurityStateAlarms,
	type SecurityStateAlarm,
	type SecurityStateAlarmRaised,
} from "../src/core/security-state/alarm.js";

//the alarm part of T-INTEG-5 runs on an injected clock and fake timers (E-3155)

interface LogLine {
	readonly level: string;
	readonly message: string;
	readonly fields: Readonly<Record<string, unknown>>;
}

function testClock(start = Date.UTC(2026, 9, 8)) {
	let now = start;
	return {
		clock: { now: () => new Date(now) },
		advance(milliseconds: number) {
			now += milliseconds;
		},
	};
}

function instance(callback?: (event: SecurityStateAlarm) => void) {
	const time = testClock();
	const delivered: SecurityStateAlarm[] = [];
	const lines: LogLine[] = [];
	const alarms = createSecurityStateAlarms({
		callback:
			callback ??
			((event) => {
				delivered.push(event);
			}),
		log: (level, message, fields) => {
			lines.push({ level, message, fields });
		},
		clock: time.clock,
	});
	return { alarms, delivered, lines, time };
}

function brokenSignIn(userId: string | null): SecurityStateAlarmRaised {
	return { userId, occasion: "sign_in", reason: "seal_mismatch" };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout"] });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("delivery off the response path", () => {
	it("calls neither the callback nor the log before the refusal has returned", async () => {
		const { alarms, delivered, lines } = instance();

		alarms.raise(brokenSignIn(randomUUID()));

		expect(delivered).toEqual([]);
		expect(lines).toEqual([]);
		await vi.runAllTimersAsync();
		expect(delivered).toHaveLength(1);
	});

	it("writes a warn line with exactly the fields of the alarm", async () => {
		const userId = randomUUID();
		const { alarms, delivered, lines } = instance();

		alarms.raise(brokenSignIn(userId));
		await vi.runAllTimersAsync();

		expect(delivered).toEqual([
			{ userId, occasion: "sign_in", reason: "seal_mismatch", suppressed: 0 },
		]);
		expect(lines).toEqual([
			{
				level: "warn",
				message: "security state alarm",
				fields: { userId, occasion: "sign_in", reason: "seal_mismatch", suppressed: 0 },
			},
		]);
		expect(Object.isFrozen(delivered[0])).toBe(true);
	});

	it("survives a callback that throws or rejects, and logs that without the alarm's account", async () => {
		const throwing = instance(() => {
			throw new Error("sink down, secret=abc");
		});
		const rejecting = instance((() => Promise.reject(new Error("sink down"))) as unknown as (
			event: SecurityStateAlarm,
		) => void);
		const userId = randomUUID();

		expect(() => throwing.alarms.raise(brokenSignIn(userId))).not.toThrow();
		expect(() => rejecting.alarms.raise(brokenSignIn(userId))).not.toThrow();
		await vi.runAllTimersAsync();

		for (const { lines } of [throwing, rejecting]) {
			expect(lines.map((line) => line.level)).toEqual(["warn", "error"]);
			expect(lines[1]?.fields).toEqual({ occasion: "sign_in", reason: "seal_mismatch" });
			expect(JSON.stringify(lines)).not.toContain("secret");
		}
	});

	it("delivers to the log alone when no callback is configured", async () => {
		const time = testClock();
		const lines: LogLine[] = [];
		const alarms = createSecurityStateAlarms({
			callback: undefined,
			log: (level, message, fields) => {
				lines.push({ level, message, fields });
			},
			clock: time.clock,
		});

		alarms.raise(brokenSignIn(randomUUID()));
		await vi.runAllTimersAsync();

		expect(lines.map((line) => line.level)).toEqual(["warn"]);
	});
});

describe("deduplication per account, occasion and reason", () => {
	it("delivers one alarm for 1000 requests against one broken account within 60 seconds", async () => {
		const { alarms, delivered, lines, time } = instance();
		const userId = randomUUID();

		for (let request = 0; request < 1000; request += 1) {
			alarms.raise(brokenSignIn(userId));
			time.advance(59);
		}
		await vi.runAllTimersAsync();

		expect(delivered).toHaveLength(1);
		expect(lines).toHaveLength(1);
	});

	it("does not let one path's alarm hide another's on the same account", async () => {
		const { alarms, delivered } = instance();
		const userId = randomUUID();

		alarms.raise({ userId, occasion: "sign_in", reason: "seal_mismatch" });
		alarms.raise({ userId, occasion: "session_resolve", reason: "seal_mismatch" });
		alarms.raise({ userId, occasion: "sign_in", reason: "key_unusable" });
		await vi.runAllTimersAsync();

		expect(delivered).toHaveLength(3);
	});

	it("keys an alarm about a row without an owner by occasion and reason alone", async () => {
		const { alarms, delivered } = instance();

		alarms.raise(brokenSignIn(null));
		alarms.raise(brokenSignIn(null));
		alarms.raise({ userId: null, occasion: "factor_check", reason: "token_binding_mismatch" });
		await vi.runAllTimersAsync();

		expect(delivered).toEqual([
			{ userId: null, occasion: "sign_in", reason: "seal_mismatch", suppressed: 0 },
			{ userId: null, occasion: "factor_check", reason: "token_binding_mismatch", suppressed: 1 },
		]);
	});

	it("delivers the same key again once its 60 seconds have passed, carrying what was held back", async () => {
		const { alarms, delivered, time } = instance();
		const userId = randomUUID();

		alarms.raise(brokenSignIn(userId));
		time.advance(10_000);
		alarms.raise(brokenSignIn(userId));
		time.advance(50_000);
		alarms.raise(brokenSignIn(userId));
		await vi.runAllTimersAsync();

		expect(delivered.map((event) => event.suppressed)).toEqual([0, 1]);
	});
});

describe("the bound of 100 alarms in 60 seconds and the aggregate alarm", () => {
	it("delivers 100 of 1000 broken accounts, then reports the rest with the next alarm and an aggregate", async () => {
		const { alarms, delivered, lines, time } = instance();
		const accounts = Array.from({ length: 1000 }, () => randomUUID());

		for (const userId of accounts) {
			alarms.raise(brokenSignIn(userId));
			time.advance(59);
		}
		await vi.runAllTimersAsync();
		expect(delivered).toHaveLength(100);
		expect(lines).toHaveLength(100);

		time.advance(1_000);
		const further = randomUUID();
		alarms.raise(brokenSignIn(further));
		await vi.runAllTimersAsync();

		expect(delivered).toHaveLength(101);
		expect(delivered[100]).toEqual({
			userId: further,
			occasion: "sign_in",
			reason: "seal_mismatch",
			suppressed: 900,
		});
		expect(delivered.length + delivered.reduce((sum, event) => sum + event.suppressed, 0)).toBe(
			1001,
		);

		alarms.raise(brokenSignIn(further));
		await vi.runAllTimersAsync();

		expect(delivered).toHaveLength(102);
		expect(delivered[101]).toEqual({
			userId: null,
			occasion: "aggregate",
			reason: "suppressed",
			suppressed: 1,
		});
	});

	it("sends the aggregate even when 100 alarms have gone out in the window, and once per window", async () => {
		const { alarms, delivered, time } = instance();
		time.advance(60_000);
		const accounts = Array.from({ length: 100 }, () => randomUUID());
		for (const userId of accounts) {
			alarms.raise(brokenSignIn(userId));
		}

		alarms.raise(brokenSignIn(accounts[0] ?? ""));
		alarms.raise(brokenSignIn(accounts[1] ?? ""));
		time.advance(59_999);
		alarms.raise(brokenSignIn(randomUUID()));
		await vi.runAllTimersAsync();

		expect(delivered.filter((event) => event.occasion === "aggregate")).toEqual([
			{ userId: null, occasion: "aggregate", reason: "suppressed", suppressed: 1 },
		]);
		expect(delivered).toHaveLength(101);
	});

	it("keeps delivering 100 alarms per window beyond the 10,000 keys it holds", async () => {
		const { alarms, delivered, time } = instance();

		for (let window = 0; window < 101; window += 1) {
			for (let alarm = 0; alarm < 100; alarm += 1) {
				alarms.raise(brokenSignIn(randomUUID()));
			}
			time.advance(60_000);
			await vi.runAllTimersAsync();
		}

		expect(delivered).toHaveLength(10_100);
		expect(delivered.every((event) => event.suppressed === 0)).toBe(true);
	});
});
