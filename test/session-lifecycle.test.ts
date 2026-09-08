import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FreshnessWindow, isSessionFresh } from "../src/core/session/freshness.js";
import {
	createSessionService,
	type SessionService,
	type SessionServiceOptions,
} from "../src/core/session/service.js";
import { createSessionToken, sessionTokenHash } from "../src/core/session/token.js";
import {
	actorOfTestUser,
	createUser,
	dropSchema,
	type MigratedSchema,
	openMigratedSchema,
} from "./db-fixtures.js";
import { MINUTE, type TestClock, testClock } from "./session-fixtures.js";

const NOWHERE = { ipAddress: null, userAgent: null };
const A_BROWSER = {
	ipAddress: "203.0.113.42",
	userAgent:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

let migrated: MigratedSchema;
let clock: TestClock;
let service: SessionService;
let userId: string;
let strangerId: string;

async function rowsWithTokenHash(token: string): Promise<number> {
	const [row] = await migrated.connection.query<{ total: number }>(
		`SELECT count(*)::int AS total FROM ${migrated.schema}.session WHERE token_sha256 = $1`,
		[sessionTokenHash(token)],
	);
	return row?.total ?? -1;
}

async function signIn(): Promise<{ token: string; sessionId: string }> {
	const issued = await service.issue({ userId, factors: ["password"], observed: NOWHERE });
	return { token: issued.token, sessionId: issued.session.id };
}

async function resolvedNow(token: string) {
	const resolved = await service.resolve(token);
	if (resolved === null) {
		throw new Error("the session under test did not resolve");
	}
	return resolved;
}

beforeAll(async () => {
	migrated = await openMigratedSchema("velve_session_lifecycle");
	clock = testClock();
	const options: SessionServiceOptions = {
		driver: migrated.connection,
		schema: migrated.schema,
		clock,
	};
	service = createSessionService(options);
	userId = await createUser(migrated.connection, migrated.schema);
	strangerId = await createUser(migrated.connection, migrated.schema);
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("issuing a session", () => {
	it("hands out a token that resolves, and a different one every time", async () => {
		const first = await signIn();
		const second = await signIn();

		expect(first.token).not.toBe(second.token);
		expect((await resolvedNow(first.token)).session.id).toBe(first.sessionId);
		expect((await resolvedNow(second.token)).session.id).toBe(second.sessionId);
	});

	it("stores the metadata truncated unless told otherwise (L-10)", async () => {
		const issued = await service.issue({
			userId,
			factors: ["password"],
			observed: A_BROWSER,
		});

		expect(issued.session.ipAddress).toBe("203.0.113.0/24");
		expect(issued.session.userAgent).toBe("Chrome on macOS");
	});

	it("stores the observed values when the configuration says full", async () => {
		const full = createSessionService({
			driver: migrated.connection,
			schema: migrated.schema,
			sessionMetadata: "full",
			clock,
		});

		const issued = await full.issue({ userId, factors: ["password"], observed: A_BROWSER });

		expect(issued.session.ipAddress).toBe("203.0.113.42");
		expect(issued.session.userAgent).toBe(A_BROWSER.userAgent);
	});
});

describe("re-issuing on a change of trust level (S-FIX-1, S-FIX-3)", () => {
	it("gives a new token and leaves no row under the old one", async () => {
		const first = await signIn();

		const second = await service.reissue({
			previousToken: first.token,
			userId,
			factors: ["password", "totp"],
			observed: NOWHERE,
		});

		expect(second.token).not.toBe(first.token);
		expect(second.session.id).not.toBe(first.sessionId);
		expect(second.session.factors).toEqual(["password", "totp"]);
		expect(await rowsWithTokenHash(first.token)).toBe(0);
	});

	it("answers a request with the previous token exactly as one without a cookie", async () => {
		const first = await signIn();
		await service.reissue({
			previousToken: first.token,
			userId,
			factors: ["password", "totp"],
			observed: NOWHERE,
		});

		expect(await service.resolve(first.token)).toEqual(
			await service.resolve(createSessionToken().token),
		);
	});

	it("restores freshness, which nothing else does", async () => {
		const first = await signIn();
		clock.advanceBy(20 * MINUTE);
		await expect(service.list({ resolved: await resolvedNow(first.token) })).rejects.toMatchObject({
			code: "freshness_required",
		});

		const second = await service.reissue({
			previousToken: first.token,
			userId,
			factors: ["password", "webauthn"],
			observed: NOWHERE,
		});
		clock.set(second.session.createdAt);

		expect(await service.list({ resolved: await resolvedNow(second.token) })).not.toEqual([]);
	});
});

describe("a credential change (S-FIX-6)", () => {
	it("takes every other session of the user with it", async () => {
		const elsewhere = await signIn();
		const here = await signIn();
		clock.set(new Date());

		const replacement = await service.reissueAfterCredentialChange({
			resolved: await resolvedNow(here.token),
			factors: ["password"],
			observed: NOWHERE,
		});

		expect(await service.resolve(elsewhere.token)).toBeNull();
		expect(await service.resolve(here.token)).toBeNull();
		expect((await resolvedNow(replacement.token)).session.id).toBe(replacement.session.id);
	});

	it("offers no parameter that would keep the other sessions", async () => {
		const here = await signIn();
		clock.set(new Date());

		await service.reissueAfterCredentialChange({
			resolved: await resolvedNow(here.token),
			factors: ["password"],
			observed: NOWHERE,
			// @ts-expect-error S-FIX-6: revoking the other sessions is not a switch.
			revokeOtherSessions: false,
		});

		expect(await service.resolve(here.token)).toBeNull();
	});
});

describe("revoking (S-OWNER-4, 3.15 B.2)", () => {
	it("revokes one session of the caller and leaves the others", async () => {
		await service.revokeEvery({ resolved: await resolvedNow((await signIn()).token) });
		const other = await signIn();
		const here = await signIn();
		clock.set(new Date());

		await service.revoke({
			resolved: await resolvedNow(here.token),
			targetSessionId: other.sessionId,
		});

		expect(await service.resolve(other.token)).toBeNull();
		expect(await service.resolve(here.token)).not.toBeNull();
	});

	it("changes nothing for a session of another user or one that never existed", async () => {
		const stranger = await service.issue({
			userId: strangerId,
			factors: ["password"],
			observed: NOWHERE,
		});
		const here = await signIn();
		clock.set(new Date());
		const resolved = await resolvedNow(here.token);

		expect(
			await service.revoke({ resolved, targetSessionId: stranger.session.id }),
		).toBeUndefined();
		expect(
			await service.revoke({
				resolved,
				targetSessionId: "00000000-0000-4000-8000-000000000000",
			}),
		).toBeUndefined();
		expect(await service.resolve(stranger.token)).not.toBeNull();
	});

	it("revokes every other session and keeps the calling one", async () => {
		await service.revokeEverySessionOfUser({ actor: actorOfTestUser(userId) });
		const here = await signIn();
		const first = await signIn();
		const second = await signIn();
		clock.set(new Date());

		const revoked = await service.revokeEveryOther({ resolved: await resolvedNow(here.token) });

		expect(revoked.revokedCount).toBe(2);
		expect(await service.resolve(first.token)).toBeNull();
		expect(await service.resolve(second.token)).toBeNull();
		expect(await service.resolve(here.token)).not.toBeNull();
	});

	it("revokes every session including the calling one", async () => {
		const here = await signIn();
		clock.set(new Date());

		const revoked = await service.revokeEvery({ resolved: await resolvedNow(here.token) });

		expect(revoked.revokedCount).toBeGreaterThan(0);
		expect(await service.resolve(here.token)).toBeNull();
	});

	it("revokes every session of a user whose ownership was proved elsewhere", async () => {
		const first = await signIn();
		const second = await signIn();

		const revoked = await service.revokeEverySessionOfUser({ actor: actorOfTestUser(userId) });

		expect(revoked.revokedCount).toBe(2);
		expect(await service.resolve(first.token)).toBeNull();
		expect(await service.resolve(second.token)).toBeNull();
	});
});

describe("freshness (architecture 3.5, 3.15 B.9)", () => {
	it("lets the owner-scoped operations through inside the window", async () => {
		const here = await signIn();
		clock.set(new Date());

		expect(await service.list({ resolved: await resolvedNow(here.token) })).not.toEqual([]);
	});

	it("refuses each of them once the window has passed", async () => {
		const here = await signIn();
		clock.set(new Date());
		const resolved = await resolvedNow(here.token);
		clock.advanceBy(16 * MINUTE);

		for (const operation of [
			() => service.list({ resolved }),
			() => service.revoke({ resolved, targetSessionId: here.sessionId }),
			() => service.revokeEveryOther({ resolved }),
			() => service.revokeEvery({ resolved }),
		]) {
			await expect(operation()).rejects.toMatchObject({
				code: "freshness_required",
				httpStatus: 403,
			});
		}
	});

	it("answers the question without throwing where a caller only wants to know", async () => {
		const here = await signIn();
		clock.set(new Date());
		const resolved = await resolvedNow(here.token);
		const window: FreshnessWindow = {
			freshnessWindowMs: service.settings.freshnessWindowMs,
			now: clock.now(),
		};

		expect(isSessionFresh(resolved.session, window)).toBe(true);
		expect(
			isSessionFresh(resolved.session, {
				...window,
				now: new Date(clock.now().getTime() + 16 * MINUTE),
			}),
		).toBe(false);
	});

	it("is not restored by using the session", async () => {
		const here = await signIn();
		clock.set(new Date());
		clock.advanceBy(16 * MINUTE);

		await service.refresh(here.token);

		await expect(service.list({ resolved: await resolvedNow(here.token) })).rejects.toMatchObject({
			code: "freshness_required",
		});
	});
});

describe("signing out (3.15 B.1)", () => {
	it("removes exactly the row the token addresses", async () => {
		const here = await signIn();
		const other = await signIn();

		await service.signOut({ token: here.token });

		expect(await rowsWithTokenHash(here.token)).toBe(0);
		expect(await service.resolve(other.token)).not.toBeNull();
	});

	it("treats an unknown token as nothing to do", async () => {
		await expect(service.signOut({ token: createSessionToken().token })).resolves.toBeUndefined();
	});

	it("needs no freshness, because signing out is never the dangerous direction", async () => {
		const here = await signIn();
		clock.advanceBy(30 * MINUTE);

		await expect(service.signOut({ token: here.token })).resolves.toBeUndefined();
		expect(await service.resolve(here.token)).toBeNull();
	});
});
