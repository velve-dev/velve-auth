import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import type { EmailMessage, VelveAuthConfig } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type {
	PasskeyRecoveryStartedEvent,
	SecurityStateAlarm,
	SessionRevokeEvent,
	VelveAuth,
} from "../src/index.js";
import { createVelveAuth } from "../src/index.js";
import {
	configFor,
	createLogSink,
	type LogSink,
	TEST_ORIGIN,
	testKeyProvider,
} from "./auth-fixtures.js";
import { dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { createVirtualAuthenticator, type VirtualAuthenticator } from "./webauthn-simulator.js";

/**
 * The recovery to a new passkey over HTTP (3.18, S-INTEG-12, S-ENUM-10, S-RACE-7, S-LINK-9): one
 * instance with the recovery configured, its waiting period set by the test, a mail outbox, a
 * plugin that records the recovery and revocation hooks, and a recording driver for the
 * statement sequences the uniformity cases compare.
 */

const PASSWORD = "correct-horse-battery-staple";
const RELYING_PARTY_ID = "app.example.com";

export interface Call {
	readonly statement: string;
	readonly parameterCount: number;
}

export interface RecoveryBench {
	readonly auth: VelveAuth<"email">;
	readonly handler: (request: Request) => Promise<Response>;
	readonly migrated: MigratedSchema;
	readonly sent: EmailMessage[];
	readonly calls: Call[];
	readonly started: PasskeyRecoveryStartedEvent[];
	readonly revoked: SessionRevokeEvent[];
	readonly alarms: SecurityStateAlarm[];
	readonly waitingPeriodsAskedFor: unknown[];
	readonly log: LogSink;
	/** the answer the waiting period function gives the next time it is asked */
	waitingPeriod: unknown;
	close(): Promise<void>;
}

function recording(inner: Driver, calls: Call[]): Driver {
	return {
		query: (sql, parameters) => {
			calls.push({ statement: sql.replace(/\s+/g, " ").trim(), parameterCount: parameters.length });
			return inner.query(sql, parameters);
		},
		transaction: (run) => {
			calls.push({ statement: "BEGIN", parameterCount: 0 });
			return inner.transaction((transaction) => run(recording(transaction, calls)));
		},
	};
}

export async function openRecoveryBench(
	prefix: string,
	overrides: Omit<Partial<VelveAuthConfig<"email">>, "database" | "schema"> = {},
): Promise<RecoveryBench> {
	const migrated = await openMigratedSchema(prefix);
	const calls: Call[] = [];
	const sent: EmailMessage[] = [];
	const started: PasskeyRecoveryStartedEvent[] = [];
	const revoked: SessionRevokeEvent[] = [];
	const alarms: SecurityStateAlarm[] = [];
	const waitingPeriodsAskedFor: unknown[] = [];
	const log = createLogSink();
	const bench = {
		migrated,
		sent,
		calls,
		started,
		revoked,
		alarms,
		waitingPeriodsAskedFor,
		log,
		waitingPeriod: 0 as unknown,
	};
	const auth = createVelveAuth(
		configFor({
			database: recording(migrated.connection, calls),
			schema: migrated.schema,
			keys: testKeyProvider(),
			log: log.write,
			email: {
				send: (message) => {
					sent.push(message);
					return Promise.resolve();
				},
			},
			webauthn: {
				relyingPartyId: RELYING_PARTY_ID,
				relyingPartyName: "Velve Auth tests",
				origins: [TEST_ORIGIN],
				userVerification: "required",
				recovery: {
					waitingPeriodInSeconds: (context) => {
						waitingPeriodsAskedFor.push(context);
						return bench.waitingPeriod as number;
					},
				},
			},
			rateLimit: {
				perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
				perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
			},
			securityState: { sealing: "required", alarm: (alarm) => alarms.push(alarm) },
			plugins: [
				{
					id: "recorder",
					hooks: {
						afterPasskeyRecoveryStart: async (event) => {
							started.push(event);
						},
						beforeSessionRevoke: async (event) => {
							revoked.push(event);
						},
					},
				},
			],
			...overrides,
		}),
	);
	return Object.assign(bench, {
		auth,
		handler: toWebHandler(auth),
		close: async () => {
			await dropSchema(migrated.connection, migrated.schema);
			await migrated.connection.close();
		},
	});
}

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

export function withSession(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` };
}

export function getFrom(path: string, headers: Record<string, string> = {}): Request {
	return new Request(`https://api.example.com${path}`, {
		headers: { Origin: TEST_ORIGIN, ...headers },
	});
}

export async function errorCodeOf(answer: Response): Promise<string> {
	return ((await answer.json()) as { error: { code: string } }).error.code;
}

export function newAuthenticator(): Promise<VirtualAuthenticator> {
	return createVirtualAuthenticator({
		relyingPartyId: RELYING_PARTY_ID,
		origin: TEST_ORIGIN,
		flags: { userVerified: true, backupEligible: true, backupState: true },
	});
}

interface Account {
	readonly email: string;
	readonly userId: string;
	readonly sessionToken: string;
}

let accounts = 0;

export async function signUp(bench: RecoveryBench): Promise<Account> {
	accounts += 1;
	const email = `recover-${accounts}-${Date.now()}@example.com`;
	const answer = await bench.handler(postTo("/sign-up", { email, password: PASSWORD }));
	const sessionToken = cookieIn(answer, DEFAULT_COOKIE_NAMES.session);
	const body = (await answer.json()) as { user: { id: string } };
	if (answer.status !== 200 || sessionToken === null) {
		throw new Error(`the sign-up answered ${answer.status} without a session`);
	}
	return { email, userId: body.user.id, sessionToken };
}

export async function signInWithPassword(bench: RecoveryBench, email: string): Promise<Response> {
	return bench.handler(postTo("/sign-in/password", { email, password: PASSWORD }));
}

export async function generateCodes(
	bench: RecoveryBench,
	account: Account,
): Promise<readonly string[]> {
	const answer = await bench.handler(
		postTo("/factor/recovery/generate", {}, withSession(account.sessionToken)),
	);
	if (answer.status !== 200) {
		throw new Error(`generating codes answered ${answer.status}`);
	}
	return ((await answer.json()) as { codes: readonly string[] }).codes;
}

export async function registerPasskey(
	bench: RecoveryBench,
	account: Account,
): Promise<VirtualAuthenticator> {
	const authenticator = await newAuthenticator();
	const started = await bench.handler(
		postTo("/factor/webauthn/register/start", {}, withSession(account.sessionToken)),
	);
	const { challengeToken } = (await started.json()) as { challengeToken: string };
	const response = await authenticator.attest({ challenge: challengeToken });
	const finished = await bench.handler(
		postTo(
			"/factor/webauthn/register/finish",
			{ challengeToken, response, label: "old key" },
			withSession(account.sessionToken),
		),
	);
	if (finished.status !== 200) {
		throw new Error(`the registration answered ${finished.status}`);
	}
	return authenticator;
}

/** the last recovery link mailed to the address, or null where none was */
export function lastRecoveryLinkTo(bench: RecoveryBench, email: string): string | null {
	const message = [...bench.sent]
		.reverse()
		.find((sent) => sent.kind === "passkey_recovery" && sent.to === email);
	return message?.kind === "passkey_recovery" ? message.token : null;
}

export async function requestRecovery(bench: RecoveryBench, email: string): Promise<Response> {
	return bench.handler(postTo("/passkey-recovery/request", { email }));
}

export async function mailedRecoveryLink(bench: RecoveryBench, email: string): Promise<string> {
	const answer = await requestRecovery(bench, email);
	const token = lastRecoveryLinkTo(bench, email);
	if (answer.status !== 204 || token === null) {
		throw new Error(`the request answered ${answer.status} and mailed no link`);
	}
	return token;
}

export async function startRecovery(
	bench: RecoveryBench,
	token: string,
	recoveryCode: string,
): Promise<Response> {
	return bench.handler(postTo("/passkey-recovery/start", { token, recoveryCode }));
}

interface StartedRecovery {
	readonly challengeToken: string;
	readonly publicKeyOptions: {
		readonly excludeCredentials?: readonly { readonly id: string }[];
		readonly authenticatorSelection?: { readonly userVerification?: string };
	};
}

export async function startedRecovery(
	bench: RecoveryBench,
	token: string,
	recoveryCode: string,
): Promise<StartedRecovery> {
	const answer = await startRecovery(bench, token, recoveryCode);
	if (answer.status !== 200) {
		throw new Error(`the start answered ${answer.status}`);
	}
	return (await answer.json()) as StartedRecovery;
}

export async function finishRecovery(
	bench: RecoveryBench,
	challengeToken: string,
	response: RegistrationResponseJSON | Record<string, unknown>,
): Promise<Response> {
	return bench.handler(
		postTo("/passkey-recovery/finish", { challengeToken, response, label: "recovered key" }),
	);
}

/** the whole recovery from the address to the registered passkey, answering the finish */
export async function recoverTo(
	bench: RecoveryBench,
	account: Account,
	recoveryCode: string,
	authenticator: VirtualAuthenticator,
): Promise<Response> {
	const token = await mailedRecoveryLink(bench, account.email);
	const started = await startedRecovery(bench, token, recoveryCode);
	const response = await authenticator.attest({ challenge: started.challengeToken });
	return finishRecovery(bench, started.challengeToken, response);
}

export async function signInWithPasskey(
	bench: RecoveryBench,
	authenticator: VirtualAuthenticator,
): Promise<Response> {
	const started = await bench.handler(postTo("/sign-in/passkey/start", {}));
	const { challengeToken } = (await started.json()) as { challengeToken: string };
	const response = await authenticator.assert({ challenge: challengeToken });
	return bench.handler(postTo("/sign-in/passkey/finish", { challengeToken, response }));
}

export async function sessionResolves(
	bench: RecoveryBench,
	sessionToken: string,
): Promise<boolean> {
	const answer = await bench.handler(getFrom("/session", withSession(sessionToken)));
	const body = (await answer.json()) as unknown;
	return answer.status === 200 && body !== null;
}

export async function countOf(
	bench: RecoveryBench,
	table: string,
	userId: string,
): Promise<number> {
	const [row] = await bench.migrated.connection.query<{ total: number }>(
		`SELECT count(*)::integer AS total FROM ${bench.migrated.schema}.${table} WHERE user_id = $1`,
		[userId],
	);
	return row?.total ?? -1;
}

/** waits on the wall clock, which is the database clock the waiting period is measured on */
export function waitSeconds(seconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** the alarm is delivered off the response path, so a test waits for it rather than reading it at once */
export async function alarmsRaisedFor(
	bench: RecoveryBench,
	userId: string,
): Promise<readonly SecurityStateAlarm[]> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const raised = bench.alarms.filter((alarm) => alarm.userId === userId);
		if (raised.length > 0) {
			return raised;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return [];
}
