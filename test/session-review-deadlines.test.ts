import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { createSessionService, type SessionService } from "../src/core/session/service.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { HOUR, MINUTE, type TestClock, testClock } from "./session-fixtures.js";

const NOWHERE = { ipAddress: null, userAgent: null };

interface Counter {
	readonly driver: Driver;
	readonly verbs: string[];
	reset(): void;
}

function countingByVerb(inner: Driver): Counter {
	const verbs: string[] = [];
	const driver: Driver = {
		query(sql, params) {
			verbs.push(sql.trimStart().split(/\s+/, 1)[0]?.toUpperCase() ?? "");
			return inner.query(sql, params);
		},
		transaction: (fn) => inner.transaction(fn),
	};
	return { driver, verbs, reset: () => verbs.splice(0, verbs.length) };
}

let migrated: MigratedSchema;
let counter: Counter;
let clock: TestClock;
let service: SessionService;
let userId: string;

async function shift(sessionId: string, columns: readonly string[], by: string): Promise<void> {
	const assignment = columns.map((column) => `${column} = ${column} - $2::interval`).join(", ");
	await migrated.connection.query(
		`UPDATE ${migrated.schema}.session SET ${assignment} WHERE id = $1 AND user_id = $3`,
		[sessionId, by, userId],
	);
}

async function deadlinesOf(sessionId: string) {
	const [row] = await migrated.connection.query<{
		created_at: Date;
		last_used_at: Date;
		idle_expires_at: Date;
		absolute_expires_at: Date;
	}>(
		`SELECT created_at, last_used_at, idle_expires_at, absolute_expires_at
		 FROM ${migrated.schema}.session WHERE id = $1 AND user_id = $2`,
		[sessionId, userId],
	);
	if (row === undefined) {
		throw new Error("the session under test is gone");
	}
	return row;
}

beforeAll(async () => {
	migrated = await openMigratedSchema("velve_review_deadlines");
	counter = countingByVerb(migrated.connection);
	clock = testClock();
	service = createSessionService({ driver: counter.driver, schema: migrated.schema, clock });
	userId = await createUser(migrated.connection, migrated.schema);
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("E-22: the idle deadline extends on use, at most once an hour", () => {
	it("writes nothing across twenty resolutions inside the interval", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		const before = await deadlinesOf(issued.session.id);
		counter.reset();

		for (let call = 0; call < 20; call += 1) {
			await service.resolve(issued.token);
		}
		const after = await deadlinesOf(issued.session.id);

		expect(counter.verbs.filter((verb) => verb === "UPDATE")).toEqual([]);
		expect(after.last_used_at).toEqual(before.last_used_at);
		expect(after.idle_expires_at).toEqual(before.idle_expires_at);
	});

	it("writes once when the interval has passed, and then holds again", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		await shift(issued.session.id, ["last_used_at"], "2 hours");
		counter.reset();

		await service.resolve(issued.token);
		await service.resolve(issued.token);
		await service.resolve(issued.token);

		expect(counter.verbs.filter((verb) => verb === "UPDATE")).toHaveLength(1);
	});

	it("moves the idle deadline forward by the configured timeout when it does write", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		await shift(issued.session.id, ["last_used_at", "idle_expires_at"], "2 hours");

		const resolved = await service.resolve(issued.token);
		const after = await deadlinesOf(issued.session.id);

		expect(resolved?.session.idleExpiresAt).toEqual(after.idle_expires_at);
		expect(after.idle_expires_at.getTime() - after.last_used_at.getTime()).toBeGreaterThan(
			7 * 24 * HOUR - MINUTE,
		);
	});

	it("lets a short interval write on every request, so the throttle is the interval and nothing else", async () => {
		const eager = createSessionService({
			driver: counter.driver,
			schema: migrated.schema,
			session: { idleWriteInterval: "1s" },
			clock,
		});
		const issued = await eager.issue({ userId, factors: ["password"], observed: NOWHERE });
		await shift(issued.session.id, ["last_used_at"], "10 seconds");
		counter.reset();

		await eager.resolve(issued.token);
		await eager.resolve(issued.token);

		expect(counter.verbs.filter((verb) => verb === "UPDATE").length).toBeGreaterThanOrEqual(1);
	});

	it("never touches created_at or the absolute deadline, however hard the session is used", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		const before = await deadlinesOf(issued.session.id);

		for (let round = 0; round < 5; round += 1) {
			await shift(issued.session.id, ["last_used_at"], "2 hours");
			await service.resolve(issued.token);
			await service.refresh(issued.token);
		}
		const after = await deadlinesOf(issued.session.id);

		expect(after.created_at).toEqual(before.created_at);
		expect(after.absolute_expires_at).toEqual(before.absolute_expires_at);
	});
});

describe("E-22: the absolute deadline is never extended and cannot be revived", () => {
	it("answers null once it has passed, whatever is done to the session", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		await shift(issued.session.id, ["absolute_expires_at"], "31 days");

		expect(await service.resolve(issued.token)).toBeNull();
		expect(await service.refresh(issued.token)).toBeNull();
		expect(await service.resolve(issued.token)).toBeNull();
	});

	it("stays dead: neither resolve nor refresh writes anything to the expired row", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		await shift(issued.session.id, ["absolute_expires_at"], "31 days");
		const before = await deadlinesOf(issued.session.id);
		counter.reset();

		await service.resolve(issued.token);
		await service.refresh(issued.token);
		const after = await deadlinesOf(issued.session.id);

		expect(counter.verbs.filter((verb) => verb === "UPDATE")).toEqual([]);
		expect(after).toEqual(before);
	});

	it("cannot be revived by an idle write, even one that is due", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		await shift(issued.session.id, ["last_used_at"], "2 hours");
		await shift(issued.session.id, ["absolute_expires_at"], "31 days");

		expect(await service.refresh(issued.token)).toBeNull();
		expect((await deadlinesOf(issued.session.id)).absolute_expires_at.getTime()).toBeLessThan(
			Date.now(),
		);
	});

	it("refuses a configuration that would let the idle deadline outlive it", () => {
		expect(() =>
			createSessionService({
				driver: counter.driver,
				schema: migrated.schema,
				session: { idleTimeout: "31d" },
				clock,
			}),
		).toThrow(/absoluteTimeout/);
	});
});

describe("freshness is fifteen minutes from created_at and nothing else restores it", () => {
	it("is gone after the window and is not brought back by resolve, refresh or an idle write", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		clock.set(new Date());
		clock.advanceBy(16 * MINUTE);
		await shift(issued.session.id, ["last_used_at"], "2 hours");

		await service.resolve(issued.token);
		await service.refresh(issued.token);
		const resolved = await service.resolve(issued.token);
		if (resolved === null) {
			throw new Error("the session under test did not resolve");
		}

		await expect(service.list({ resolved })).rejects.toMatchObject({
			code: "freshness_required",
		});
		await expect(service.revokeEvery({ resolved })).rejects.toMatchObject({
			code: "freshness_required",
		});
	});

	it("comes back with a re-issue, because a re-issue is a new row with a new created_at", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		clock.set(new Date());
		clock.advanceBy(16 * MINUTE);

		const next = await service.reissue({
			previousToken: issued.token,
			userId,
			factors: ["password", "totp"],
			observed: NOWHERE,
		});
		clock.set(next.session.createdAt);
		const resolved = await service.resolve(next.token);
		if (resolved === null) {
			throw new Error("the re-issued session did not resolve");
		}

		expect(next.session.id).not.toBe(issued.session.id);
		expect(next.session.createdAt.getTime()).toBeGreaterThanOrEqual(
			issued.session.createdAt.getTime(),
		);
		expect(await service.list({ resolved })).not.toEqual([]);
	});

	it("is measured against created_at, so an old session is never fresh again", async () => {
		const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
		await shift(issued.session.id, ["created_at"], "20 minutes");
		clock.set(new Date());
		const resolved = await service.resolve(issued.token);
		if (resolved === null) {
			throw new Error("the session under test did not resolve");
		}

		await expect(service.list({ resolved })).rejects.toMatchObject({
			code: "freshness_required",
		});
	});
});

/**
 * E-232 settled that a deadline may not be decided by comparing two clocks, and the resolving
 * query already returns the database's `now()`. Freshness is the one deadline still read from
 * the process clock, so a skew between the two moves the window.
 */
describe("freshness is decided by the clock created_at came from", () => {
	it("keeps a session the database created a moment ago fresh when the process clock runs ahead", async () => {
		const ahead = createSessionService({
			driver: counter.driver,
			schema: migrated.schema,
			clock: testClock(new Date(Date.now() + 16 * MINUTE)),
		});
		const issued = await ahead.issue({ userId, factors: ["password"], observed: NOWHERE });
		const resolved = await ahead.resolve(issued.token);
		if (resolved === null) {
			throw new Error("the session under test did not resolve");
		}

		await expect(ahead.list({ resolved })).resolves.not.toEqual([]);
	});

	it("refuses a session the database created fifty minutes ago when the process clock runs behind", async () => {
		const behind = createSessionService({
			driver: counter.driver,
			schema: migrated.schema,
			clock: testClock(new Date(Date.now() - HOUR)),
		});
		const issued = await behind.issue({ userId, factors: ["password"], observed: NOWHERE });
		await shift(issued.session.id, ["created_at"], "50 minutes");
		const resolved = await behind.resolve(issued.token);
		if (resolved === null) {
			throw new Error("the session under test did not resolve");
		}

		await expect(behind.list({ resolved })).rejects.toMatchObject({
			code: "freshness_required",
		});
	});
});
