import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { createSessionToken } from "../src/core/session/token.js";
import {
	type MountedAuth,
	mountAuth,
	requestTo,
	TEST_ORIGIN,
	testKeyProvider,
} from "./auth-fixtures.js";
import { createUser, dropSchema } from "./db-fixtures.js";
import { createStubProvider, oauthConfigFor } from "./oauth-provider.js";
import { sessionMacParameters } from "./session-fixtures.js";

const TOKEN_KEYS = testKeyProvider();

/* ------------------------------------------------------------------ *
 * S-OWNER-8. An identifier that cannot name a row is answered exactly
 * like one that names no row: the same status, the same headers and
 * the same body, and never a 500 from a failed uuid cast (E-2242).
 * ------------------------------------------------------------------ */

const MALFORMED = ["not-a-uuid", "", "00000000-0000-0000-0000-00000000000g", "1' OR '1'='1"];
const UNKNOWN = "5b0c8d1e-9a7f-4c3b-8e2d-1f6a4b7c9d0e";

interface IdRoute {
	readonly name: string;
	readonly path: string;
	readonly body: (id: string) => Readonly<Record<string, string>>;
}

const ID_ROUTES: readonly IdRoute[] = [
	{
		name: "session.revoke",
		path: "/session/revoke",
		body: (id) => ({ targetSessionId: id }),
	},
	{ name: "identity.unlink", path: "/identity/unlink", body: (id) => ({ identityId: id }) },
	{
		name: "factor.webauthn.rename",
		path: "/factor/webauthn/rename",
		body: (id) => ({ credentialId: id, label: "renamed" }),
	},
	{
		name: "factor.webauthn.remove",
		path: "/factor/webauthn/remove",
		body: (id) => ({ credentialId: id }),
	},
];

let mounted: MountedAuth;

beforeAll(async () => {
	const provider = await createStubProvider({
		claims: { sub: "malformed-ids", email: "malformed-ids@example.com", email_verified: true },
	});
	mounted = await mountAuth("malformedids", {
		keys: TOKEN_KEYS,
		oauth: oauthConfigFor({ openIdConnect: false }),
		fetch: provider.fetch,
		webauthn: {
			relyingPartyId: "app.example.com",
			relyingPartyName: "Velve Auth tests",
			origins: [TEST_ORIGIN],
			userVerification: "required",
		},
		rateLimit: { perIpAddress: { capacity: 100_000, refillPerSecond: 1_000 } },
	});
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

async function signedInCaller(withPassword: boolean): Promise<string> {
	const userId = await createUser(mounted.connection, mounted.schema);
	if (withPassword) {
		await mounted.connection.query(
			`INSERT INTO ${mounted.schema}.password_credential (user_id, phc, scheme)
			 VALUES ($1, $2, 'argon2id')`,
			[userId, new TextEncoder().encode("not-a-real-hash")],
		);
	}
	const issued = createSessionToken();
	await mounted.connection.query(
		`INSERT INTO ${mounted.schema}.session
		   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors,
			    token_mac, token_mac_key_version, created_at)
		 VALUES ($1, $2, now() + interval '7 days', now() + interval '30 days', '{password}'::text[], $3, $4, $5::timestamptz)`,
		[
			userId,
			issued.tokenHash,
			...(await sessionMacParameters(TOKEN_KEYS, {
				userId,
				tokenHash: issued.tokenHash,
				factors: ["password"],
			})),
		],
	);
	return `${DEFAULT_COOKIE_NAMES.session}=${issued.token}`;
}

interface Answer {
	readonly status: number;
	readonly headers: readonly (readonly [string, string])[];
	readonly body: string;
}

async function answerTo(route: IdRoute, id: string, cookie: string): Promise<Answer> {
	const response = await mounted.handler(requestTo(route.path, { body: route.body(id), cookie }));
	return {
		status: response.status,
		headers: [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b)),
		body: await response.text(),
	};
}

describe("a malformed identifier answers like an unknown one (S-OWNER-8)", () => {
	for (const withPassword of [true, false]) {
		const account = withPassword ? "with a password" : "with no other sign-in method";
		for (const route of ID_ROUTES) {
			it(`${route.name}, for an account ${account}`, async () => {
				const cookie = await signedInCaller(withPassword);
				const unknown = await answerTo(route, UNKNOWN, cookie);
				const differing: string[] = [];
				for (const malformed of MALFORMED) {
					const answer = await answerTo(route, malformed, cookie);
					if (JSON.stringify(answer) !== JSON.stringify(unknown)) {
						differing.push(`${JSON.stringify(malformed)} answered ${JSON.stringify(answer)}`);
					}
				}

				//a route the mount did not carry would compare two 404s and prove nothing
				expect(unknown.status).not.toBe(404);
				expect(unknown.status).toBeLessThan(500);
				expect(differing).toStrictEqual([]);
			});
		}
	}
});
