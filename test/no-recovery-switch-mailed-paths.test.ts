import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { mintArtefact } from "../src/core/flows/artefact.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { OneTimeTokenPurpose } from "../src/core/token/purpose.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { configFor, createLogSink, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { difference, postTo } from "./flows-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

/**
 * S-ENUM-9 and T-ENUM-9: while an account has turned recovery off, a request for a reset or a
 * magic link takes the branch of an address that names no account, statement for statement and
 * send for send; a link of the account is refused as an unknown token and stays unspent; a
 * reset held back for a second factor does not complete; a recovery code answers as a wrong
 * one; and generating codes refuses with `recovery_disabled`.
 */

const PASSWORD = "correct-horse-battery-staple";
const REPLACEMENT = "a different password entirely";
const ONE_TOTP_STEP_IN_MILLISECONDS = 30_000;
const UNKNOWN = "nobody-at-all@example.com";

const ENDPOINTS = [
	{ path: "/password/request-reset", artefact: "password_reset" },
	{ path: "/sign-in/magic-link/request", artefact: "magic_link" },
] as const;

interface Call {
	readonly statement: string;
	readonly parameterCount: number;
}

const keys = testKeyProvider();
const calls: Call[] = [];
const sent: EmailMessage[] = [];
const log = createLogSink();
let migrated: MigratedSchema;
let auth: VelveAuth<"email">;
let handler: (request: Request) => Promise<Response>;
let clock: TestClock;
let accounts = 0;

function recording(inner: Driver): Driver {
	return {
		query: (sql, parameters) => {
			calls.push({ statement: sql.replace(/\s+/g, " ").trim(), parameterCount: parameters.length });
			return inner.query(sql, parameters);
		},
		transaction: (run) => {
			calls.push({ statement: "BEGIN", parameterCount: 0 });
			return inner.transaction((transaction) => run(recording(transaction)));
		},
	};
}

beforeAll(async () => {
	clock = createTestClock();
	migrated = await openMigratedSchema("norecovery_mail");
	auth = createVelveAuth(
		configFor({
			database: recording(migrated.connection),
			schema: migrated.schema,
			keys,
			clock,
			log: log.write,
			email: {
				send: (message) => {
					sent.push(message);
					return Promise.resolve();
				},
			},
			rateLimit: {
				perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
				perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
			},
		}),
	);
	handler = toWebHandler(auth);
}, 60_000);

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

beforeEach(() => {
	sent.length = 0;
});

function cookieIn(answer: Response, name: string): string | null {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === name) {
			const value = pair.slice(separator + 1);
			return value === "" ? null : value;
		}
	}
	return null;
}

async function errorCodeOf(answer: Response): Promise<string> {
	return ((await answer.json()) as { error: { code: string } }).error.code;
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
	const email = `no-recovery-mail-${accounts}@example.com`;
	const answer = await handler(postTo("/sign-up", { email, password: PASSWORD }));
	const sessionToken = cookieIn(answer, DEFAULT_COOKIE_NAMES.session);
	const body = (await answer.json()) as { user: { id: string } };
	if (answer.status !== 200 || sessionToken === null) {
		throw new Error(`the sign-up answered ${answer.status} without a session`);
	}
	return { email, userId: body.user.id, sessionToken };
}

async function enrolTotp(account: Account): Promise<string> {
	const started = await handler(
		postTo("/factor/totp/enroll/start", {}, withSession(account.sessionToken)),
	);
	const { secretBase32 } = (await started.json()) as { secretBase32: string };
	const finished = await handler(
		postTo(
			"/factor/totp/enroll/finish",
			{ code: codeNow(secretBase32) },
			withSession(account.sessionToken),
		),
	);
	expect([started.status, finished.status]).toStrictEqual([200, 204]);
	clock.advanceBy(2 * ONE_TOTP_STEP_IN_MILLISECONDS);
	return secretBase32;
}

function codeNow(secretBase32: string): string {
	return totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now()));
}

async function generateRecoveryCodes(account: Account): Promise<readonly string[]> {
	const answer = await handler(
		postTo("/factor/recovery/generate", {}, withSession(account.sessionToken)),
	);
	expect(answer.status).toBe(200);
	return ((await answer.json()) as { codes: readonly string[] }).codes;
}

interface Observation {
	readonly status: number;
	readonly body: string;
	readonly calls: readonly Call[];
	readonly sends: readonly EmailMessage["kind"][];
}

async function requestAt(path: string, email: string): Promise<Observation> {
	await migrated.connection.query(`DELETE FROM ${migrated.schema}.rate_bucket`, []);
	calls.length = 0;
	sent.length = 0;
	const answer = await handler(postTo(path, { email }));
	const body = await answer.text();
	return {
		status: answer.status,
		body,
		calls: [...calls],
		sends: sent.map((message) => message.kind),
	};
}

async function tokenRowsOf(userId: string, purpose: OneTimeTokenPurpose): Promise<number> {
	const [row] = await migrated.connection.query<{ total: number }>(
		`SELECT count(*)::integer AS total FROM ${migrated.schema}.one_time_token
		WHERE user_id = $1 AND purpose = $2`,
		[userId, purpose],
	);
	return row?.total ?? -1;
}

//a link minted in the window between a request's lookup and the switch carries the new generation
async function linkMintedAfterTheSwitch(
	account: Account,
	purpose: OneTimeTokenPurpose,
): Promise<string> {
	const minted = await migrated.connection.transaction((transaction) =>
		mintArtefact(
			transaction,
			{ schema: migrated.schema, keys },
			{ purpose, subject: { userId: account.userId }, accountEmail: account.email },
		),
	);
	return minted.token;
}

async function signInWithPassword(email: string, password: string): Promise<Response> {
	return handler(postTo("/sign-in/password", { email, password }));
}

describe("a request for a switched-off account takes the branch of an unknown address (S-ENUM-9)", () => {
	it.each(ENDPOINTS)(
		"$path runs the unknown address's statements and sends request_for_unknown_address once",
		async (endpoint) => {
			const account = await signUp();
			await auth.user.disableRecovery({ userId: account.userId });

			const switchedOff = await requestAt(endpoint.path, account.email);
			const unknown = await requestAt(endpoint.path, UNKNOWN);

			expect(switchedOff.calls.length).toBeGreaterThan(3);
			expect(switchedOff.calls).toStrictEqual(unknown.calls);
			expect([switchedOff.status, unknown.status]).toStrictEqual([204, 204]);
			expect(switchedOff.body).toBe(unknown.body);
			expect(switchedOff.sends).toStrictEqual(["request_for_unknown_address"]);
			expect(unknown.sends).toStrictEqual(["request_for_unknown_address"]);
			expect(await tokenRowsOf(account.userId, endpoint.artefact)).toBe(0);
		},
	);

	it.each(ENDPOINTS)(
		"$path sends the artefact again once recovery is back on",
		async (endpoint) => {
			const account = await signUp();
			await auth.user.disableRecovery({ userId: account.userId });
			await auth.user.enableRecovery({ userId: account.userId });

			const restored = await requestAt(endpoint.path, account.email);

			expect(restored.sends).toStrictEqual([endpoint.artefact]);
			expect(await tokenRowsOf(account.userId, endpoint.artefact)).toBe(1);
		},
	);

	it("leaves an account that never turned the switch on its own branch", async () => {
		const account = await signUp();

		const known = await requestAt("/password/request-reset", account.email);

		expect(known.sends).toStrictEqual(["password_reset"]);
	});
});

describe("a link of a switched-off account is refused as an unknown token and stays unspent (S-ENUM-9)", () => {
	it("refuses a reset link minted after the switch went on, and the password stays", async () => {
		const account = await signUp();
		await auth.user.disableRecovery({ userId: account.userId });
		const token = await linkMintedAfterTheSwitch(account, "password_reset");
		const firstLine = log.lines.length;

		const refused = await handler(
			postTo("/password/redeem-reset", { token, newPassword: REPLACEMENT }),
		);
		const invented = await handler(
			postTo("/password/redeem-reset", {
				token: `${token.slice(0, -2)}AA`,
				newPassword: REPLACEMENT,
			}),
		);

		expect(await difference(refused, invented)).toStrictEqual([]);
		expect(refused.status).toBe(400);
		expect(await tokenRowsOf(account.userId, "password_reset")).toBe(1);
		expect((await signInWithPassword(account.email, PASSWORD)).status).toBe(200);
		expect((await signInWithPassword(account.email, REPLACEMENT)).status).toBe(401);
		expect(log.lines.slice(firstLine).map((line) => line.fields.reason)).toContain(
			"recovery_disabled_on_token_redemption",
		);
	});

	it("refuses a magic link minted after the switch went on and issues no session", async () => {
		const account = await signUp();
		await auth.user.disableRecovery({ userId: account.userId });
		const token = await linkMintedAfterTheSwitch(account, "magic_link");

		const refused = await handler(postTo("/sign-in/magic-link/redeem", { token }));
		const invented = await handler(
			postTo("/sign-in/magic-link/redeem", { token: `${token.slice(0, -2)}AA` }),
		);

		expect(cookieIn(refused, DEFAULT_COOKIE_NAMES.session)).toBeNull();
		expect(await difference(refused, invented)).toStrictEqual([]);
		expect(refused.status).toBe(400);
		expect(await tokenRowsOf(account.userId, "magic_link")).toBe(1);
	});

	it("refuses a link minted before the switch went on even once it is off again", async () => {
		const account = await signUp();
		const reset = await linkMintedAfterTheSwitch(account, "password_reset");
		const magic = await linkMintedAfterTheSwitch(account, "magic_link");
		await auth.user.disableRecovery({ userId: account.userId });
		await auth.user.enableRecovery({ userId: account.userId });

		const resetAnswer = await handler(
			postTo("/password/redeem-reset", { token: reset, newPassword: REPLACEMENT }),
		);
		const magicAnswer = await handler(postTo("/sign-in/magic-link/redeem", { token: magic }));

		expect([resetAnswer.status, magicAnswer.status]).toStrictEqual([400, 400]);
		expect([await errorCodeOf(resetAnswer), await errorCodeOf(magicAnswer)]).toStrictEqual([
			"invalid_token",
			"invalid_token",
		]);
		expect((await signInWithPassword(account.email, PASSWORD)).status).toBe(200);
	});
});

describe("a reset held back for a second factor does not complete once recovery is off (S-ENUM-9)", () => {
	it("refuses the completion as a missing pending authentication and keeps the old password", async () => {
		const account = await signUp();
		const secret = await enrolTotp(account);
		await requestAt("/password/request-reset", account.email);
		const message = sent.find((candidate) => candidate.kind === "password_reset");
		if (message === undefined || message.kind !== "password_reset") {
			throw new Error("no reset message was sent");
		}
		const held = await handler(
			postTo("/password/redeem-reset", { token: message.token, newPassword: REPLACEMENT }),
		);
		const pendingToken = cookieIn(held, DEFAULT_COOKIE_NAMES.pending);
		expect(held.status).toBe(200);
		expect(((await held.json()) as { status: string }).status).toBe("second_factor_required");
		if (pendingToken === null) {
			throw new Error("the held back reset set no pending cookie");
		}

		await auth.user.disableRecovery({ userId: account.userId });
		const completed = await handler(
			postTo("/factor/totp/verify", { code: codeNow(secret) }, withPending(pendingToken)),
		);

		expect(completed.status).toBe(401);
		expect(await errorCodeOf(completed)).toBe("invalid_pending_authentication");
		expect(cookieIn(completed, DEFAULT_COOKIE_NAMES.session)).toBeNull();
		const old = await signInWithPassword(account.email, PASSWORD);
		expect(old.status).toBe(200);
		expect(((await old.json()) as { status: string }).status).toBe("second_factor_required");
		expect((await signInWithPassword(account.email, REPLACEMENT)).status).toBe(401);
	});
});

describe("recovery codes while recovery is off (S-ENUM-9)", () => {
	it("answers a deleted code at the second factor as a wrong code", async () => {
		const account = await signUp();
		await enrolTotp(account);
		const codes = await generateRecoveryCodes(account);
		await auth.user.disableRecovery({ userId: account.userId });

		const signedIn = await signInWithPassword(account.email, PASSWORD);
		const pendingToken = cookieIn(signedIn, DEFAULT_COOKIE_NAMES.pending);
		const pending = (await signedIn.json()) as { pending: { availableFactors: string[] } };
		if (pendingToken === null) {
			throw new Error("the sign-in set no pending cookie");
		}
		const deleted = await handler(
			postTo("/factor/recovery/verify", { code: codes[0] }, withPending(pendingToken)),
		);
		const wrong = await handler(
			postTo("/factor/recovery/verify", { code: "aaaa-bbbb-cccc-dddd" }, withPending(pendingToken)),
		);

		expect(pending.pending.availableFactors).toStrictEqual(["totp"]);
		expect(deleted.status).toBe(401);
		expect(await difference(deleted, wrong)).toStrictEqual([]);
	});

	it("answers a deleted code in the reset as a wrong code and changes no password", async () => {
		const account = await signUp();
		const codes = await generateRecoveryCodes(account);
		await auth.user.disableRecovery({ userId: account.userId });

		const deleted = await handler(
			postTo("/password/redeem-reset-with-recovery-code", {
				email: account.email,
				recoveryCode: codes[1],
				newPassword: REPLACEMENT,
			}),
		);
		const wrong = await handler(
			postTo("/password/redeem-reset-with-recovery-code", {
				email: account.email,
				recoveryCode: "aaaa-bbbb-cccc-dddd",
				newPassword: REPLACEMENT,
			}),
		);

		expect(deleted.status).toBe(401);
		expect(await difference(deleted, wrong)).toStrictEqual([]);
		expect((await signInWithPassword(account.email, PASSWORD)).status).toBe(200);
	});

	it("refuses to generate codes with recovery_disabled, and generates them once it is on again", async () => {
		const account = await signUp();
		await auth.user.disableRecovery({ userId: account.userId });

		const refused = await handler(
			postTo("/factor/recovery/generate", {}, withSession(account.sessionToken)),
		);
		await auth.user.enableRecovery({ userId: account.userId });
		const generated = await handler(
			postTo("/factor/recovery/generate", {}, withSession(account.sessionToken)),
		);

		expect(refused.status).toBe(409);
		expect(await refused.json()).toStrictEqual({
			error: { code: "recovery_disabled", message: "Recovery is turned off for this account." },
		});
		expect(generated.status).toBe(200);
	});
});
