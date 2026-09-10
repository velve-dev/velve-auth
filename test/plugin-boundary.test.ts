import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { VelveStartupError } from "../src/core/auth/startup.js";
import type { Driver } from "../src/core/db/driver.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { object } from "../src/core/http/validators.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { FrozenContext, PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { createSessionToken } from "../src/core/session/token.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, requestTo } from "./auth-fixtures.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { asJavaScriptPlugin, createContextProbe, unreachableDriver } from "./plugin-fixtures.js";

/**
 * T-CACHE-5 and T-OWNER-12 name the fields a plugin would reach for by name. The registry refuses
 * every field outside the interface, so these vectors are covered by the mechanism — and the
 * mechanism is what a rewrite would change, which is why the named ones are written down.
 */
const FIELDS_A_PLUGIN_MAY_NOT_NAME: readonly (readonly [string, Record<string, unknown>])[] = [
	["resolveSession", { resolveSession: () => Promise.resolve(null) }],
	["sessionResolver", { sessionResolver: () => Promise.resolve(null) }],
	["resolutionCache", { resolutionCache: new Map() }],
	["verifyPassword", { verifyPassword: () => Promise.resolve(true) }],
	["passwordVerifier", { passwordVerifier: () => Promise.resolve(true) }],
];

const HOOK_POINTS_A_PLUGIN_MAY_NOT_NAME: readonly string[] = [
	"beforeSessionResolve",
	"afterSessionResolve",
	"aroundSessionResolve",
];

function routeNamed(id: string): PluginRoute<string> {
	return {
		name: `${id}.only`,
		method: "POST",
		path: `/x/${id}/only`,
		input: object({}),
		errors: [] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: "none", perAccount: "none" },
		handler: () => Promise.resolve(null),
	} as PluginRoute<string>;
}

function startWith(fields: Record<string, unknown>): () => unknown {
	const plugin = asJavaScriptPlugin({
		id: "attacker",
		routes: [routeNamed("attacker")],
		...fields,
	});
	return () => createVelveAuth(configFor({ database: unreachableDriver(), plugins: [plugin] }));
}

describe("T-CACHE-5: no plugin declares a session resolver, a cache or a verifier (S-CACHE-5)", () => {
	function codeOfRefusal(start: () => unknown): string {
		try {
			start();
		} catch (cause) {
			return cause instanceof VelveStartupError
				? cause.code
				: `not a start error: ${String(cause)}`;
		}
		return "the configuration started";
	}

	it("refuses each named field at start rather than ignoring it", () => {
		const outcomes = FIELDS_A_PLUGIN_MAY_NOT_NAME.map(
			([name, fields]) => `${name}: ${codeOfRefusal(startWith(fields))}`,
		);

		expect(outcomes).toEqual(
			FIELDS_A_PLUGIN_MAY_NOT_NAME.map(([name]) => `${name}: plugin_field_unknown`),
		);
	});

	it("refuses each named resolution hook point at start", () => {
		const outcomes = HOOK_POINTS_A_PLUGIN_MAY_NOT_NAME.map(
			(point) =>
				`${point}: ${codeOfRefusal(startWith({ hooks: { [point]: () => Promise.resolve() } }))}`,
		);

		expect(outcomes).toEqual(
			HOOK_POINTS_A_PLUGIN_MAY_NOT_NAME.map((point) => `${point}: plugin_field_unknown`),
		);
	});

	/**
	 * Without this the two above hold for a registry that refuses every plugin, which is the reading
	 * that satisfies the requirement and breaks the feature.
	 */
	it("starts a plugin that names none of them, so the refusals mean something", () => {
		expect(startWith({})).not.toThrow();
	});

	it("names a set that is not empty, so the loops above ran", () => {
		expect(FIELDS_A_PLUGIN_MAY_NOT_NAME.length).toBeGreaterThan(3);
		expect(HOOK_POINTS_A_PLUGIN_MAY_NOT_NAME.length).toBeGreaterThan(2);
	});
});

describe("the plugin boundary against a real instance (S-CACHE-5, S-OWNER-10, S-OWNER-12)", () => {
	let connection: TestConnection;
	let schema: string;
	let handler: (request: Request) => Promise<Response>;
	let statements: string[];
	let sessionCookie: string;
	const probe = createContextProbe();
	const observedByTheHook: string[] = [];

	/**
	 * 3.11 types every hook as `=> Promise<void>`; a plugin written in JavaScript returns anyway.
	 * `beforeSessionRevoke` is the point, because it is the one the routes of this fixture reach —
	 * the other six fire from the OAuth service alone.
	 */
	const talkativePlugin = asJavaScriptPlugin({
		id: "talkative",
		routes: [routeNamed("talkative")],
		hooks: {
			beforeSessionRevoke: () => {
				observedByTheHook.push("beforeSessionRevoke");
				return Promise.resolve({ status: 418, body: { seized: true }, redirectToPath: "/seized" });
			},
		},
	}) as VelvePlugin;

	function sessionLookups(): readonly string[] {
		return statements.filter((sql) => sql.includes("token_sha256 = $1"));
	}

	beforeAll(async () => {
		const opened = await openMigratedSchema("pluginboundary");
		connection = opened.connection;
		schema = opened.schema;
		statements = [];
		const driver: Driver = {
			query: (sql, params) => {
				statements.push(sql);
				return connection.query(sql, params);
			},
			transaction: (work) => connection.transaction(work),
		};
		const auth = createVelveAuth(
			configFor({ database: driver, schema, plugins: [probe.plugin, talkativePlugin] }),
		);
		handler = toWebHandler(auth);

		const userId = await createUser(connection, schema);
		const issued = createSessionToken();
		await connection.query(
			`INSERT INTO ${schema}.session
			   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors)
			 VALUES ($1, $2, now() + interval '7 days', now() + interval '30 days', '{password}'::text[])`,
			[userId, issued.tokenHash],
		);
		sessionCookie = `${DEFAULT_COOKIE_NAMES.session}=${issued.token}`;
		await connection.query(`CREATE TABLE ${schema}.demo_entry (id serial PRIMARY KEY)`, []);
	});

	afterAll(async () => {
		await dropSchema(connection, schema);
		await connection.close();
	});

	async function contextOfAPluginRoute(): Promise<FrozenContext> {
		probe.clear();
		await handler(requestTo("/x/demo/echo", { body: {} }));
		return probe.last().context.plugin;
	}

	it("resolves a session once per answer with two plugins mounted (S-CACHE-5)", async () => {
		statements.length = 0;
		const answers: number[] = [];
		for (let call = 0; call < 20; call += 1) {
			answers.push(
				(await handler(requestTo("/session", { method: "GET", cookie: sessionCookie }))).status,
			);
		}

		expect(new Set(answers)).toEqual(new Set([200]));
		expect(sessionLookups()).toHaveLength(20);
	});

	it("refuses to have its repositories slot replaced (S-OWNER-10)", async () => {
		const context = await contextOfAPluginRoute();
		const before = context.repositories;

		expect(() => {
			Object.assign(context, { repositories: {} });
		}).toThrow(TypeError);
		expect(context.repositories).toBe(before);
	});

	it("refuses an INSERT into the session table through the tables it owns (S-OWNER-10)", async () => {
		const context = await contextOfAPluginRoute();

		await expect(
			context.ownTables.query(
				`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors)
				 VALUES ($1, $2, now(), now(), '{password}'::text[])`,
				["00000000-0000-4000-8000-000000000000", Buffer.alloc(32)],
			),
		).rejects.toThrow(/may reach tables named/);
	});

	/**
	 * `tsc --noEmit` is what fails on the type half; `pnpm test` cannot, because a widened key set
	 * is a value-level no-op. The runtime assertion below it is the other half (E-1288).
	 */
	it("offers no member through which a statement could reach a core table (S-OWNER-10)", async () => {
		const context = await contextOfAPluginRoute();

		expectTypeOf<
			Extract<keyof FrozenContext, "driver" | "query" | "connection">
		>().toEqualTypeOf<never>();
		expect(Object.keys(context)).not.toContain("driver");
	});

	it("ignores whatever a hook returns and answers as the core decided (S-OWNER-12)", async () => {
		observedByTheHook.length = 0;

		const answer = await handler(requestTo("/sign-out", { body: {}, cookie: sessionCookie }));
		const body = await answer.text();

		expect(observedByTheHook).toEqual(["beforeSessionRevoke"]);
		expect(answer.status).toBe(204);
		expect(answer.headers.get("Location")).toBeNull();
		expect(body).not.toContain("seized");
	});
});
