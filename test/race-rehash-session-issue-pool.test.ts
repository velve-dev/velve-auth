import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createPasswordCredentialRepository } from "../src/core/password/credential.js";
import { MAXIMUM_STORED_MEMORY_KIB } from "../src/core/password/limits.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { configFor, createLogSink, testKeyProvider } from "./auth-fixtures.js";
import { openConnectionPool } from "./connection-pool-fixtures.js";
import {
	actorOfTestUser,
	dropSchema,
	type MigratedSchema,
	openMigratedSchema,
} from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { drawTestPassword, storedHashesFor } from "./password-fixtures.js";
import { insertIdentity, resealDirectly } from "./security-state-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

/**
 * T-RACE-6 on a pool, where two sign-ins of one account really run side by side (E-3570). A
 * rehash stores the password a sign-in just verified again and changes nothing that signs the
 * account in, so a sign-in checked before it still issues. Every change that does alter what signs
 * the account in still makes an issue checked before it come to nothing (S-INTEG-3). The gate holds
 * one sign-in between its check and its issue, at the withdrawal of its empty pending row, which
 * runs outside every transaction and lock.
 */

const POOL_SIZE = 12;
const LOAD_ACCOUNTS = 16;
const SIGN_INS_PER_ACCOUNT = 6;
const SETTLE_LIMIT_MS = 30_000;
const PASSWORD = drawTestPassword();
const NEW_PASSWORD = drawTestPassword();
const PENDING_WITHDRAWAL = /^\s*DELETE FROM \S*pending_authentication\b/;

interface IssueGate {
	armed: boolean;
	arrived: boolean;
	release: () => void;
	released: Promise<void>;
}

function newGate(armed: boolean): IssueGate {
	let release = (): void => undefined;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { armed, arrived: false, release, released };
}

let gate = newGate(false);

function holdingOneSignInBeforeItsIssue(inner: Driver): Driver {
	return {
		async query<T>(sql: string, params: unknown[]): Promise<T[]> {
			const current = gate;
			if (current.armed && PENDING_WITHDRAWAL.test(sql)) {
				current.armed = false;
				current.arrived = true;
				await current.released;
			}
			return inner.query<T>(sql, params);
		},
		transaction<T>(work: (tx: Driver) => Promise<T>): Promise<T> {
			return inner.transaction((tx) => work(holdingOneSignInBeforeItsIssue(tx)));
		},
	};
}

const keys = testKeyProvider();
const sent: EmailMessage[] = [];
const alarms: SecurityStateAlarm[] = [];
const log = createLogSink();
let migrated: MigratedSchema;
let pool: Awaited<ReturnType<typeof openConnectionPool>>;
let auth: VelveAuth<"email">;
let handler: (request: Request) => Promise<Response>;
let accounts = 0;

beforeAll(async () => {
	migrated = await openMigratedSchema("rehash_issue_pool");
	pool = await openConnectionPool(POOL_SIZE);
	auth = createVelveAuth(
		configFor({
			database: holdingOneSignInBeforeItsIssue(pool),
			schema: migrated.schema,
			keys,
			log: log.write,
			email: {
				send: (message) => {
					sent.push(message);
					return Promise.resolve();
				},
			},
			securityState: { sealing: "required", alarm: (alarm) => alarms.push(alarm) },
			rateLimit: {
				perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
				perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
			},
		}),
	);
	handler = toWebHandler(auth);
}, 60_000);

afterAll(async () => {
	await pool.close();
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

function sessionIn(answer: Response): string | null {
	for (const header of answer.headers.getSetCookie()) {
		const [pair = ""] = header.split(";");
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === DEFAULT_COOKIE_NAMES.session) {
			const value = pair.slice(separator + 1);
			return value === "" ? null : value;
		}
	}
	return null;
}

function withSession(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` };
}

async function outcomeOf(answer: Response): Promise<string> {
	const body = (await answer.json()) as { error?: { code?: string } } | null;
	return `${answer.status} ${body?.error?.code ?? ""}`.trim();
}

function signIn(email: string, password = PASSWORD): Promise<Response> {
	return handler(postTo("/sign-in/password", { email, password }));
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
	const deadline = Date.now() + SETTLE_LIMIT_MS;
	while (!(await condition())) {
		if (Date.now() > deadline) {
			throw new Error(`${what} did not happen within ${SETTLE_LIMIT_MS} ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function schemeOf(userId: string): Promise<string> {
	const [row] = await migrated.connection.query<{ scheme: string }>(
		`SELECT scheme FROM ${migrated.schema}.password_credential WHERE user_id = $1`,
		[userId],
	);
	return row?.scheme ?? "";
}

async function sessionRowsOf(userId: string): Promise<number> {
	const [row] = await migrated.connection.query<{ rows: number }>(
		`SELECT count(*)::int AS rows FROM ${migrated.schema}.session WHERE user_id = $1`,
		[userId],
	);
	return row?.rows ?? -1;
}

async function userIdOf(email: string): Promise<string> {
	const [row] = await migrated.connection.query<{ id: string }>(
		`SELECT id FROM ${migrated.schema}.user WHERE email = $1`,
		[email],
	);
	return row?.id ?? "";
}

//a bcrypt hash is due for a rehash under every configuration the library accepts
async function accountDueForRehash(): Promise<{ email: string; userId: string }> {
	accounts += 1;
	const email = `rehashissue${accounts}@example.com`;
	const [row] = await migrated.connection.query<{ id: string }>(
		`INSERT INTO ${migrated.schema}.user (email) VALUES ($1) RETURNING id`,
		[email],
	);
	const userId = (row as { id: string }).id;
	await createPasswordCredentialRepository({
		driver: migrated.connection,
		keys,
		schema: migrated.schema,
		memoryCeilingKiB: MAXIMUM_STORED_MEMORY_KIB,
	}).write({
		actor: actorOfTestUser(userId),
		phc: (await storedHashesFor(PASSWORD)).byScheme.bcrypt,
		scheme: "bcrypt",
		setBySessionId: null,
	});
	await resealDirectly(migrated.connection, migrated.schema, keys, userId);
	return { email, userId };
}

async function signedUp(): Promise<{ email: string; userId: string; session: string }> {
	accounts += 1;
	const email = `changed${accounts}@example.com`;
	const answer = await handler(postTo("/sign-up", { email, password: PASSWORD }));
	expect(answer.status).toBe(200);
	return { email, userId: await userIdOf(email), session: sessionIn(answer) ?? "" };
}

function lastTokenSentTo(address: string): string {
	const message = [...sent].reverse().find((candidate) => candidate.to === address);
	if (message === undefined || !("token" in message)) {
		throw new Error(`no token was sent to ${address}`);
	}
	return message.token;
}

/** starts a sign-in, holds it once its check has passed, runs the change and lets the issue go */
async function signInAcross(
	email: string,
	change: () => Promise<void>,
): Promise<{ held: string; failedDeferred: readonly string[] }> {
	gate = newGate(true);
	const held = signIn(email);
	await until(() => gate.arrived, "the sign-in reaching its issue");
	try {
		await change();
	} finally {
		gate.release();
	}
	return {
		held: await outcomeOf(await held),
		failedDeferred: log.lines
			.filter((line) => line.message === "deferred work failed" || line.level === "error")
			.map((line) => line.message),
	};
}

describe("T-RACE-6 on a pool: a rehash between a sign-in's check and its issue (S-RACE-6, E-3570)", () => {
	it("issues the session of a sign-in whose check came before another sign-in's rehash", async () => {
		alarms.length = 0;
		const account = await accountDueForRehash();

		const { held } = await signInAcross(account.email, async () => {
			expect(await outcomeOf(await signIn(account.email))).toBe("200");
			await until(async () => (await schemeOf(account.userId)) === "argon2id", "the rehash");
		});

		expect(held).toBe("200");
		expect(await sessionRowsOf(account.userId)).toBe(2);
		expect(alarms).toStrictEqual([]);
	}, 60_000);

	it(`answers all ${LOAD_ACCOUNTS * SIGN_INS_PER_ACCOUNT} simultaneous correct sign-ins of accounts due for a rehash with a session`, async () => {
		alarms.length = 0;
		const due = await Promise.all(
			Array.from({ length: LOAD_ACCOUNTS }, () => accountDueForRehash()),
		);

		const outcomes = await Promise.all(
			due.flatMap((account) =>
				Array.from({ length: SIGN_INS_PER_ACCOUNT }, async () =>
					outcomeOf(await signIn(account.email)),
				),
			),
		);
		for (const account of due) {
			await until(async () => (await schemeOf(account.userId)) === "argon2id", "every rehash");
		}

		expect(outcomes.filter((outcome) => outcome !== "200")).toStrictEqual([]);
		expect(alarms).toStrictEqual([]);
	}, 300_000);
});

describe("a change of what signs the account in between a sign-in's check and its issue still voids the issue (S-INTEG-3, E-3527)", () => {
	const VOIDED = "401 invalid_credentials";

	it("issues when nothing changed in between", async () => {
		const account = await signedUp();
		const { held } = await signInAcross(account.email, async () => undefined);
		expect(held).toBe("200");
	}, 60_000);

	it("voids it across a password change", async () => {
		const account = await signedUp();
		const { held } = await signInAcross(account.email, async () => {
			const changed = await handler(
				postTo(
					"/password/change",
					{ currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
					withSession(account.session),
				),
			);
			expect(changed.status).toBe(200);
		});
		expect(held).toBe(VOIDED);
	}, 60_000);

	it("voids it across a password reset", async () => {
		const account = await signedUp();
		const requested = await handler(postTo("/password/request-reset", { email: account.email }));
		expect(requested.status).toBe(204);
		const { held } = await signInAcross(account.email, async () => {
			const redeemed = await handler(
				postTo("/password/redeem-reset", {
					token: lastTokenSentTo(account.email),
					newPassword: NEW_PASSWORD,
				}),
			);
			expect(redeemed.status).toBe(200);
		});
		expect(held).toBe(VOIDED);
	}, 60_000);

	it("voids it across a second factor added", async () => {
		const account = await signedUp();
		const started = await handler(
			postTo("/factor/totp/enroll/start", {}, withSession(account.session)),
		);
		const { secretBase32 } = (await started.json()) as { secretBase32: string };
		const { held } = await signInAcross(account.email, async () => {
			const finished = await handler(
				postTo(
					"/factor/totp/enroll/finish",
					{ code: totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(new Date())) },
					withSession(account.session),
				),
			);
			expect(finished.status).toBe(204);
		});
		expect(held).toBe(VOIDED);
	}, 60_000);

	it("voids it across a sign-in method removed", async () => {
		const account = await signedUp();
		await insertIdentity(migrated.connection, migrated.schema, account.userId);
		await resealDirectly(migrated.connection, migrated.schema, keys, account.userId);
		const [identity] = await migrated.connection.query<{ id: string }>(
			`SELECT id FROM ${migrated.schema}.identity WHERE user_id = $1`,
			[account.userId],
		);
		const { held } = await signInAcross(account.email, async () => {
			const unlinked = await handler(
				postTo("/identity/unlink", { identityId: identity?.id }, withSession(account.session)),
			);
			expect(unlinked.status).toBe(204);
		});
		expect(held).toBe(VOIDED);
	}, 60_000);

	it("voids it across a revocation of every session, which raises the epoch", async () => {
		const account = await signedUp();
		const { held } = await signInAcross(account.email, async () => {
			const revoked = await handler(
				postTo("/session/revoke-all", {}, withSession(account.session)),
			);
			expect(revoked.status).toBe(200);
		});
		expect(held).toBe(VOIDED);
	}, 60_000);

	it("voids it across a disable the operator seals", async () => {
		const account = await signedUp();
		const { held } = await signInAcross(account.email, async () => {
			await migrated.connection.query(
				`UPDATE ${migrated.schema}.user SET disabled_at = now() WHERE id = $1`,
				[account.userId],
			);
			await auth.maintenance.resealSecurityState({
				userId: account.userId,
				reason: "the account was disabled",
			});
		});
		expect(held).toBe(VOIDED);
	}, 60_000);

	it("voids it across an address change", async () => {
		const account = await signedUp();
		const newAddress = `moved${accounts}@example.com`;
		const requested = await handler(
			postTo("/email/request-change", { newEmail: newAddress }, withSession(account.session)),
		);
		expect(requested.status).toBe(204);
		const { held } = await signInAcross(account.email, async () => {
			const redeemed = await handler(
				postTo("/email/redeem-change", { token: lastTokenSentTo(newAddress) }),
			);
			expect(redeemed.status).toBe(200);
		});
		expect(held).toBe(VOIDED);
	}, 60_000);
});
