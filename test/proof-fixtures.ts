import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import type { TestClock } from "../src/testing/index.js";
import { createLogSink, type EmailOutbox, TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";
import {
	codeCarrying,
	createStubProvider,
	oauthConfigFor,
	type StubProvider,
} from "./oauth-provider.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

export const PROOF_PASSWORD = "correct-horse-battery-staple";
const ONE_TOTP_STEP_IN_MILLISECONDS = 30_000;

/** The buckets are the subject of other files; here a refused request would hide what is measured. */
export const UNLIMITED_RATES = {
	perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
	perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
} as const;

export interface ParsedSetCookie {
	readonly name: string;
	readonly value: string;
	readonly attributes: readonly string[];
}

export function parseSetCookie(header: string): ParsedSetCookie {
	const [pair, ...attributes] = header.split(";").map((part) => part.trim());
	const separator = (pair ?? "").indexOf("=");
	return {
		name: (pair ?? "").slice(0, separator),
		value: (pair ?? "").slice(separator + 1),
		attributes,
	};
}

export function setCookieNamed(answer: Response, name: string): ParsedSetCookie | null {
	const written = answer.headers.getSetCookie().map(parseSetCookie);
	return written.find((cookie) => cookie.name === name) ?? null;
}

/** A cleared cookie is written with an empty value, which is not a cookie a client can present. */
export function issuedCookieValue(answer: Response, name: string): string | null {
	const value = setCookieNamed(answer, name)?.value ?? null;
	return value === "" ? null : value;
}

export function sessionCookieHeader(token: string): string {
	return `${DEFAULT_COOKIE_NAMES.session}=${token}`;
}

export function pendingCookieHeader(token: string): string {
	return `${DEFAULT_COOKIE_NAMES.pending}=${token}`;
}

export function oauthStateCookieHeader(pointer: string): string {
	return `${DEFAULT_COOKIE_NAMES.oauthState}=${pointer}`;
}

/** The widest instance on a real schema: both identifiers, a provider, passkeys, TOTP and recovery codes. */
export interface WidestMount {
	readonly auth: VelveAuth<"username_email">;
	readonly handler: (request: Request) => Promise<Response>;
	readonly connection: TestConnection;
	readonly schema: string;
	readonly provider: StubProvider;
	readonly email: EmailOutbox;
}

function recordingOutbox(): EmailOutbox {
	const messages: Parameters<EmailOutbox["send"]>[0][] = [];
	return {
		send: (message) => {
			messages.push(message);
			return Promise.resolve();
		},
		get messages() {
			return messages;
		},
		get count() {
			return messages.length;
		},
		recipients: () => messages.map((message) => message.to),
		kinds: () => messages.map((message) => message.kind),
		failNextSend: () => undefined,
		clear: () => {
			messages.length = 0;
		},
	};
}

export async function mountWidest(
	prefix: string,
	options: { readonly clock: TestClock; readonly responseMode?: "query" | "form_post" },
): Promise<WidestMount> {
	const { connection, schema } = await openMigratedSchema(prefix, "username_email");
	const provider = await createStubProvider({
		claims: { sub: "widest-subject", email: "widest@example.com", email_verified: true },
	});
	const email = recordingOutbox();
	const auth = createVelveAuth<"username_email">({
		identity: { mode: "username_email" },
		database: connection,
		schema,
		keys: testKeyProvider(),
		origins: [TEST_ORIGIN],
		email: { send: email.send },
		log: createLogSink().write,
		clock: options.clock,
		rateLimit: UNLIMITED_RATES,
		fetch: provider.fetch,
		oauth: oauthConfigFor({
			openIdConnect: false,
			...(options.responseMode === undefined ? {} : { responseMode: options.responseMode }),
		}),
		webauthn: {
			relyingPartyId: "app.example.com",
			relyingPartyName: "Velve Auth tests",
			origins: [TEST_ORIGIN],
			userVerification: "required",
		},
		recoveryCodes: { count: 10, groupSize: 5 },
	});
	return { auth, handler: toWebHandler(auth), connection, schema, provider, email };
}

export interface StartedFlow {
	readonly answer: Response;
	readonly pointer: string;
	readonly state: string;
}

export async function startOAuthFlow(
	handler: (request: Request) => Promise<Response>,
	path: "/sign-in/oauth/start" | "/identity/link/start",
	cookie?: string,
): Promise<StartedFlow> {
	const answer = await handler(
		postTo(path, { provider: "stubby" }, cookie === undefined ? {} : { Cookie: cookie }),
	);
	if (answer.status !== 200) {
		throw new Error(`${path} answered ${answer.status}: ${await answer.text()}`);
	}
	const pointer = issuedCookieValue(answer, DEFAULT_COOKIE_NAMES.oauthState);
	const body = (await answer.clone().json()) as { authorizationUrl: string };
	const state = new URL(body.authorizationUrl).searchParams.get("state");
	if (pointer === null || state === null) {
		throw new Error(`${path} set no state pointer or carried no state`);
	}
	return { answer, pointer, state };
}

export function oauthCallbackRequest(flow: StartedFlow, cookies: readonly string[]): Request {
	return new Request(
		`https://api.example.com/sign-in/oauth/callback/stubby?code=${codeCarrying(null)}&state=${encodeURIComponent(flow.state)}`,
		{ method: "GET", headers: cookies.length === 0 ? {} : { Cookie: cookies.join("; ") } },
	);
}

export function oauthFormPostCallbackRequest(
	flow: StartedFlow,
	cookies: readonly string[],
): Request {
	return new Request("https://api.example.com/sign-in/oauth/callback/stubby", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...(cookies.length === 0 ? {} : { Cookie: cookies.join("; ") }),
		},
		body: new URLSearchParams({ code: codeCarrying(null), state: flow.state }),
	});
}

export function totpCodeNow(secretBase32: string, clock: TestClock): string {
	return totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now()));
}

/** The enrolment claims its own time step, so a verification after it steps past that window (S-REPLAY-4). */
export async function enrolTotp(
	handler: (request: Request) => Promise<Response>,
	clock: TestClock,
	sessionToken: string,
): Promise<string> {
	const withSession = { Cookie: sessionCookieHeader(sessionToken) };
	const started = await handler(postTo("/factor/totp/enroll/start", {}, withSession));
	const { secretBase32 } = (await started.json()) as { secretBase32: string };
	const finished = await handler(
		postTo("/factor/totp/enroll/finish", { code: totpCodeNow(secretBase32, clock) }, withSession),
	);
	if (started.status !== 200 || finished.status !== 204) {
		throw new Error(`the enrolment answered ${started.status} and ${finished.status}`);
	}
	clock.advanceBy(2 * ONE_TOTP_STEP_IN_MILLISECONDS);
	return secretBase32;
}

/** Every table of the schema with every row as text, so any write a call makes shows as a difference. */
export async function snapshotOfEveryTable(
	driver: TestConnection,
	schema: string,
): Promise<Map<string, readonly string[]>> {
	const tables = await driver.query<{ table_name: string }>(
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
		[schema],
	);
	if (tables.length === 0) {
		throw new Error(`information_schema lists no table in ${schema}`);
	}
	const snapshot = new Map<string, readonly string[]>();
	for (const { table_name: table } of tables) {
		const rows = await driver.query<{ row: string }>(
			`SELECT row_to_json(t)::text AS row FROM ${schema}."${table}" t ORDER BY 1`,
			[],
		);
		snapshot.set(
			table,
			rows.map((row) => row.row),
		);
	}
	return snapshot;
}
