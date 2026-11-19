import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import {
	createPendingAuthenticationService,
	toPendingToken,
} from "../src/core/factor/pending/index.js";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { rebindTokenRowsUnderCurrentKey } from "../src/core/token/rebind.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { configFor, createLogSink, TEST_ORIGIN } from "./auth-fixtures.js";
import { openConnectionPool } from "./connection-pool-fixtures.js";
import { dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { secretBytesOfBase32, testKeyRing } from "./totp-fixtures.js";

/**
 * S-FIX-7 and S-FIX-8 against the two attackers the specification names besides the caller: a
 * concurrent request, on a pool where two requests really run side by side, and a writer of the
 * database without the root key (3.18). The new password a held back reset carries is covered by
 * the row's token MAC (S-INTEG-9) and opens only under its own row (S-INTEG-1), and a completion
 * whose account changed after its factor was checked writes nothing (S-INTEG-5).
 */

const POOL_SIZE = 8;
const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";
const ANOTHER = "yet another password of some length";
const RESET_ROUTE = "/password/redeem-reset";
const PENDING_REMOVAL = /^\s*DELETE FROM \S*pending_authentication\b/;

interface Interception {
	act: (() => Promise<void>) | null;
}

const interception: Interception = { act: null };

//a change runs on another connection just before the completion removes its pending row
function changingTheAccountBeforeTheCompletion(inner: Driver): Driver {
	return {
		async query<T>(sql: string, params: unknown[]): Promise<T[]> {
			const act = interception.act;
			if (act !== null && PENDING_REMOVAL.test(sql)) {
				interception.act = null;
				await act();
			}
			return inner.query<T>(sql, params);
		},
		transaction<T>(work: (tx: Driver) => Promise<T>): Promise<T> {
			return inner.transaction((tx) => work(changingTheAccountBeforeTheCompletion(tx)));
		},
	};
}

const ring = testKeyRing(2);
const keys = ring.providerAt(1, [1]);
const sent: EmailMessage[] = [];
const alarms: SecurityStateAlarm[] = [];
let migrated: MigratedSchema;
let pool: Awaited<ReturnType<typeof openConnectionPool>>;
let auth: VelveAuth<"email">;
let handler: (request: Request) => Promise<Response>;
let accounts = 0;

beforeAll(async () => {
	migrated = await openMigratedSchema("reset_factor_integrity");
	pool = await openConnectionPool(POOL_SIZE);
	auth = createVelveAuth(
		configFor({
			database: changingTheAccountBeforeTheCompletion(pool),
			schema: migrated.schema,
			keys,
			log: createLogSink().write,
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

beforeEach(() => {
	alarms.length = 0;
	interception.act = null;
});

function cookieIn(answer: Response, name: string): string | null {
	for (const header of answer.headers.getSetCookie()) {
		const [pair = ""] = header.split(";");
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === name) {
			const value = pair.slice(separator + 1);
			return value === "" ? null : value;
		}
	}
	return null;
}

function withSession(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` };
}

function withPending(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.pending}=${token}` };
}

interface Account {
	readonly email: string;
	readonly userId: string;
	readonly sessionToken: string;
}

async function signUp(): Promise<Account> {
	accounts += 1;
	const email = `reset-integrity-${accounts}@example.com`;
	const answer = await handler(postTo("/sign-up", { email, password: PASSWORD }));
	const sessionToken = cookieIn(answer, DEFAULT_COOKIE_NAMES.session);
	const body = (await answer.json()) as { user: { id: string } };
	if (answer.status !== 200 || sessionToken === null) {
		throw new Error(`the sign-up answered ${answer.status} without a session`);
	}
	return { email, userId: body.user.id, sessionToken };
}

async function generateRecoveryCodes(account: Account): Promise<readonly string[]> {
	const answer = await handler(
		postTo("/factor/recovery/generate", {}, withSession(account.sessionToken)),
	);
	expect(answer.status).toBe(200);
	return ((await answer.json()) as { codes: readonly string[] }).codes;
}

/** TOTP enrolled with a code of the previous step, so the next verification is no replay of it. */
async function enrolTotp(account: Account): Promise<string> {
	const started = await handler(
		postTo("/factor/totp/enroll/start", {}, withSession(account.sessionToken)),
	);
	const { secretBase32 } = (await started.json()) as { secretBase32: string };
	const previousStep = timeStepAt(new Date()) - 1;
	const finished = await handler(
		postTo(
			"/factor/totp/enroll/finish",
			{ code: totpCodeForStep(secretBytesOfBase32(secretBase32), previousStep) },
			withSession(account.sessionToken),
		),
	);
	expect([started.status, finished.status]).toStrictEqual([200, 204]);
	return secretBase32;
}

function totpCodeNow(secret: string): string {
	return totpCodeForStep(secretBytesOfBase32(secret), timeStepAt(new Date()));
}

async function resetTokenFor(email: string): Promise<string> {
	sent.length = 0;
	const requested = await handler(postTo("/password/request-reset", { email }));
	expect(requested.status).toBe(204);
	const message = sent.find((each) => each.kind === "password_reset");
	if (message === undefined || message.kind !== "password_reset") {
		throw new Error("no reset message was sent");
	}
	return message.token;
}

async function redeemHeldBack(email: string, newPassword = REPLACEMENT): Promise<string> {
	const token = await resetTokenFor(email);
	const answer = await handler(postTo(RESET_ROUTE, { token, newPassword }));
	const pendingToken = cookieIn(answer, DEFAULT_COOKIE_NAMES.pending);
	expect(answer.status).toBe(200);
	if (pendingToken === null) {
		throw new Error("the held back reset set no pending cookie");
	}
	return pendingToken;
}

async function signInStatus(email: string, password: string): Promise<string> {
	const answer = await handler(postTo("/sign-in/password", { email, password }));
	if (answer.status !== 200) {
		return `${answer.status} ${((await answer.json()) as { error: { code: string } }).error.code}`;
	}
	return `${answer.status} ${((await answer.json()) as { status: string }).status}`;
}

async function answerOf(answer: Response): Promise<string> {
	if (answer.status !== 200) {
		return `${answer.status} ${((await answer.json()) as { error: { code: string } }).error.code}`;
	}
	return `${answer.status} ${((await answer.json()) as { status: string }).status}`;
}

async function sessionsOf(userId: string): Promise<number> {
	const [row] = await migrated.connection.query<{ total: number }>(
		`SELECT count(*)::integer AS total FROM ${migrated.schema}.session WHERE user_id = $1`,
		[userId],
	);
	return row?.total ?? -1;
}

interface PendingResetRow {
	readonly token_sha256: Uint8Array;
	readonly new_password_phc: Uint8Array | null;
	readonly new_password_key_version: number | null;
}

async function pendingRowsOf(userId: string): Promise<PendingResetRow[]> {
	return migrated.connection.query<PendingResetRow>(
		`SELECT token_sha256, new_password_phc, new_password_key_version
		FROM ${migrated.schema}.pending_authentication WHERE user_id = $1 ORDER BY created_at`,
		[userId],
	);
}

function verifyRecovery(pendingToken: string, code: string | undefined): Promise<Response> {
	return handler(postTo("/factor/recovery/verify", { code }, withPending(pendingToken)));
}

describe("two requests at once (S-FIX-8)", () => {
	it("lets one of two completions of one pending reset win, with two different codes", async () => {
		const account = await signUp();
		const codes = await generateRecoveryCodes(account);
		const pendingToken = await redeemHeldBack(account.email);

		const answers = await Promise.all([
			verifyRecovery(pendingToken, codes[0]),
			verifyRecovery(pendingToken, codes[1]),
		]);
		const statuses = answers.map((answer) => answer.status).sort();

		expect(statuses[0]).toBe(200);
		expect(statuses[1]).not.toBe(200);
		expect(await sessionsOf(account.userId)).toBe(1);
		expect(await pendingRowsOf(account.userId)).toHaveLength(0);
		expect(await signInStatus(account.email, REPLACEMENT)).toBe("200 second_factor_required");
	});

	it("spends one reset token once when it is redeemed twice at the same time", async () => {
		const account = await signUp();
		await generateRecoveryCodes(account);
		const token = await resetTokenFor(account.email);

		const answers = await Promise.all([
			handler(postTo(RESET_ROUTE, { token, newPassword: REPLACEMENT })),
			handler(postTo(RESET_ROUTE, { token, newPassword: ANOTHER })),
		]);

		expect(answers.map((answer) => answer.status).sort()).toStrictEqual([200, 400]);
		expect(await pendingRowsOf(account.userId)).toHaveLength(1);
		expect(await sessionsOf(account.userId)).toBe(1);
	});
});

describe("a change of the account between the reset and its completion", () => {
	it("refuses a completion whose account changed after its factor was checked (S-INTEG-5)", async () => {
		const account = await signUp();
		const secret = await enrolTotp(account);
		const pendingToken = await redeemHeldBack(account.email);
		interception.act = async () => {
			await auth.factor.recovery.generate({
				sessionToken: account.sessionToken,
				origin: TEST_ORIGIN,
			});
		};

		const refused = await handler(
			postTo("/factor/totp/verify", { code: totpCodeNow(secret) }, withPending(pendingToken)),
		);

		expect(interception.act).toBeNull();
		expect(await answerOf(refused)).toBe("401 invalid_factor_code");
		expect(await sessionsOf(account.userId)).toBe(1);
		expect(await pendingRowsOf(account.userId)).toHaveLength(1);
		expect(await signInStatus(account.email, PASSWORD)).toBe("200 second_factor_required");
		expect(await signInStatus(account.email, REPLACEMENT)).toBe("401 invalid_credentials");
		// A legitimate change won the race, which is no broken state and raises no alarm.
		expect(alarms).toStrictEqual([]);
	});

	it("refuses a completion after a password change revoked the account's sessions", async () => {
		const account = await signUp();
		const codes = await generateRecoveryCodes(account);
		const pendingToken = await redeemHeldBack(account.email);
		const changed = await handler(
			postTo(
				"/password/change",
				{ currentPassword: PASSWORD, newPassword: ANOTHER },
				withSession(account.sessionToken),
			),
		);

		const refused = await verifyRecovery(pendingToken, codes[0]);

		expect(changed.status).toBe(200);
		expect(await answerOf(refused)).toBe("401 invalid_pending_authentication");
		expect(await signInStatus(account.email, ANOTHER)).toBe("200 second_factor_required");
		expect(await signInStatus(account.email, REPLACEMENT)).toBe("401 invalid_credentials");
	});
});

describe("a writer of the database without the root key (S-INTEG-9, S-INTEG-1)", () => {
	it("refuses a pending reset whose new password was emptied, rather than signing in", async () => {
		const account = await signUp();
		const codes = await generateRecoveryCodes(account);
		const pendingToken = await redeemHeldBack(account.email);
		await migrated.connection.query(
			`UPDATE ${migrated.schema}.pending_authentication
			SET new_password_phc = NULL, new_password_key_version = NULL WHERE user_id = $1`,
			[account.userId],
		);

		const refused = await verifyRecovery(pendingToken, codes[0]);

		expect(await answerOf(refused)).toBe("401 invalid_pending_authentication");
		expect(await sessionsOf(account.userId)).toBe(1);
		expect(await signInStatus(account.email, PASSWORD)).toBe("200 second_factor_required");
		expect(alarms.map((alarm) => alarm.reason)).toContain("token_binding_mismatch");
	});

	it("refuses a pending reset whose new password was swapped for another row's", async () => {
		const account = await signUp();
		const codes = await generateRecoveryCodes(account);
		await redeemHeldBack(account.email, ANOTHER);
		const pendingToken = await redeemHeldBack(account.email, REPLACEMENT);
		const [first, second] = await pendingRowsOf(account.userId);
		await migrated.connection.query(
			`UPDATE ${migrated.schema}.pending_authentication
			SET new_password_phc = $2, new_password_key_version = $3 WHERE token_sha256 = $1`,
			[second?.token_sha256, first?.new_password_phc, first?.new_password_key_version],
		);

		const refused = await verifyRecovery(pendingToken, codes[0]);

		expect(await answerOf(refused)).toBe("401 invalid_pending_authentication");
		expect(await signInStatus(account.email, PASSWORD)).toBe("200 second_factor_required");
		expect(await signInStatus(account.email, ANOTHER)).toBe("401 invalid_credentials");
		expect(alarms.map((alarm) => alarm.reason)).toContain("token_binding_mismatch");
	});

	it("refuses a sign-in's pending row given a copied new password, rather than resetting", async () => {
		const account = await signUp();
		const codes = await generateRecoveryCodes(account);
		await redeemHeldBack(account.email, ANOTHER);
		const signedIn = await handler(
			postTo("/sign-in/password", { email: account.email, password: PASSWORD }),
		);
		const pendingToken = cookieIn(signedIn, DEFAULT_COOKIE_NAMES.pending) ?? "";
		const [reset, signIn] = await pendingRowsOf(account.userId);
		await migrated.connection.query(
			`UPDATE ${migrated.schema}.pending_authentication
			SET new_password_phc = $2, new_password_key_version = $3 WHERE token_sha256 = $1`,
			[signIn?.token_sha256, reset?.new_password_phc, reset?.new_password_key_version],
		);

		const refused = await verifyRecovery(pendingToken, codes[0]);

		expect(await answerOf(refused)).toBe("401 invalid_pending_authentication");
		expect(await signInStatus(account.email, ANOTHER)).toBe("401 invalid_credentials");
	});

	it("is refused by the database when it sets one of the two columns alone", async () => {
		const account = await signUp();
		await generateRecoveryCodes(account);
		await redeemHeldBack(account.email);

		const refused = await migrated.connection
			.query(
				`UPDATE ${migrated.schema}.pending_authentication SET new_password_key_version = NULL
				WHERE user_id = $1`,
				[account.userId],
			)
			.then(
				() => "written",
				(failure: unknown) => String(failure),
			);

		expect(refused).toMatch(/pending_authentication_new_password_whole/);
	});
});

describe("the maintenance rebinding of a pending reset under a new token-mac version (S-KEY-5)", () => {
	it("rebinds the row over its new password, which then still completes the reset's consumption", async () => {
		const account = await signUp();
		await generateRecoveryCodes(account);
		const pendingToken = await redeemHeldBack(account.email);
		const rotated = ring.providerAt(2, [1, 2]);
		const refusedOwners: (string | null)[] = [];

		const pass = await rebindTokenRowsUnderCurrentKey({
			driver: migrated.connection,
			schema: migrated.schema,
			keys: rotated,
			sealing: "required",
			table: "pending_authentication",
			batchSize: 100,
			reportTokenBindingRefusal: (refusal) => refusedOwners.push(refusal.userId),
		});
		const consumed = await createPendingAuthenticationService({
			driver: migrated.connection,
			keys: ring.providerAt(2, [2]),
			schema: migrated.schema,
		}).consume(toPendingToken(pendingToken));

		// The rows the writer above emptied or swapped are refused here too, and this one is not.
		expect(refusedOwners).not.toContain(account.userId);
		expect(pass.rebound).toBeGreaterThanOrEqual(1);
		expect(consumed.userId).toBe(account.userId);
		expect(consumed.reset?.newPassword.keyVersion).toBe(1);
	});
});
