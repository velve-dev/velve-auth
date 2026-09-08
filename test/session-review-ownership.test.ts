import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionService, type SessionService } from "../src/core/session/service.js";
import {
	actorOfTestUser,
	createUser,
	dropSchema,
	type MigratedSchema,
	openMigratedSchema,
} from "./db-fixtures.js";

const NOWHERE = { ipAddress: null, userAgent: null };
const INVENTED = "00000000-0000-4000-8000-000000000000";

let migrated: MigratedSchema;
let service: SessionService;
let ownerId: string;
let strangerId: string;

async function resolvedNow(token: string) {
	const resolved = await service.resolve(token);
	if (resolved === null) {
		throw new Error("the session under test did not resolve");
	}
	return resolved;
}

async function snapshotOf(user: string): Promise<string> {
	const rows = await migrated.connection.query<{ id: string; idle_expires_at: Date }>(
		`SELECT id, idle_expires_at FROM ${migrated.schema}.session WHERE user_id = $1 ORDER BY id`,
		[user],
	);
	return JSON.stringify(rows);
}

beforeAll(async () => {
	migrated = await openMigratedSchema("velve_review_ownership");
	service = createSessionService({
		driver: migrated.connection,
		schema: migrated.schema,
	});
	ownerId = await createUser(migrated.connection, migrated.schema);
	strangerId = await createUser(migrated.connection, migrated.schema);
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("S-OWNER-4, S-OWNER-8: a foreign id and an invented one are the same thing", () => {
	it("answers both with undefined and changes no row in either case", async () => {
		const foreign = await service.issue({
			userId: strangerId,
			factors: ["password"],
			observed: NOWHERE,
		});
		const here = await service.issue({ userId: ownerId, factors: ["password"], observed: NOWHERE });
		const resolved = await resolvedNow(here.token);
		const before = await snapshotOf(strangerId);

		const onForeign = await service.revoke({ resolved, targetSessionId: foreign.session.id });
		const onInvented = await service.revoke({ resolved, targetSessionId: INVENTED });

		expect(onForeign).toBe(onInvented);
		expect(await snapshotOf(strangerId)).toBe(before);
		expect(await service.resolve(foreign.token)).not.toBeNull();
	});

	it("reaches no session of another user through revokeEveryOther or revokeEvery", async () => {
		const foreign = await service.issue({
			userId: strangerId,
			factors: ["password"],
			observed: NOWHERE,
		});
		const here = await service.issue({ userId: ownerId, factors: ["password"], observed: NOWHERE });

		await service.revokeEveryOther({ resolved: await resolvedNow(here.token) });
		await service.revokeEvery({ resolved: await resolvedNow(here.token) });

		expect(await service.resolve(foreign.token)).not.toBeNull();
	});

	it("counts only the caller's rows, so the count is no report about another user", async () => {
		await service.revokeEverySessionOfUser({ actor: actorOfTestUser(ownerId) });
		await service.issue({ userId: strangerId, factors: ["password"], observed: NOWHERE });
		await service.issue({ userId: strangerId, factors: ["password"], observed: NOWHERE });
		const here = await service.issue({ userId: ownerId, factors: ["password"], observed: NOWHERE });
		const other = await service.issue({
			userId: ownerId,
			factors: ["password"],
			observed: NOWHERE,
		});

		const revoked = await service.revokeEveryOther({ resolved: await resolvedNow(here.token) });

		expect(revoked.revokedCount).toBe(1);
		expect(await service.resolve(other.token)).toBeNull();
	});

	it("lists no session of another user", async () => {
		await service.issue({ userId: strangerId, factors: ["password"], observed: NOWHERE });
		const here = await service.issue({ userId: ownerId, factors: ["password"], observed: NOWHERE });

		const listed = await service.list({ resolved: await resolvedNow(here.token) });

		expect(listed.length).toBeGreaterThan(0);
		expect(listed.every((session) => session.userId === ownerId)).toBe(true);
	});

	it("cannot be pointed at another user's row by a target id that is not a uuid either", async () => {
		const here = await service.issue({ userId: ownerId, factors: ["password"], observed: NOWHERE });
		const resolved = await resolvedNow(here.token);
		const before = await snapshotOf(strangerId);

		await expect(
			service.revoke({ resolved, targetSessionId: "' OR true --" }),
		).rejects.toMatchObject({ sqlState: "22P02" });

		expect(await snapshotOf(strangerId)).toBe(before);
	});

	it("keeps every owner-scoped removal an owner predicate rather than a branch", async () => {
		const here = await service.issue({ userId: ownerId, factors: ["password"], observed: NOWHERE });
		const resolved = await resolvedNow(here.token);
		const strangerBefore = await snapshotOf(strangerId);

		for (const target of [randomUUID(), randomUUID(), INVENTED]) {
			expect(await service.revoke({ resolved, targetSessionId: target })).toBeUndefined();
		}

		expect(await snapshotOf(strangerId)).toBe(strangerBefore);
		expect(await service.resolve(here.token)).not.toBeNull();
	});
});

describe("S-OWNER-7: the actor comes from a resolution and from nothing else", () => {
	/**
	 * The brand is a compile-time nominal type, so it stops a caller in the type checker and not
	 * at run time. This pins what it does and does not buy.
	 */
	it("refuses a hand-built resolution in the type checker, and only there", async () => {
		const here = await service.issue({ userId: ownerId, factors: ["password"], observed: NOWHERE });
		const resolved = await resolvedNow(here.token);

		const listed = await service.list({
			// @ts-expect-error S-OWNER-7: a user id from a request is not a resolution.
			resolved: { userId: strangerId, session: resolved.session, observedAt: resolved.observedAt },
		});

		expect(listed.every((session) => session.userId === strangerId)).toBe(true);
	});

	it("refuses a resolution assembled from a session that is not the caller's", async () => {
		const foreign = await service.issue({
			userId: strangerId,
			factors: ["password"],
			observed: NOWHERE,
		});
		const here = await service.issue({ userId: ownerId, factors: ["password"], observed: NOWHERE });
		const mine = await resolvedNow(here.token);
		const theirs = await resolvedNow(foreign.token);
		const before = await snapshotOf(strangerId);

		await service.revoke({ resolved: mine, targetSessionId: theirs.session.id });

		expect(await snapshotOf(strangerId)).toBe(before);
	});
});
