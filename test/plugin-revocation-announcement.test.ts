import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "../src/core/http/route.js";
import { object, string } from "../src/core/http/validators.js";
import type {
	PluginActor,
	PluginRoute,
	SessionRevokeEvent,
	VelvePlugin,
} from "../src/core/plugin/config.js";
import { createSessionToken } from "../src/core/session/token.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { createUser, dropSchema } from "./db-fixtures.js";

const ACTOR: PluginActor = { pluginId: "revoker", reason: "the test asked for it" };

const announced: SessionRevokeEvent[] = [];
let sessionsToRevokeFromTheHook: string[] = [];
let refuseTheRevocation = false;
const sessionsSeenStandingByTheHook: boolean[] = [];

let mounted: MountedAuth;
let userId: string;

/** The route is how a plugin's own code is reached: its handler holds the plugin's frozen context. */
const revokeRoute: PluginRoute<"revoker"> = {
	name: "revoker.revoke",
	method: "POST",
	path: "/x/revoker/revoke",
	input: object({ sessionId: string() }),
	errors: [] as const,
	caller: "anonymous",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: { perIpAddress: "none", perAccount: "none" },
	handler: async (input: unknown, context: RequestContext) => {
		await context.plugin.repositories.revokeSession({
			sessionId: (input as { sessionId: string }).sessionId,
			reason: "revoked_by_user",
			actor: ACTOR,
		});
		return { done: true };
	},
} as PluginRoute<"revoker">;

const REVOKER: VelvePlugin<"revoker"> = { id: "revoker", routes: [revokeRoute] };

const WATCHER: VelvePlugin<"watch"> = {
	id: "watch",
	hooks: {
		beforeSessionRevoke: async (event, context) => {
			announced.push(event);
			sessionsSeenStandingByTheHook.push(
				(await context.repositories.listSessionsForUser({ userId: event.userId, actor: ACTOR }))
					.map((session) => session.id)
					.includes(event.sessionId),
			);
			for (const sessionId of sessionsToRevokeFromTheHook.splice(0)) {
				await context.repositories.revokeSession({
					sessionId,
					reason: "revoked_by_user",
					actor: ACTOR,
				});
			}
			if (refuseTheRevocation) {
				throw new Error("the plugin refused the revocation");
			}
		},
	},
};

async function insertSession(): Promise<string> {
	const issued = createSessionToken();
	const [row] = await mounted.connection.query<{ id: string }>(
		`INSERT INTO ${mounted.schema}.session
		   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors)
		 VALUES ($1, $2, now() + interval '7 days', now() + interval '30 days', '{password}'::text[])
		 RETURNING id`,
		[userId, issued.tokenHash],
	);
	return row?.id ?? "";
}

async function liveSessionIds(): Promise<readonly string[]> {
	const rows = await mounted.connection.query<{ id: string }>(
		`SELECT id FROM ${mounted.schema}.session WHERE user_id = $1 ORDER BY id`,
		[userId],
	);
	return rows.map((row) => row.id);
}

function revoke(sessionId: string): Promise<Response> {
	return mounted.handler(requestTo("/x/revoker/revoke", { body: { sessionId } }));
}

beforeAll(async () => {
	mounted = await mountAuth("pluginrevocation", { plugins: [REVOKER, WATCHER] });
	userId = await createUser(mounted.connection, mounted.schema);
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

beforeEach(async () => {
	announced.length = 0;
	sessionsSeenStandingByTheHook.length = 0;
	sessionsToRevokeFromTheHook = [];
	refuseTheRevocation = false;
	await mounted.connection.query(`DELETE FROM ${mounted.schema}.session WHERE user_id = $1`, [
		userId,
	]);
});

describe("a revocation a plugin performs is announced like any other (E-766)", () => {
	it("announces it once, with the owner, and before the row goes", async () => {
		const sessionId = await insertSession();

		const answer = await revoke(sessionId);

		expect(answer.status).toBe(200);
		expect(announced).toStrictEqual([{ sessionId, userId, reason: "revoked_by_user" }]);
		expect(sessionsSeenStandingByTheHook).toStrictEqual([true]);
		expect(await liveSessionIds()).toStrictEqual([]);
	});

	it("leaves the row standing where the hook refuses", async () => {
		const sessionId = await insertSession();
		refuseTheRevocation = true;

		const answer = await revoke(sessionId);

		expect(answer.status).toBe(500);
		expect(await liveSessionIds()).toStrictEqual([sessionId]);
	});

	it("announces nothing for a session that is not there, and removes nothing", async () => {
		const sessionId = await insertSession();

		const answer = await revoke("00000000-0000-4000-8000-000000000000");

		expect(answer.status).toBe(200);
		expect(announced).toStrictEqual([]);
		expect(await liveSessionIds()).toStrictEqual([sessionId]);
	});

	/**
	 * The re-entry guard: the context a `beforeSessionRevoke` hook holds revokes without announcing,
	 * so a hook that revokes on every announcement terminates instead of announcing itself forever.
	 */
	it("does not announce the revocation a hook performs while it is being told about one", async () => {
		const first = await insertSession();
		const second = await insertSession();
		sessionsToRevokeFromTheHook = [second];

		await revoke(first);

		expect(announced.map((event) => event.sessionId)).toStrictEqual([first]);
		expect(await liveSessionIds()).toStrictEqual([]);
	});
});
