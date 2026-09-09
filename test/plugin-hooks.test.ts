import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUserRepository } from "../src/core/auth/user.js";
import type { Driver } from "../src/core/db/driver.js";
import { createSessionRepository } from "../src/core/db/repositories/session.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import type {
	FrozenContext,
	PluginHooks,
	SessionRevokeEvent,
	VelvePlugin,
} from "../src/core/plugin/config.js";
import type { FrozenContextServices } from "../src/core/plugin/context.js";
import { createPluginRuntime } from "../src/core/plugin/registry.js";
import { createSessionToken } from "../src/core/session/token.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { createUser, dropSchema } from "./db-fixtures.js";

const HOOK_POINTS = [
	"beforeSignIn",
	"afterSignIn",
	"beforeSessionCreate",
	"afterSessionCreate",
	"beforeUserCreate",
	"afterUserCreate",
	"beforeSessionRevoke",
] as const;

type HookPoint = (typeof HOOK_POINTS)[number];

const EVENT_BY_HOOK_POINT: Readonly<Record<HookPoint, Readonly<Record<string, unknown>>>> = {
	beforeSignIn: { method: "password", userId: null, ipAddress: null, userAgent: null },
	afterSignIn: {
		method: "password",
		userId: "u",
		sessionId: "s",
		factors: ["password"],
		ipAddress: null,
		userAgent: null,
	},
	beforeSessionCreate: { userId: "u", factors: ["password"] },
	afterSessionCreate: { userId: "u", factors: ["password"], sessionId: "s" },
	beforeUserCreate: { email: "a@example.com", username: null },
	afterUserCreate: { email: "a@example.com", username: null, userId: "u" },
	beforeSessionRevoke: { sessionId: "s", userId: "u", reason: "sign_out" },
};

function silentDriver(): Driver {
	return {
		query: <T>(): Promise<T[]> => Promise.resolve([]),
		transaction: <T>(fn: (tx: Driver) => Promise<T>): Promise<T> => fn(silentDriver()),
	};
}

function servicesOver(driver: Driver): FrozenContextServices {
	return {
		clock: { now: () => new Date(0) },
		identityMode: "email",
		schema: "velve",
		users: createUserRepository({ driver, schema: "velve" }),
		sessions: createSessionRepository({ driver, schema: "velve" }),
		driver,
		log: () => undefined,
	};
}

interface Observation {
	readonly plugin: string;
	readonly point: HookPoint;
	readonly event: unknown;
	readonly context: FrozenContext;
}

function listener(
	id: string,
	observed: Observation[],
	failAt?: HookPoint,
): VelvePlugin & { readonly hooks: PluginHooks } {
	const at =
		<Event>(point: HookPoint) =>
		(event: Event, context: FrozenContext): Promise<void> => {
			observed.push({ plugin: id, point, event, context });
			return point === failAt
				? Promise.reject(new Error(`${id} refused at ${point}`))
				: Promise.resolve();
		};
	return {
		id,
		hooks: {
			beforeSignIn: at("beforeSignIn"),
			afterSignIn: at("afterSignIn"),
			beforeSessionCreate: at("beforeSessionCreate"),
			afterSessionCreate: at("afterSessionCreate"),
			beforeUserCreate: at("beforeUserCreate"),
			afterUserCreate: at("afterUserCreate"),
			beforeSessionRevoke: at("beforeSessionRevoke"),
		},
	};
}

async function fireEveryPoint(
	runtime: ReturnType<typeof createPluginRuntime>,
): Promise<readonly HookPoint[]> {
	const fired: HookPoint[] = [];
	for (const point of HOOK_POINTS) {
		await runtime.hooks[point](EVENT_BY_HOOK_POINT[point] as never);
		fired.push(point);
	}
	return fired;
}

describe("the dispatcher runs the seven enumerated points (3.11, 3.15 G)", () => {
	it("offers exactly the seven points and no eighth", () => {
		const runtime = createPluginRuntime({ plugins: [], services: servicesOver(silentDriver()) });

		expect(Object.keys(runtime.hooks).sort()).toStrictEqual([...HOOK_POINTS].sort());
	});

	it("hands every point the event it was given and the plugin's own frozen context", async () => {
		const observed: Observation[] = [];
		const runtime = createPluginRuntime({
			plugins: [listener("demo", observed)],
			services: servicesOver(silentDriver()),
		});

		const fired = await fireEveryPoint(runtime);

		expect(fired).toStrictEqual([...HOOK_POINTS]);
		expect(observed.map((entry) => entry.point)).toStrictEqual([...HOOK_POINTS]);
		expect(observed.map((entry) => entry.event)).toStrictEqual(
			HOOK_POINTS.map((point) => EVENT_BY_HOOK_POINT[point]),
		);
		expect(observed.every((entry) => Object.isFrozen(entry.context))).toBe(true);
	});

	it("runs the plugins in dependency order at every point", async () => {
		const observed: Observation[] = [];
		const runtime = createPluginRuntime({
			plugins: [listener("second", observed), { ...listener("first", observed), dependsOn: [] }],
			services: servicesOver(silentDriver()),
		});
		const ordered = createPluginRuntime({
			plugins: [
				{ ...listener("second", observed), dependsOn: ["first"] },
				listener("first", observed),
			],
			services: servicesOver(silentDriver()),
		});

		observed.length = 0;
		await ordered.hooks.beforeSignIn(EVENT_BY_HOOK_POINT.beforeSignIn as never);

		expect(runtime.plugins.map((plugin) => plugin.id)).toStrictEqual(["second", "first"]);
		expect(observed.map((entry) => entry.plugin)).toStrictEqual(["first", "second"]);
	});

	it("stops at a hook that throws and does not run the ones behind it", async () => {
		const observed: Observation[] = [];
		const runtime = createPluginRuntime({
			plugins: [
				{ ...listener("first", observed, "beforeSignIn"), dependsOn: [] },
				{ ...listener("second", observed), dependsOn: ["first"] },
			],
			services: servicesOver(silentDriver()),
		});

		await expect(
			runtime.hooks.beforeSignIn(EVENT_BY_HOOK_POINT.beforeSignIn as never),
		).rejects.toThrow(/first refused at beforeSignIn/);

		expect(observed.map((entry) => entry.plugin)).toStrictEqual(["first"]);
	});

	it("gives each plugin its own context and never another's", async () => {
		const observed: Observation[] = [];
		const runtime = createPluginRuntime({
			plugins: [listener("one", observed), listener("two", observed)],
			services: servicesOver(silentDriver()),
		});

		await runtime.hooks.beforeSignIn(EVENT_BY_HOOK_POINT.beforeSignIn as never);

		expect(observed).toHaveLength(2);
		expect(observed[0]?.context).not.toBe(observed[1]?.context);
	});
});

/**
 * E-750: the dispatcher above is reachable only if something calls it. 3.11 lists `beforeSessionRevoke`
 * among the seven, `RevokeReason` names `"sign_out"` and `"revoked_by_user"`, and the routes that
 * produce both are in the table today.
 */
describe("the hook points fire from the operations they are named for (3.11)", () => {
	let mounted: MountedAuth;
	let sessionToken: string;
	let sessionId: string;
	let userId: string;
	const revocations: SessionRevokeEvent[] = [];
	let refuseTheRevocation = false;

	const watcher: VelvePlugin = {
		id: "watch",
		hooks: {
			beforeSessionRevoke: (event) => {
				revocations.push(event);
				return refuseTheRevocation
					? Promise.reject(new Error("the plugin refused the revocation"))
					: Promise.resolve();
			},
		},
	};

	async function issueSession(): Promise<void> {
		const issued = createSessionToken();
		sessionToken = issued.token;
		const [row] = await mounted.connection.query<{ id: string }>(
			`INSERT INTO ${mounted.schema}.session
			   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors)
			 VALUES ($1, $2, now() + interval '7 days', now() + interval '30 days', '{password}'::text[])
			 RETURNING id`,
			[userId, issued.tokenHash],
		);
		sessionId = row?.id ?? "";
	}

	async function countSessions(): Promise<number> {
		const [row] = await mounted.connection.query<{ present: number }>(
			`SELECT count(*)::int AS present FROM ${mounted.schema}.session WHERE user_id = $1`,
			[userId],
		);
		return row?.present ?? -1;
	}

	beforeAll(async () => {
		mounted = await mountAuth("pluginhooks", { plugins: [watcher] });
		userId = await createUser(mounted.connection, mounted.schema);
	});

	afterAll(async () => {
		await dropSchema(mounted.connection, mounted.schema);
		await mounted.connection.close();
	});

	it("fires beforeSessionRevoke when a session signs out", async () => {
		await issueSession();
		revocations.length = 0;

		const answer = await mounted.handler(
			requestTo("/sign-out", {
				body: {},
				cookie: `${DEFAULT_COOKIE_NAMES.session}=${sessionToken}`,
			}),
		);

		expect(answer.status).toBe(204);
		expect(revocations).toStrictEqual([{ sessionId, userId, reason: "sign_out" }]);
	});

	it("fires beforeSessionRevoke when a session revokes another of its own account", async () => {
		await issueSession();
		const current = sessionId;
		await issueSession();
		revocations.length = 0;

		const answer = await mounted.handler(
			requestTo("/session/revoke", {
				body: { targetSessionId: current },
				cookie: `${DEFAULT_COOKIE_NAMES.session}=${sessionToken}`,
			}),
		);

		expect(answer.status).toBe(204);
		expect(revocations).toStrictEqual([{ sessionId: current, userId, reason: "revoked_by_user" }]);
	});

	it("fails closed when the hook refuses: the session survives and the caller is told nothing", async () => {
		await issueSession();
		const before = await countSessions();
		refuseTheRevocation = true;

		const answer = await mounted.handler(
			requestTo("/sign-out", {
				body: {},
				cookie: `${DEFAULT_COOKIE_NAMES.session}=${sessionToken}`,
			}),
		);
		refuseTheRevocation = false;
		const body = await answer.text();

		expect(`${answer.status} ${body}`).toContain("500");
		expect(body).toContain("internal_error");
		expect(body).not.toContain("the plugin refused the revocation");
		expect(await countSessions()).toBe(before);
	});
});
