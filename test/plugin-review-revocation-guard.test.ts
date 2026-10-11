import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "../src/core/http/route.js";
import { object, string } from "../src/core/http/validators.js";
import type {
	FrozenContext,
	PluginActor,
	PluginRoute,
	SessionRevokeEvent,
	VelvePlugin,
} from "../src/core/plugin/config.js";
import { createSessionToken } from "../src/core/session/token.js";
import { type MountedAuth, mountAuth, requestTo, testKeyProvider } from "./auth-fixtures.js";
import { createUser, dropSchema } from "./db-fixtures.js";
import { rebindSessionsOf, sessionMacParameters } from "./session-fixtures.js";

const TOKEN_KEYS = testKeyProvider();

const ACTOR: PluginActor = { pluginId: "watch", reason: "the review asked for it" };

/** Long enough that two announcements overlap, so a guard held in one variable silences one. */
const HOOK_PAUSE_IN_MILLISECONDS = 25;

const announced: SessionRevokeEvent[] = [];
let revokeFromInsideTheHook: string | null = null;

let mounted: MountedAuth;
let userId: string;

const revokeRoute: PluginRoute<"revoker"> = {
	name: "revoker.revoke",
	method: "POST",
	path: "/x/revoker/revoke",
	input: object({ sessionId: string() }),
	errors: [] as const,
	caller: "anonymous",
	freshness: "not_required",
	originCheck: "checked",
	rateLimit: { perIpAddress: { capacity: 1000, refillPerSecond: 10 }, perAccount: "none" },
	handler: async (input: unknown, context: RequestContext) => {
		await context.plugin.repositories.revokeSession({
			sessionId: (input as { sessionId: string }).sessionId,
			reason: "revoked_by_user",
			actor: ACTOR,
		});
		return { done: true };
	},
} as PluginRoute<"revoker">;

const WATCHER: VelvePlugin<"watch"> = {
	id: "watch",
	hooks: {
		beforeSessionRevoke: async (event: SessionRevokeEvent, context: FrozenContext) => {
			await new Promise((resolve) => setTimeout(resolve, HOOK_PAUSE_IN_MILLISECONDS));
			announced.push(event);
			const paired = revokeFromInsideTheHook;
			revokeFromInsideTheHook = null;
			if (paired !== null) {
				await context.repositories.revokeSession({
					sessionId: paired,
					reason: "revoked_by_user",
					actor: ACTOR,
				});
			}
		},
	},
};

async function insertSession(): Promise<string> {
	const issued = createSessionToken();
	const [row] = await mounted.connection.query<{ id: string }>(
		`INSERT INTO ${mounted.schema}.session
		   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors,
			    token_mac, token_mac_key_version, created_at, id)
		 VALUES ($1, $2, $7::timestamptz, $8::timestamptz, '{password}'::text[], $3, $4, $5::timestamptz, $6::uuid)
		 RETURNING id`,
		[
			userId,
			issued.tokenHash,
			...(await sessionMacParameters(TOKEN_KEYS, {
				userId,
				tokenHash: issued.tokenHash,
				factors: ["password"],
			})),
		],
	);
	//a revocation earlier in the file moved the account to a new session generation
	await rebindSessionsOf(mounted.connection, mounted.schema, TOKEN_KEYS, {
		sessionId: row?.id ?? "",
	});
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
	mounted = await mountAuth("pluginguard", {
		keys: TOKEN_KEYS,
		plugins: [{ id: "revoker", routes: [revokeRoute] } as VelvePlugin<"revoker">, WATCHER],
	});
	userId = await createUser(mounted.connection, mounted.schema);
	await mounted.reseal(userId);
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

beforeEach(async () => {
	announced.length = 0;
	revokeFromInsideTheHook = null;
	await mounted.connection.query(`DELETE FROM ${mounted.schema}.session WHERE user_id = $1`, [
		userId,
	]);
});

/**
 * The chapter claims the guard is structural and shares nothing between requests. A guard held in
 * one variable satisfies the single-request case identically and fails this one.
 */
describe("the re-entry guard while hooks await (3.11)", () => {
	it("announces both of two revocations that overlap", async () => {
		const first = await insertSession();
		const second = await insertSession();

		await Promise.all([revoke(first), revoke(second)]);

		expect([...announced].map((event) => event.sessionId).sort()).toStrictEqual(
			[first, second].sort(),
		);
		expect(await liveSessionIds()).toStrictEqual([]);
	});

	it("stays silent for a revocation a hook performs after awaiting", async () => {
		const first = await insertSession();
		const second = await insertSession();
		revokeFromInsideTheHook = second;

		await revoke(first);

		expect(announced.map((event) => event.sessionId)).toStrictEqual([first]);
		expect(await liveSessionIds()).toStrictEqual([]);
	});
});
