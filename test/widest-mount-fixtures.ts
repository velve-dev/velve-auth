import { randomBytes } from "node:crypto";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import { createLogSink, type LogSink, TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { createStubProvider, oauthConfigFor, type StubProvider } from "./oauth-provider.js";

const WIDEST_PASSWORD = "a password the widest mount accepts 7c1e";

const WEBAUTHN = {
	relyingPartyId: "app.example.com",
	relyingPartyName: "Velve Auth tests",
	origins: [TEST_ORIGIN],
	userVerification: "required",
} as const;

const GENEROUS = { capacity: 100_000, refillPerSecond: 100_000 };

export interface WidestMount {
	readonly auth: VelveAuth<"username_email">;
	readonly handler: (request: Request) => Promise<Response>;
	readonly connection: TestConnection;
	readonly schema: string;
	readonly log: LogSink;
	readonly provider: StubProvider;
	close(): Promise<void>;
}

/** every row of 3.15 D.3 served against a schema migrated in username_email, with the rate limits lifted */
export async function mountWidest(
	prefix: string,
	overrides: Partial<VelveAuthConfig<"username_email">> = {},
): Promise<WidestMount> {
	const { connection, schema } = await openMigratedSchema(prefix, "username_email");
	const provider = await createStubProvider({
		claims: { sub: "widest-subject", email: "widest@example.com", email_verified: true },
		openIdConnect: true,
	});
	const log = createLogSink();
	const auth = createVelveAuth<"username_email">({
		identity: { mode: "username_email", username: { minimumLength: 3, maximumLength: 32 } },
		database: connection,
		schema,
		keys: testKeyProvider(),
		origins: [TEST_ORIGIN],
		email: { send: () => Promise.resolve() },
		log: log.write,
		webauthn: WEBAUTHN,
		recoveryCodes: { count: 10, groupSize: 5 },
		oauth: oauthConfigFor({ openIdConnect: true }),
		fetch: provider.fetch,
		rateLimit: { perIpAddress: GENEROUS, perAccount: GENEROUS },
		...overrides,
	});
	return {
		auth,
		handler: toWebHandler(auth),
		connection,
		schema,
		log,
		provider,
		async close() {
			await dropSchema(connection, schema);
			await connection.close();
		},
	};
}

export interface SignedUpAccount {
	readonly userId: string;
	readonly sessionId: string;
	readonly sessionCookie: string;
}

function sessionTokenIn(answer: Response): string {
	for (const line of answer.headers.getSetCookie()) {
		const pair = line.split(";")[0] ?? "";
		if (pair.startsWith(`${DEFAULT_COOKIE_NAMES.session}=`)) {
			return pair.slice(DEFAULT_COOKIE_NAMES.session.length + 1);
		}
	}
	throw new Error(`the answer (${answer.status}) carried no session cookie`);
}

export function jsonPost(path: string, body: unknown, cookie?: string): Request {
	return new Request(`https://api.example.com${path}`, {
		method: "POST",
		headers: {
			Origin: TEST_ORIGIN,
			"Content-Type": "application/json",
			...(cookie === undefined ? {} : { Cookie: cookie }),
		},
		body: JSON.stringify(body),
	});
}

export function plainGet(path: string, cookie?: string): Request {
	return new Request(`https://api.example.com${path}`, {
		headers: { Origin: TEST_ORIGIN, ...(cookie === undefined ? {} : { Cookie: cookie }) },
	});
}

/** a fresh account with a password and the session its sign-up issued */
export async function signUpOn(mount: WidestMount): Promise<SignedUpAccount> {
	const name = `u${randomBytes(6).toString("hex")}`;
	const answer = await mount.handler(
		jsonPost("/sign-up", {
			email: `${name}@example.com`,
			username: name,
			password: WIDEST_PASSWORD,
		}),
	);
	const sessionCookie = `${DEFAULT_COOKIE_NAMES.session}=${sessionTokenIn(answer)}`;
	const [row] = await mount.connection.query<{ user_id: string; id: string }>(
		`SELECT s.user_id, s.id FROM ${mount.schema}.session s
		 JOIN ${mount.schema}.user u ON u.id = s.user_id WHERE u.username = $1`,
		[name],
	);
	if (row === undefined) {
		throw new Error(`the sign-up answered ${answer.status} and left no session`);
	}
	return { userId: row.user_id, sessionId: row.id, sessionCookie };
}

/** the status, every header except Date and the body bytes of an answer as one comparable string */
export async function exactAnswer(answer: Response): Promise<string> {
	const headers = [...answer.headers]
		.filter(([name]) => name.toLowerCase() !== "date")
		.map(([name, value]) => `${name}: ${value}`)
		.sort();
	const body = Buffer.from(await answer.arrayBuffer()).toString("hex");
	return [`status ${answer.status}`, ...headers, `body ${body}`].join("\n");
}
