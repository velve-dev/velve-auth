import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPendingAuthenticationService } from "../src/core/factor/pending/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { type MountedAuth, mountAuth, TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { mountWidest, signUpOn, type WidestMount } from "./widest-mount-fixtures.js";

const TOKEN_KEYS = testKeyProvider();

/**
 * 3.15 B.2, B.3 and B.7 name three methods the instance did not carry: the two `resolveFromHeaders`
 * and `user.findByUsername`. B.3 also names `findByEmail` for the two modes with an address only;
 * the instance kept it in mode `username` through 1.x and 2.0.0 drops it there (E-2832, E-2833,
 * E-2834, E-3022).
 */

const FOREIGN_ORIGIN = "https://evil.example.com";

let widest: WidestMount;
let sessionCookie: string;
let userId: string;

beforeAll(async () => {
	widest = await mountWidest("lookups", { keys: TOKEN_KEYS });
	({ sessionCookie, userId } = await signUpOn(widest));
}, 120_000);

afterAll(async () => {
	await widest.close();
});

function headersWith(cookie: string | null, origin: string | null = null): Headers {
	const headers = new Headers();
	if (cookie !== null) {
		headers.set("Cookie", cookie);
	}
	if (origin !== null) {
		headers.set("Origin", origin);
	}
	return headers;
}

async function codeOf(call: Promise<unknown>): Promise<string> {
	try {
		await call;
		return "answered";
	} catch (cause) {
		return (cause as { code?: string }).code ?? String(cause);
	}
}

describe("session.resolveFromHeaders (3.15 B.2)", () => {
	it("answers the session and the account the cookie names, as session.resolve does", async () => {
		const token = sessionCookie.slice(DEFAULT_COOKIE_NAMES.session.length + 1);
		const fromHeaders = await widest.auth.session.resolveFromHeaders(headersWith(sessionCookie));
		const fromToken = await widest.auth.session.resolve({
			sessionToken: token,
			origin: TEST_ORIGIN,
		});

		expect(fromHeaders?.user.id).toBe(userId);
		expect(fromHeaders?.session.id).toBe(fromToken?.session.id);
		expect(fromHeaders?.user).toStrictEqual(fromToken?.user);
	});

	it("answers null without the cookie and for a token that names no session", async () => {
		const unknown = `${DEFAULT_COOKIE_NAMES.session}=${"x".repeat(43)}`;

		expect(await widest.auth.session.resolveFromHeaders(headersWith(null))).toBeNull();
		expect(await widest.auth.session.resolveFromHeaders(headersWith(unknown))).toBeNull();
	});

	it("reads only the cookie, so the Origin of a navigation from another site changes nothing", async () => {
		const resolved = await widest.auth.session.resolveFromHeaders(
			headersWith(sessionCookie, FOREIGN_ORIGIN),
		);

		expect(resolved?.user.id).toBe(userId);
	});

	it("refuses a second session cookie rather than choosing one (S-COOKIE-5)", async () => {
		const twice = `${sessionCookie}; ${sessionCookie}`;

		expect(await codeOf(widest.auth.session.resolveFromHeaders(headersWith(twice)))).toBe(
			"invalid_input",
		);
	});

	it("throws account_disabled for a disabled account, as resolve does (L-4)", async () => {
		const disabled = await signUpOn(widest);
		await widest.auth.user.disable({ userId: disabled.userId, reason: "test" });

		expect(
			await codeOf(widest.auth.session.resolveFromHeaders(headersWith(disabled.sessionCookie))),
		).toBe("account_disabled");
	});
});

describe("pending.resolveFromHeaders (3.15 B.7)", () => {
	it("answers the intermediate state the pending cookie names, and null without one", async () => {
		const pending = createPendingAuthenticationService({
			keys: TOKEN_KEYS,
			driver: widest.connection,
			schema: widest.schema,
		});
		const begun = await pending.begin({ userId, factorsCompleted: ["password"] });
		const cookie = `${DEFAULT_COOKIE_NAMES.pending}=${begun.token}`;

		const fromHeaders = await widest.auth.pending.resolveFromHeaders(headersWith(cookie));

		expect(fromHeaders).toStrictEqual(await widest.auth.pending.resolve(begun.token));
		expect(fromHeaders?.factorsCompleted).toStrictEqual(["password"]);
		expect(await widest.auth.pending.resolveFromHeaders(headersWith(sessionCookie))).toBeNull();
	});
});

describe("user.findByUsername (3.15 B.3)", () => {
	it("finds an account by its name in any case and spacing the comparison form folds", async () => {
		const [row] = await widest.connection.query<{ username: string }>(
			`SELECT username FROM ${widest.schema}.user WHERE id = $1`,
			[userId],
		);
		const name = row?.username ?? "";

		expect((await widest.auth.user.findByUsername({ username: name }))?.id).toBe(userId);
		expect(
			(await widest.auth.user.findByUsername({ username: ` ${name.toUpperCase()} ` }))?.id,
		).toBe(userId);
		expect(await widest.auth.user.findByUsername({ username: "nobody-here" })).toBeNull();
	});

	it("does not exist in mode email", async () => {
		const emailOnly: MountedAuth = await mountAuth("lookupsemail");
		const carried = Object.keys(emailOnly.auth.user);
		await dropSchema(emailOnly.connection, emailOnly.schema);
		await emailOnly.connection.close();

		expect(carried).not.toContain("findByUsername");
		expect(carried).toContain("findByEmail");
	});

	it("keeps findByEmail in mode username_email", () => {
		expect(Object.keys(widest.auth.user)).toContain("findByEmail");
	});
});

describe("user in mode username (3.15 B.3, E-3022)", () => {
	let connection: TestConnection;
	let schema: string;
	let auth: VelveAuth<"username">;

	beforeAll(async () => {
		({ connection, schema } = await openMigratedSchema("lookupsusername", "username"));
		auth = createVelveAuth<"username">({
			identity: { mode: "username" },
			database: connection,
			schema,
			keys: testKeyProvider(),
			origins: [TEST_ORIGIN],
			recoveryCodes: { count: 10, groupSize: 5 },
		});
	});

	afterAll(async () => {
		await dropSchema(connection, schema);
		await connection.close();
	});

	it("finds an account by name, and carries no lookup by address", async () => {
		const [row] = await connection.query<{ id: string }>(
			`INSERT INTO ${schema}.user (username, username_key, email)
			 VALUES ('Named', 'named', 'named@example.com') RETURNING id`,
			[],
		);

		expect((await auth.user.findByUsername({ username: "NAMED" }))?.id).toBe(row?.id);
		expect(Object.keys(auth.user)).not.toContain("findByEmail");
		// @ts-expect-error the mode has no lookup by address, on the type as on the object.
		expect(auth.user.findByEmail).toBeUndefined();
	});
});
