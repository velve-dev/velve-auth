import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FrozenContext, PluginActor } from "../src/core/plugin/config.js";
import { createSessionToken } from "../src/core/session/token.js";
import { type MountedAuth, mountAuth, requestTo } from "./auth-fixtures.js";
import { createUser, dropSchema } from "./db-fixtures.js";
import { type ContextProbe, createContextProbe } from "./plugin-fixtures.js";

let mounted: MountedAuth;
let probe: ContextProbe;
let userId: string;
let sessionId: string;

const ACTOR: PluginActor = { pluginId: "demo", reason: "the test asked" };

beforeAll(async () => {
	probe = createContextProbe();
	mounted = await mountAuth("frozenctx", { plugins: [probe.plugin] });
	userId = await createUser(mounted.connection, mounted.schema);
	const issued = createSessionToken();
	const [row] = await mounted.connection.query<{ id: string }>(
		`INSERT INTO ${mounted.schema}.session
		   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors)
		 VALUES ($1, $2, now() + interval '7 days', now() + interval '30 days', '{password}'::text[])
		 RETURNING id`,
		[userId, issued.tokenHash],
	);
	sessionId = row?.id ?? "";
	await mounted.connection.query(
		`CREATE TABLE ${mounted.schema}.demo_entry (id serial PRIMARY KEY, note text)`,
		[],
	);
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

async function contextOfAPluginRoute(): Promise<FrozenContext> {
	probe.clear();
	await mounted.handler(requestTo("/x/demo/echo", { body: {} }));
	return probe.last().context.plugin;
}

/**
 * A core route's handler is not this file's to edit, so its context is reached the way the pipeline
 * reaches it — through the environment the instance publishes.
 */
function contextOfACoreRoute(): FrozenContext {
	const coreRoute = mounted.auth.routes.find((route) => route.name === "session.read");
	if (coreRoute === undefined) {
		throw new Error("the core table has no session.read route");
	}
	return mounted.auth.http.pluginContextOf(coreRoute);
}

describe("every request carries a frozen plugin context (3.15 D.1, 3.15 G)", () => {
	it("hands a plugin route the context, frozen down to its repositories and its own tables", async () => {
		const context = await contextOfAPluginRoute();

		expect(Object.isFrozen(context)).toBe(true);
		expect(Object.isFrozen(context.repositories)).toBe(true);
		expect(Object.isFrozen(context.ownTables)).toBe(true);
	});

	it("hands a core route a context too, frozen the same way", () => {
		const context = contextOfACoreRoute();

		expect(Object.isFrozen(context)).toBe(true);
		expect(Object.isFrozen(context.repositories)).toBe(true);
		expect(Object.isFrozen(context.ownTables)).toBe(true);
	});

	it("refuses a write to the context at run time", async () => {
		const context = await contextOfAPluginRoute();
		const before = context.schema;

		expect(() => {
			Object.assign(context, { schema: "public" });
		}).toThrow(TypeError);
		expect(context.schema).toBe(before);
	});

	it("carries the six members 3.15 G names and nothing that reaches a verifier or the origin check", async () => {
		const context = await contextOfAPluginRoute();

		expect(Object.keys(context).sort()).toStrictEqual([
			"clock",
			"identityMode",
			"log",
			"ownTables",
			"repositories",
			"schema",
		]);
		expect(context.identityMode).toBe("email");
		expect(context.schema).toBe(mounted.schema);
	});
});

describe("FrozenRepositories carries no writing method on the four core tables (3.15 G, S-OWNER-10)", () => {
	it("publishes exactly the three reading and revoking methods the specification names", async () => {
		const context = await contextOfAPluginRoute();

		expect(Object.keys(context.repositories).sort()).toStrictEqual([
			"findUserById",
			"listSessionsForUser",
			"revokeSession",
		]);
	});

	it("reads a user and lists the sessions of an account", async () => {
		const context = await contextOfAPluginRoute();

		const user = await context.repositories.findUserById({ userId, actor: ACTOR });
		const sessions = await context.repositories.listSessionsForUser({ userId, actor: ACTOR });

		expect(user?.id).toBe(userId);
		expect(sessions.map((session) => session.id)).toContain(sessionId);
	});

	it("carries no password, no factor secret and no token hash out to a plugin", async () => {
		const context = await contextOfAPluginRoute();

		const user = await context.repositories.findUserById({ userId, actor: ACTOR });
		const sessions = await context.repositories.listSessionsForUser({ userId, actor: ACTOR });

		expect(Object.keys(user ?? {})).not.toContain("phc");
		expect(JSON.stringify(sessions)).not.toContain("token_sha256");
		expect(JSON.stringify(sessions)).not.toContain("tokenHash");
	});

	it("refuses a call whose actor names no plugin or no reason, before reaching the database", async () => {
		const context = await contextOfAPluginRoute();
		const incomplete: readonly PluginActor[] = [
			{ pluginId: "", reason: "r" },
			{ pluginId: "demo", reason: "" },
		];

		for (const actor of incomplete) {
			expect(() => context.repositories.findUserById({ userId, actor })).toThrow(
				/pluginId and its reason/,
			);
		}
	});

	it("logs the plugin and the reason on every repository call", async () => {
		const context = await contextOfAPluginRoute();
		const before = mounted.log.lines.length;

		await context.repositories.findUserById({ userId, actor: ACTOR });

		const written = mounted.log.lines.slice(before);
		expect(written.map((line) => line.message)).toContain("a plugin reached a core repository");
		expect(written.map((line) => line.fields.pluginId)).toContain("demo");
		expect(written.map((line) => line.fields.reason)).toContain("the test asked");
	});
});

describe("ownTables reaches the plugin's own tables and no others (3.15 G, 3.11)", () => {
	it("reads and writes a table carrying the plugin's prefix", async () => {
		const context = await contextOfAPluginRoute();

		await context.ownTables.query(`INSERT INTO ${mounted.schema}.demo_entry (note) VALUES ($1)`, [
			"written",
		]);
		const rows = await context.ownTables.query<{ note: string }>(
			`SELECT note FROM ${mounted.schema}.demo_entry`,
			[],
		);

		expect(rows.map((row) => row.note)).toContain("written");
	});

	it("refuses a core table, another plugin's table and an unprefixed one", async () => {
		const context = await contextOfAPluginRoute();
		const foreign = [
			`SELECT * FROM ${mounted.schema}.user`,
			`SELECT * FROM ${mounted.schema}.session`,
			`UPDATE ${mounted.schema}.user SET email = null`,
			`DELETE FROM ${mounted.schema}.password_credential`,
			`SELECT * FROM ${mounted.schema}.other_entry`,
			`SELECT * FROM demo_entry d JOIN ${mounted.schema}.user u ON u.id = d.id`,
		];

		const outcomes = await Promise.all(
			foreign.map((sql) =>
				context.ownTables
					.query(sql, [])
					.then(() => "reached the database")
					.catch((cause: unknown) => (cause as Error).name),
			),
		);

		expect(outcomes).toStrictEqual(foreign.map(() => "ForeignTableError"));
	});

	/** E-747: the refusal is a rejection, never a synchronous throw, so one `catch` covers both. */
	it("refuses by rejecting rather than by throwing out of the call", async () => {
		const context = await contextOfAPluginRoute();
		let thrown: unknown = null;
		let answered: Promise<unknown> = Promise.resolve();

		try {
			answered = context.ownTables.query(`SELECT * FROM ${mounted.schema}.user`, []);
		} catch (cause) {
			thrown = cause;
		}

		expect(thrown).toBeNull();
		await expect(answered).rejects.toThrow(/may reach tables named/);
	});

	/**
	 * A scan that finds no table reference must refuse the statement rather than pass it: 3.11
	 * forbids a plugin reading or writing a core table directly, and a statement the scan cannot
	 * classify is exactly where that prohibition is lost. This one reads the user table.
	 */
	it("refuses a quoted core table name rather than answering with its rows", async () => {
		const context = await contextOfAPluginRoute();

		await expect(
			context.ownTables.query(`SELECT id FROM "${mounted.schema}"."user"`, []),
		).rejects.toThrow(/may reach tables named/);
	});

	it("owns no tables on a core route, and says so rather than answering an empty result", async () => {
		const context = contextOfACoreRoute();

		await expect(
			context.ownTables.query(`SELECT * FROM ${mounted.schema}.demo_entry`, []),
		).rejects.toThrow(/owns no tables of its own/);
	});
});
