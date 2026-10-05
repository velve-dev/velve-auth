import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";

/**
 * 3.15 D.1: a route throws only the codes it declares. `username.change` meets an account that went
 * between the resolution of its session and the update of its name — deleted by the application in
 * another request — and answers it with a code from its own list (E-2835). The deletion is planted
 * immediately in front of the update, which is the one window the branch exists for.
 */

const USERNAME_UPDATE = "SET username = $2, username_key = $3";
const PASSWORD = "correct-horse-battery-staple";

let connection: TestConnection;
let schema: string;
let auth: VelveAuth<"username_email">;
let handler: (request: Request) => Promise<Response>;

function deletingTheAccountBeforeTheUpdate(inner: Driver): Driver {
	return {
		async query<T>(sql: string, params: unknown[]): Promise<T[]> {
			if (sql.includes(USERNAME_UPDATE)) {
				await connection.query(`DELETE FROM ${schema}.user WHERE id = $1`, [params[0]]);
			}
			return inner.query<T>(sql, params);
		},
		transaction: (fn) => inner.transaction((tx) => fn(deletingTheAccountBeforeTheUpdate(tx))),
	};
}

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("usernamevanished", "username_email"));
	auth = createVelveAuth<"username_email">({
		identity: { mode: "username_email" },
		database: deletingTheAccountBeforeTheUpdate(connection),
		schema,
		keys: testKeyProvider(),
		origins: [TEST_ORIGIN],
		email: { send: () => Promise.resolve() },
	});
	handler = toWebHandler(auth);
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function sessionCookieOf(answer: Response): string {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		if (pair.startsWith(`${DEFAULT_COOKIE_NAMES.session}=`)) {
			return pair;
		}
	}
	throw new Error(`the sign-up answered ${answer.status} without a session cookie`);
}

describe("username.change when the account is deleted under it (3.15 D.1, B.9)", () => {
	it("answers with a code the route declares, and that code is session_required", async () => {
		const signedUp = await handler(
			postTo("/sign-up", { email: "vanish@example.com", username: "vanish", password: PASSWORD }),
		);
		const answer = await handler(
			postTo(
				"/username/change",
				{ newUsername: "vanished" },
				{ Cookie: sessionCookieOf(signedUp) },
			),
		);
		const body = (await answer.json()) as { error?: { code?: string } };
		const declared = auth.routes.find((route) => route.name === "username.change")?.errors ?? [];
		const [left] = await connection.query<{ present: number }>(
			`SELECT count(*)::int AS present FROM ${schema}.user`,
			[],
		);

		expect(left?.present).toBe(0);
		expect(declared).toContain(body.error?.code);
		expect(body.error?.code).toBe("session_required");
	});
});
