import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { configFor, createLogSink, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";
import { drawTestPassword } from "./password-fixtures.js";

/**
 * T-RACE-5 over the mounted routes. The driver throws at one write of the credential change and
 * everything the change had already written must be rolled back with it, so the account is left
 * exactly as the change found it.
 */

const OLD_PASSWORD = drawTestPassword();
const NEW_PASSWORD = drawTestPassword();

interface Fault {
	pattern: RegExp | null;
	fired: string | null;
}

const fault: Fault = { pattern: null, fired: null };

function faultingAt(inner: Driver): Driver {
	return {
		query<T>(sql: string, params: unknown[]): Promise<T[]> {
			if (fault.pattern?.test(sql)) {
				fault.fired = sql;
				fault.pattern = null;
				return Promise.reject(new Error("planted fault between the two writes"));
			}
			return inner.query<T>(sql, params);
		},
		transaction<T>(work: (tx: Driver) => Promise<T>): Promise<T> {
			return inner.transaction((tx) => work(faultingAt(tx)));
		},
	};
}

let connection: TestConnection;
let schema: string;
let auth: VelveAuth<"email">;
let handler: (request: Request) => Promise<Response>;
const mailed: { to: string; token: string }[] = [];

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("racerollback"));
	auth = createVelveAuth(
		configFor({
			database: faultingAt(connection),
			schema,
			log: createLogSink().write,
			email: {
				send: (message) => {
					if (message.kind === "password_reset") {
						mailed.push({ to: message.to, token: message.token });
					}
					return Promise.resolve();
				},
			},
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		}),
	);
	handler = toWebHandler(auth);
}, 60_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

const FAULT_POINTS = [
	{
		name: "the removal of the other sessions",
		pattern: () => new RegExp(`DELETE FROM ${schema}\\.session\\b`),
	},
	{
		name: "the insert of the new session",
		pattern: () => new RegExp(`INSERT INTO ${schema}\\.session\\b`),
	},
	{
		name: "the write of the new credential",
		pattern: () => new RegExp(`INSERT INTO ${schema}\\.password_credential\\b`),
	},
] as const;

let accounts = 0;

interface Account {
	readonly email: string;
	readonly userId: string;
	readonly callingToken: string;
	readonly otherTokens: readonly string[];
}

function sessionCookieOf(answer: Response): string {
	for (const header of answer.headers.getSetCookie()) {
		const [pair = ""] = header.split(";");
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === DEFAULT_COOKIE_NAMES.session) {
			return pair.slice(separator + 1);
		}
	}
	throw new Error(`the answer (${answer.status}) wrote no session cookie`);
}

async function accountWithThreeSessions(): Promise<Account> {
	accounts += 1;
	const email = `rollback${accounts}@example.com`;
	const signedUp = await handler(postTo("/sign-up", { email, password: OLD_PASSWORD }));
	expect(signedUp.status).toBe(200);
	const callingToken = sessionCookieOf(signedUp);
	const otherTokens: string[] = [];
	for (let other = 0; other < 2; other += 1) {
		const signedIn = await auth.signIn.password({
			email,
			password: OLD_PASSWORD,
			origin: TEST_ORIGIN,
		});
		if (signedIn.status !== "signed_in") {
			throw new Error(`a sign-in without a second factor was answered ${signedIn.status}`);
		}
		otherTokens.push(signedIn.sessionToken);
	}
	const resolved = await auth.session.resolve({ origin: TEST_ORIGIN, sessionToken: callingToken });
	if (resolved === null) {
		throw new Error("the session of the sign-up does not resolve");
	}
	return { email, userId: resolved.user.id, callingToken, otherTokens };
}

async function sessionRowsOf(userId: string): Promise<readonly string[]> {
	const rows = await connection.query<{ row: string }>(
		`SELECT row_to_json(s)::text AS row FROM ${schema}.session s WHERE user_id = $1 ORDER BY id`,
		[userId],
	);
	return rows.map((entry) => entry.row);
}

async function credentialRowOf(userId: string): Promise<string> {
	const [row] = await connection.query<{ row: string }>(
		`SELECT row_to_json(c)::text AS row FROM ${schema}.password_credential c WHERE user_id = $1`,
		[userId],
	);
	return row?.row ?? "no credential";
}

async function signInStatus(email: string, password: string): Promise<number> {
	return (await handler(postTo("/sign-in/password", { email, password }))).status;
}

async function requestResetToken(email: string): Promise<string> {
	const answer = await handler(postTo("/password/request-reset", { email }));
	expect(answer.status).toBe(204);
	const sent = mailed.filter((message) => message.to === email).at(-1);
	if (sent === undefined) {
		throw new Error(`no reset mail reached ${email}`);
	}
	return sent.token;
}

interface CredentialChange {
	readonly name: string;
	prepare(account: Account): Promise<string | undefined>;
	send(account: Account, resetToken: string | undefined): Promise<Response>;
}

const CHANGES: readonly CredentialChange[] = [
	{
		name: "POST /password/change",
		prepare: () => Promise.resolve(undefined),
		send: (account) =>
			handler(
				postTo(
					"/password/change",
					{ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
					{ Cookie: `${DEFAULT_COOKIE_NAMES.session}=${account.callingToken}` },
				),
			),
	},
	{
		name: "POST /password/redeem-reset",
		prepare: (account) => requestResetToken(account.email),
		send: (_account, resetToken) =>
			handler(postTo("/password/redeem-reset", { token: resetToken, newPassword: NEW_PASSWORD })),
	},
];

describe("T-RACE-5 — a fault inside the credential change leaves neither effect behind (S-RACE-5)", () => {
	for (const change of CHANGES) {
		for (const point of FAULT_POINTS) {
			it(`${change.name} rolls back a fault at ${point.name}`, async () => {
				const account = await accountWithThreeSessions();
				const prepared = await change.prepare(account);
				const sessionsBefore = await sessionRowsOf(account.userId);
				const credentialBefore = await credentialRowOf(account.userId);
				expect(sessionsBefore).toHaveLength(3);

				fault.fired = null;
				fault.pattern = point.pattern();
				const answer = await change.send(account, prepared);
				fault.pattern = null;

				expect(fault.fired, "the planted fault was reached").not.toBeNull();
				expect(answer.status).toBe(500);
				expect(answer.headers.getSetCookie().join("\n")).not.toContain(
					`${DEFAULT_COOKIE_NAMES.session}=`,
				);
				expect(await sessionRowsOf(account.userId), "every session row").toStrictEqual(
					sessionsBefore,
				);
				expect(await credentialRowOf(account.userId), "the credential row").toBe(credentialBefore);
				for (const sessionToken of [account.callingToken, ...account.otherTokens]) {
					const resolved = await auth.session.resolve({ origin: TEST_ORIGIN, sessionToken });
					expect(resolved?.user.id).toBe(account.userId);
				}
				expect(await signInStatus(account.email, NEW_PASSWORD), "the new password").toBe(401);
				expect(await signInStatus(account.email, OLD_PASSWORD), "the old password").toBe(200);
			}, 60_000);
		}
	}

	it("lets the same change through without a fault, so the cases above can fail", async () => {
		for (const change of CHANGES) {
			const account = await accountWithThreeSessions();
			const prepared = await change.prepare(account);

			const answer = await change.send(account, prepared);

			expect(answer.status, change.name).toBe(200);
			expect(await signInStatus(account.email, NEW_PASSWORD)).toBe(200);
			expect(await signInStatus(account.email, OLD_PASSWORD)).toBe(401);
		}
	}, 60_000);
});
