import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";
import { PROOF_PASSWORD, parseSetCookie } from "./proof-fixtures.js";

const opened: { connection: TestConnection; schema: string }[] = [];

afterEach(async () => {
	for (const { connection, schema } of opened.splice(0)) {
		await dropSchema(connection, schema);
		await connection.close();
	}
});

const CONFIGURED_NAME = "__Host-application_session";

/**
 * Architecture 3.15 A.5 and the session chapter of DOCUMENTATION.md offer `session.cookieName`
 * as the session cookie's name and validate it at start, while S-COOKIE-1 fixes the name to
 * `__Host-velve_session` and the writer and the reader both use that constant. An option that is
 * checked and then ignored is the worst of the three shapes, so this asks for either of the other
 * two: the name is honoured, or the option is refused at start.
 */
describe("session.cookieName is honoured or refused, never ignored", () => {
	//the configured name is validated and then ignored until the owner settles it against 3.15 A.5 (S-COOKIE-1)
	it.fails("writes the configured name, or refuses to start with it", async () => {
		const { connection, schema } = await openMigratedSchema("cookiename");
		opened.push({ connection, schema });
		let started: ReturnType<typeof createVelveAuth> | null = null;
		try {
			started = createVelveAuth(
				configFor({
					database: connection,
					schema,
					session: { cookieName: CONFIGURED_NAME },
				}),
			);
		} catch {
			started = null;
		}
		if (started === null) {
			return;
		}

		const answer = await toWebHandler(started)(
			postTo("/sign-up", { email: "named@example.com", password: PROOF_PASSWORD }),
		);
		const names = answer.headers.getSetCookie().map((header) => parseSetCookie(header).name);

		expect(answer.status).toBe(200);
		expect(names).toStrictEqual([CONFIGURED_NAME]);
	});

	/** What the case above fails on, pinned so that it cannot fail for a reason nobody reported. */
	it("starts with the configured name today and writes the fixed one instead", async () => {
		const { connection, schema } = await openMigratedSchema("cookiename");
		opened.push({ connection, schema });
		const auth = createVelveAuth(
			configFor({ database: connection, schema, session: { cookieName: CONFIGURED_NAME } }),
		);

		const answer = await toWebHandler(auth)(
			postTo("/sign-up", { email: "ignored@example.com", password: PROOF_PASSWORD }),
		);
		const names = answer.headers.getSetCookie().map((header) => parseSetCookie(header).name);

		expect(names).toStrictEqual([DEFAULT_COOKIE_NAMES.session]);
	});
});
