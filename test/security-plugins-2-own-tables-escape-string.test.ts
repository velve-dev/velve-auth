import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { type MountedAuth, mountAuth, requestTo, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";

/**
 * S-OWNER-10: a plugin receives no write access to core tables except through the repository
 * methods. Without `pluginDatabaseRole` or `pluginDatabase` — the default — the statement check in
 * `own-tables.ts` is the only bound. Its reader ends a literal at the first lone quote, while
 * PostgreSQL reads `\'` inside an `E'…'` literal as an escaped quote and keeps going, so text the
 * reader erases as data is code to the database.
 */

let statement: (schema: string) => string = () => "SELECT 1";
const answers: unknown[] = [];

const ESCAPER: VelvePlugin<"esc"> = {
	id: "esc",
	routes: [
		{
			name: "esc.run",
			method: "POST",
			path: "/x/esc/run",
			input: object({}),
			errors: [] as const,
			caller: "anonymous",
			freshness: "not_required",
			originCheck: "checked",
			rateLimit: { perIpAddress: { capacity: 1000, refillPerSecond: 10 }, perAccount: "none" },
			handler: async (_input: unknown, context: RequestContext) => {
				try {
					answers.push(await context.plugin.ownTables.query(statement(context.plugin.schema), []));
				} catch (cause) {
					answers.push(cause);
				}
				return { ran: true };
			},
		} as PluginRoute<"esc">,
	],
};

let mounted: MountedAuth;
let userId: string;

beforeAll(async () => {
	mounted = await mountAuth("secplugescape", { plugins: [ESCAPER] });
	const signedUp = await mounted.auth.signUp.withPassword({
		email: "held@example.com",
		password: "correct-horse-battery-staple",
		origin: TEST_ORIGIN,
	});
	userId = signedUp.user.id;
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

async function run(sql: (schema: string) => string): Promise<unknown> {
	statement = sql;
	answers.length = 0;
	await mounted.handler(requestTo("/x/esc/run", { body: {} }));
	return answers[0];
}

describe("ownTables.query reaches no core table in the default configuration (S-OWNER-10)", () => {
	it("refuses a read of the session table hidden behind an escaped quote", async () => {
		const answer = await run(
			(schema) => `SELECT E'\\'', encode(token_sha256, 'hex') AS h FROM ${schema}.session --'`,
		);

		expect(answer, "the plugin read the core session table").toBeInstanceOf(Error);
	});

	it("refuses a delete of every session hidden behind an escaped quote", async () => {
		const answer = await run(
			(schema) =>
				`WITH a AS (SELECT E'\\'' AS q), w AS (DELETE FROM ${schema}.session RETURNING 1) SELECT count(*) AS n FROM w --')  SELECT 1`,
		);
		const [left] = await mounted.connection.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM ${mounted.schema}.session WHERE user_id = $1`,
			[userId],
		);

		expect(answer, "the plugin's delete reached the core table").toBeInstanceOf(Error);
		expect(left?.n, "sessions left after the plugin's statement").toBe(1);
	});
});
