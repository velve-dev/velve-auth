import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { InvalidSessionConfigError } from "../src/core/session/config.js";
import type { Duration } from "../src/core/session/duration.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";

/**
 * Architecture 3.15 A.5 states `absoluteTimeout` as a `Duration` and the library refuses at start
 * what it cannot serve, which is the line 3.15 A.3 and the `memoryKiB` floor draw. A session
 * configuration the library accepts must therefore be one a sign-in can be answered under: either
 * start-up refuses it as `InvalidSessionConfigError`, or the first sign-up answers 200. E-1578
 * measured a third outcome above 400 days, a clean start followed by `internal_error` on every
 * sign-in, because the session cookie's `Max-Age` is derived from it.
 */

const PASSWORD = "correct-horse-battery-staple";

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("servable_timeout");
	connection = migrated.connection;
	schema = migrated.schema;
}, 120_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

type Outcome = "refused at start" | `answered ${number}`;

async function outcomeOf(absoluteTimeout: Duration, address: string): Promise<Outcome> {
	let handler: (request: Request) => Promise<Response>;
	try {
		handler = toWebHandler(
			createVelveAuth(configFor({ database: connection, schema, session: { absoluteTimeout } })),
		);
	} catch (error) {
		if (error instanceof InvalidSessionConfigError) {
			return "refused at start";
		}
		throw error;
	}
	const answer = await handler(postTo("/sign-up", { email: address, password: PASSWORD }));
	return `answered ${answer.status}`;
}

describe("an absolute timeout the library starts with is one it can sign in under", () => {
	it("serves a sign-up at the 400 days a cookie can state", async () => {
		expect(await outcomeOf("400d", "four-hundred@example.com")).toBe("answered 200");
	});

	it.each([
		["401d", "four-hundred-one@example.com"],
		["3650d", "ten-years@example.com"],
	] as const)(
		"either refuses %s at start or serves a sign-up under it",
		async (timeout, address) => {
			expect(["refused at start", "answered 200"]).toContain(await outcomeOf(timeout, address));
		},
	);
});
