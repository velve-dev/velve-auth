import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ID_TOKEN_SIGNATURE_ALGORITHMS } from "../src/core/oauth/id-token.js";
import { automaticLinkIsAllowed } from "../src/core/oauth/linking.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { registerPluginErrorCodes, VelveError } from "../src/index.js";
import { type MountedAuth, mountAuth, requestTo, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import {
	CALLBACK_BASE_URL,
	codeCarrying,
	createStubProvider,
	oauthConfigFor,
	type ProviderClaims,
	type StubProvider,
} from "./oauth-provider.js";

interface Mounted {
	readonly auth: MountedAuth;
	readonly provider: StubProvider;
}

const mountedInstances: MountedAuth[] = [];

async function mountWith(input: {
	readonly claims: ProviderClaims;
	readonly openIdConnect?: boolean;
	readonly trusted?: boolean;
	readonly storeTokens?: boolean;
	readonly responseMode?: "query" | "form_post";
	readonly omitIssuer?: boolean;
	readonly plugins?: readonly VelvePlugin[];
}): Promise<Mounted> {
	const provider = await createStubProvider({
		claims: input.claims,
		...(input.openIdConnect === undefined ? {} : { openIdConnect: input.openIdConnect }),
	});
	const auth = await mountAuth("oauthflow", {
		oauth: oauthConfigFor({
			openIdConnect: input.openIdConnect === true,
			...(input.trusted === undefined ? {} : { trusted: input.trusted }),
			...(input.storeTokens === undefined ? {} : { storeTokens: input.storeTokens }),
			...(input.responseMode === undefined ? {} : { responseMode: input.responseMode }),
			...(input.omitIssuer === undefined ? {} : { omitIssuer: input.omitIssuer }),
		}),
		fetch: provider.fetch,
		...(input.plugins === undefined ? {} : { plugins: input.plugins }),
	});
	mountedInstances.push(auth);
	return { auth, provider };
}

afterEach(async () => {
	for (const mounted of mountedInstances.splice(0)) {
		await dropSchema(mounted.connection, mounted.schema);
		await mounted.connection.close();
	}
});

interface StartedFlow {
	readonly pointer: string;
	readonly state: string;
	readonly nonce: string | null;
	readonly authorizationUrl: URL;
}

async function start(mounted: Mounted, cookie?: string): Promise<StartedFlow> {
	const response = await mounted.auth.handler(
		requestTo("/sign-in/oauth/start", {
			body: { provider: "stubby" },
			...(cookie === undefined ? {} : { cookie }),
		}),
	);
	expect(response.status, await response.clone().text()).toBe(200);
	const body = (await response.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const authorizationUrl = new URL(body.authorizationUrl);
	return {
		pointer: body.stateCookie.value,
		state: authorizationUrl.searchParams.get("state") ?? "",
		nonce: authorizationUrl.searchParams.get("nonce"),
		authorizationUrl,
	};
}

async function startLink(mounted: Mounted, sessionCookie: string): Promise<StartedFlow> {
	const response = await mounted.auth.handler(
		requestTo("/identity/link/start", { body: { provider: "stubby" }, cookie: sessionCookie }),
	);
	expect(response.status, await response.clone().text()).toBe(200);
	const body = (await response.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const authorizationUrl = new URL(body.authorizationUrl);
	return {
		pointer: body.stateCookie.value,
		state: authorizationUrl.searchParams.get("state") ?? "",
		nonce: authorizationUrl.searchParams.get("nonce"),
		authorizationUrl,
	};
}

function callbackRequest(
	flow: StartedFlow,
	options: { readonly pointer?: string | null; readonly cookie?: string } = {},
): Request {
	const code = codeCarrying(flow.nonce);
	const pointer = options.pointer === undefined ? flow.pointer : options.pointer;
	const cookies = [
		pointer === null ? null : `__Host-velve_oauth_state=${pointer}`,
		options.cookie ?? null,
	].filter((value): value is string => value !== null);
	return requestTo(
		`/sign-in/oauth/callback/stubby?code=${code}&state=${encodeURIComponent(flow.state)}`,
		{ method: "GET", ...(cookies.length === 0 ? {} : { cookie: cookies.join("; ") }) },
	);
}

function sessionCookieOf(response: Response): string | null {
	const written = response.headers.getSetCookie();
	const line = written.find((cookie) => cookie.startsWith("__Host-velve_session="));
	return line === undefined ? null : (line.split(";")[0] ?? null);
}

async function countRows(mounted: Mounted, table: string): Promise<number> {
	const [row] = await mounted.auth.connection.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM ${mounted.auth.schema}.${table}`,
		[],
	);
	return row?.count ?? 0;
}

const VERIFIED_CLAIMS: ProviderClaims = {
	sub: "provider-subject-1",
	email: "Signed.In@Example.com",
	email_verified: true,
};

describe("the authorization request (3.10)", () => {
	it("carries PKCE S256, the state and the configured redirect target", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS });
		const flow = await start(mounted);
		const parameters = flow.authorizationUrl.searchParams;

		expect(flow.authorizationUrl.origin).toBe("https://provider.example");
		expect(parameters.get("code_challenge_method")).toBe("S256");
		expect(parameters.get("code_challenge")).toHaveLength(43);
		expect(parameters.get("redirect_uri")).toBe(`${CALLBACK_BASE_URL}/stubby`);
		expect(parameters.get("response_type")).toBe("code");
		expect(flow.state).toHaveLength(43);
	});

	it("keeps the state out of the cookie and the pointer out of the query", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS });
		const flow = await start(mounted);

		expect(flow.pointer).not.toBe(flow.state);
		expect(flow.authorizationUrl.toString()).not.toContain(flow.pointer);
	});

	it("stores the verifier encrypted and never in the cookie", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS });
		const flow = await start(mounted);
		const [row] = await mounted.auth.connection.query<{
			pkce_verifier_enc: Uint8Array;
			key_version: number;
		}>(`SELECT pkce_verifier_enc, key_version FROM ${mounted.auth.schema}.oauth_flow`, []);

		expect(row?.key_version).toBe(1);
		expect(new TextDecoder().decode(Uint8Array.from(row?.pkce_verifier_enc ?? []))).not.toContain(
			flow.pointer,
		);
	});
});

describe("the callback signs in (3.10, 3.15 D.3)", () => {
	it("answers 302 to the stored path, sets a session and writes one identity", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS });
		const response = await mounted.auth.handler(callbackRequest(await start(mounted)));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/");
		expect(sessionCookieOf(response)).not.toBeNull();
		expect(await countRows(mounted, "identity")).toBe(1);
		expect(await countRows(mounted, "session")).toBe(1);
		expect(await countRows(mounted, "oauth_flow")).toBe(0);
	});

	it("finds the same account the second time and creates no second one", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS });
		await mounted.auth.handler(callbackRequest(await start(mounted)));
		await mounted.auth.handler(callbackRequest(await start(mounted)));

		expect(await countRows(mounted, "identity")).toBe(1);
		expect(await countRows(mounted, "user")).toBe(1);
	});

	it("stores the address the provider reported, normalised, and nothing invented", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS, trusted: true });
		const answer = await mounted.auth.handler(callbackRequest(await start(mounted)));
		const [row] = await mounted.auth.connection.query<{
			email: string;
			email_verified_at: Date | null;
		}>(`SELECT email, email_verified_at FROM ${mounted.auth.schema}.user`, []);

		expect(answer.status).toBe(302);
		expect(row?.email).toBe("signed.in@example.com");
		expect(row?.email_verified_at).not.toBeNull();
	});

	it("leaves the address unverified when the provider is not trusted", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS });
		await mounted.auth.handler(callbackRequest(await start(mounted)));
		const [row] = await mounted.auth.connection.query<{ email_verified_at: Date | null }>(
			`SELECT email_verified_at FROM ${mounted.auth.schema}.user`,
			[],
		);

		expect(row?.email_verified_at).toBeNull();
	});
});

describe("S-CSRF-5: the pointer cookie is half of the check", () => {
	it("refuses a callback without the cookie and one from another cookie context", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS });
		const withoutCookie = await mounted.auth.handler(
			callbackRequest(await start(mounted), { pointer: null }),
		);
		const foreign = await start(mounted);
		const other = await start(mounted);
		const crossed = await mounted.auth.handler(
			callbackRequest(foreign, { pointer: other.pointer }),
		);

		expect([withoutCookie.status, crossed.status]).toStrictEqual([400, 400]);
		expect(await countRows(mounted, "session")).toBe(0);
		expect(await countRows(mounted, "identity")).toBe(0);
	});

	it("spends a state exactly once", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS });
		const flow = await start(mounted);
		const first = await mounted.auth.handler(callbackRequest(flow));
		const second = await mounted.auth.handler(callbackRequest(flow));

		expect([first.status, second.status]).toStrictEqual([302, 400]);
		expect(await countRows(mounted, "session")).toBe(1);
	});
});

describe("S-LINK-2: all three conditions, and never two of them", () => {
	it("allows the link only where every condition holds", () => {
		const cases = [false, true].flatMap((first) =>
			[false, true].flatMap((second) =>
				[false, true].map((third) => ({
					providerReportsTheAddressVerified: first,
					localAccountHasEmailVerifiedAt: second,
					providerIsTrusted: third,
				})),
			),
		);

		expect(cases).toHaveLength(8);
		expect(cases.filter(automaticLinkIsAllowed)).toStrictEqual([
			{
				providerReportsTheAddressVerified: true,
				localAccountHasEmailVerifiedAt: true,
				providerIsTrusted: true,
			},
		]);
	});

	it("does not join an unverified local account even from a trusted provider", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS, trusted: true });
		await mounted.auth.connection.query(
			`INSERT INTO ${mounted.auth.schema}.user (email) VALUES ($1)`,
			["signed.in@example.com"],
		);
		const refused = await mounted.auth.handler(callbackRequest(await start(mounted)));

		expect(refused.status).toBe(400);
		expect(await countRows(mounted, "identity")).toBe(0);
		expect(await countRows(mounted, "user")).toBe(1);
	});

	it("joins a verified local account from a trusted provider", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS, trusted: true });
		await mounted.auth.connection.query(
			`INSERT INTO ${mounted.auth.schema}.user (email, email_verified_at) VALUES ($1, now())`,
			["signed.in@example.com"],
		);
		const response = await mounted.auth.handler(callbackRequest(await start(mounted)));

		expect(response.status).toBe(302);
		expect(await countRows(mounted, "user")).toBe(1);
		expect(await countRows(mounted, "identity")).toBe(1);
	});

	it("refuses to join a verified local account from a provider that is not trusted", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS });
		await mounted.auth.connection.query(
			`INSERT INTO ${mounted.auth.schema}.user (email, email_verified_at) VALUES ($1, now())`,
			["signed.in@example.com"],
		);
		const refused = await mounted.auth.handler(callbackRequest(await start(mounted)));

		expect(refused.status).toBe(400);
		expect(await countRows(mounted, "identity")).toBe(0);
	});
});

describe("S-LINK-1 and S-LINK-6: the pair is the key and the flag is per identity", () => {
	/**
	 * What this case measured before E-577: it built a second stub, never configured it, and
	 * asserted it had not been called — an assertion no tree can fail. Two configured providers
	 * on one address are exercised in `oauth-linking-matrix.test.ts`; what is left here is the
	 * row this sign-in actually wrote.
	 */
	it("writes the subject and the provider's verification state onto the identity", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS, trusted: true });
		await mounted.auth.handler(callbackRequest(await start(mounted)));
		const [identity] = await mounted.auth.connection.query<{
			provider: string;
			subject: string;
			provider_email_verified: boolean;
		}>(
			`SELECT provider, subject, provider_email_verified FROM ${mounted.auth.schema}.identity`,
			[],
		);

		expect(identity?.provider).toBe("stubby");
		expect(identity?.subject).toBe("provider-subject-1");
		expect(identity?.provider_email_verified).toBe(true);
	});

	it("never writes the address into the subject", async () => {
		const mounted = await mountWith({
			claims: { sub: "not-an-address", email: "someone@example.com", email_verified: true },
		});
		await mounted.auth.handler(callbackRequest(await start(mounted)));
		const [row] = await mounted.auth.connection.query<{ subject: string }>(
			`SELECT subject FROM ${mounted.auth.schema}.identity`,
			[],
		);

		expect(row?.subject).toBe("not-an-address");
	});
});

describe("S-LINK-5: no address is invented", () => {
	it("refuses the account rather than making an address up", async () => {
		const mounted = await mountWith({ claims: { sub: "no-address-at-all" } });
		const refused = await mounted.auth.handler(callbackRequest(await start(mounted)));

		expect(refused.status).toBe(502);
		expect(await countRows(mounted, "user")).toBe(0);
		expect(await countRows(mounted, "identity")).toBe(0);
	});
});

describe("S-LINK-2, condition one: the verified flag is a boolean", () => {
	/**
	 * `"true"` and `1` were accepted once, from memory of provider payloads rather than from any
	 * clause; OpenID Connect Core §5.1 makes the claim a boolean. It is the first of the three
	 * conditions, so the wide reading was the condition read widely (E-579).
	 */
	it("stores the flag as false when the provider spells it as a string", async () => {
		const mounted = await mountWith({
			claims: { sub: "string-flag", email: "string.flag@example.com", email_verified: "true" },
			trusted: true,
		});
		await mounted.auth.handler(callbackRequest(await start(mounted)));
		const [identity] = await mounted.auth.connection.query<{ provider_email_verified: boolean }>(
			`SELECT provider_email_verified FROM ${mounted.auth.schema}.identity`,
			[],
		);
		const [user] = await mounted.auth.connection.query<{ email_verified_at: Date | null }>(
			`SELECT email_verified_at FROM ${mounted.auth.schema}.user`,
			[],
		);

		expect(identity?.provider_email_verified).toBe(false);
		expect(user?.email_verified_at).toBeNull();
	});

	it("joins no verified account when the provider spells the flag as a number", async () => {
		const mounted = await mountWith({
			claims: { sub: "number-flag", email: "number.flag@example.com", email_verified: 1 },
			trusted: true,
		});
		await mounted.auth.connection.query(
			`INSERT INTO ${mounted.auth.schema}.user (email, email_verified_at) VALUES ($1, now())`,
			["number.flag@example.com"],
		);
		const refused = await mounted.auth.handler(callbackRequest(await start(mounted)));

		expect(refused.status).toBe(400);
		expect(await countRows(mounted, "identity")).toBe(0);
		expect(await countRows(mounted, "user")).toBe(1);
	});
});

describe("section 1 C61: a redirecting token endpoint is refused, not followed", () => {
	it("answers 502 and writes nothing when the token endpoint answers 3xx", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS });
		mounted.provider.answerTokenEndpointWithARedirect();
		const answered = await mounted.auth.handler(callbackRequest(await start(mounted)));

		expect(answered.status).toBe(502);
		expect(await countRows(mounted, "identity")).toBe(0);
		expect(await countRows(mounted, "session")).toBe(0);
	});

	it("asks its own fetch not to follow one, and refuses a 3xx in its own text", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS });
		await mounted.auth.handler(callbackRequest(await start(mounted)));
		const outbound = readFileSync(
			fileURLToPath(new URL("../src/core/oauth/outbound.ts", import.meta.url)),
			"utf8",
		);

		expect(mounted.provider.redirectModes.length).toBeGreaterThan(0);
		expect(mounted.provider.redirectModes.filter((mode) => mode !== "manual")).toStrictEqual([]);
		// The behavioural half above cannot see the guard go, because `!response.ok` refuses a 3xx
		// as well; and reading the source for the name alone passed with the call deleted and the
		// function left standing, which a plant found. It is the call site that is read (E-584).
		expect(outbound).toContain("return assertNotARedirect(");
		expect(outbound).toContain('redirect: "manual"');
	});
});

describe("S-REST-6 and S-REST-4: provider tokens", () => {
	it("stores none of the three by default", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS });
		await mounted.auth.handler(callbackRequest(await start(mounted)));
		const [row] = await mounted.auth.connection.query<{
			access_token_enc: Uint8Array | null;
			refresh_token_enc: Uint8Array | null;
			id_token_enc: Uint8Array | null;
			token_key_version: number | null;
		}>(
			`SELECT access_token_enc, refresh_token_enc, id_token_enc, token_key_version
			 FROM ${mounted.auth.schema}.identity`,
			[],
		);

		expect(row?.access_token_enc).toBeNull();
		expect(row?.refresh_token_enc).toBeNull();
		expect(row?.id_token_enc).toBeNull();
		expect(row?.token_key_version).toBeNull();
	});

	it("encrypts them where the application asked for them", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS, storeTokens: true });
		await mounted.auth.handler(callbackRequest(await start(mounted)));
		const [row] = await mounted.auth.connection.query<{
			access_token_enc: Uint8Array | null;
			token_key_version: number | null;
		}>(`SELECT access_token_enc, token_key_version FROM ${mounted.auth.schema}.identity`, []);
		const stored = new TextDecoder().decode(Uint8Array.from(row?.access_token_enc ?? []));

		expect(row?.token_key_version).toBe(1);
		expect(stored).not.toContain("provider-access-token");
	});
});

describe("S-KEY-7: the ID token is verified against the JWKS", () => {
	it("names asymmetric algorithms only", () => {
		expect(ID_TOKEN_SIGNATURE_ALGORITHMS).not.toContain("none");
		expect(ID_TOKEN_SIGNATURE_ALGORITHMS.filter((name) => name.startsWith("HS"))).toStrictEqual([]);
		expect(ID_TOKEN_SIGNATURE_ALGORITHMS).toContain("RS256");
	});

	it("accepts the signed token and refuses `none`, HS256 and a foreign key", async () => {
		const mounted = await mountWith({
			claims: VERIFIED_CLAIMS,
			openIdConnect: true,
			trusted: true,
		});
		const accepted = await mounted.auth.handler(callbackRequest(await start(mounted)));

		const refusals: number[] = [];
		for (const forged of [
			{ algorithm: "none" },
			{ algorithm: "HS256" },
			{ foreignKey: true },
		] as const) {
			const flow = await start(mounted);
			mounted.provider.replaceIdToken(
				await mounted.provider.signIdToken({
					claims: VERIFIED_CLAIMS,
					nonce: flow.nonce ?? "",
					...forged,
				}),
			);
			refusals.push((await mounted.auth.handler(callbackRequest(flow))).status);
			mounted.provider.replaceIdToken(null);
		}

		expect(accepted.status).toBe(302);
		expect(refusals).toStrictEqual([400, 400, 400]);
	});

	it("refuses an ID token whose nonce is not the one this flow minted", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS, openIdConnect: true });
		const flow = await start(mounted);
		mounted.provider.replaceIdToken(
			await mounted.provider.signIdToken({ claims: VERIFIED_CLAIMS, nonce: "a-nonce-of-my-own" }),
		);
		const refused = await mounted.auth.handler(callbackRequest(flow));

		expect(flow.nonce).not.toBeNull();
		expect(refused.status).toBe(400);
		expect(await countRows(mounted, "session")).toBe(0);
	});
});

describe("RFC 9207 where the issuer is the tenant's (section 1 C60)", () => {
	function callbackCarrying(flow: StartedFlow, iss: string): Request {
		return requestTo(
			`/sign-in/oauth/callback/stubby?code=${codeCarrying(flow.nonce)}&state=${encodeURIComponent(flow.state)}&iss=${encodeURIComponent(iss)}`,
			{ method: "GET", cookie: `__Host-velve_oauth_state=${flow.pointer}` },
		);
	}

	it("lets the signed token answer for the `iss` a provider without one cannot", async () => {
		const mounted = await mountWith({
			claims: VERIFIED_CLAIMS,
			openIdConnect: true,
			omitIssuer: true,
		});
		const answered = await mounted.auth.handler(
			callbackCarrying(await start(mounted), "https://provider.example"),
		);

		expect(answered.status).toBe(302);
		expect(await countRows(mounted, "identity")).toBe(1);
	});

	it("refuses an `iss` the signed token does not carry", async () => {
		const mounted = await mountWith({
			claims: VERIFIED_CLAIMS,
			openIdConnect: true,
			omitIssuer: true,
		});
		const refused = await mounted.auth.handler(
			callbackCarrying(await start(mounted), "https://another-tenant.example"),
		);

		expect(refused.status).toBe(400);
		expect(await countRows(mounted, "identity")).toBe(0);
	});
});

describe("linking inside a session (3.15 B.7, S-LINK-7)", () => {
	it("links the identity and re-issues the session", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS });
		const signedIn = await mounted.auth.handler(callbackRequest(await start(mounted)));
		const firstSession = sessionCookieOf(signedIn) ?? "";

		mounted.provider.reportClaims({ sub: "a-second-subject", email: "second@example.com" });
		const linkFlow = await startLink(mounted, firstSession);
		const linked = await mounted.auth.handler(callbackRequest(linkFlow, { cookie: firstSession }));

		expect(linked.status).toBe(302);
		expect(sessionCookieOf(linked)).not.toBe(firstSession);
		expect(await countRows(mounted, "session")).toBe(1);
		expect(await countRows(mounted, "identity")).toBe(2);
		expect(await countRows(mounted, "user")).toBe(1);
	});

	/**
	 * S-LINK-7 over the flow the second exempt route exists for. A `form_post` provider posts the
	 * callback cross-site, so the `SameSite=Lax` session cookie is not sent — the same sentence
	 * `cookies.ts` uses to give the state pointer `SameSite=None`. The account whose session is
	 * replaced therefore comes from the flow row, not from the callback's cookie (E-582).
	 */
	it("replaces the session when the linking callback carries no session cookie", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS, responseMode: "form_post" });
		const signedIn = await mounted.auth.handler(callbackRequest(await start(mounted)));
		const firstSession = sessionCookieOf(signedIn) ?? "";

		mounted.provider.reportClaims({ sub: "linked-by-form-post", email: "second@example.com" });
		const linkFlow = await startLink(mounted, firstSession);
		const linked = await mounted.auth.handler(
			new Request("https://api.example.com/sign-in/oauth/callback/stubby", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Cookie: `__Host-velve_oauth_state=${linkFlow.pointer}`,
				},
				body: new URLSearchParams({ code: codeCarrying(null), state: linkFlow.state }),
			}),
		);
		const replaced = sessionCookieOf(linked) ?? "";
		const oldSession = await mounted.auth.handler(
			requestTo("/session", { method: "GET", cookie: firstSession }),
		);

		expect(linked.status).toBe(302);
		expect(replaced).not.toBe(firstSession);
		expect(await countRows(mounted, "session")).toBe(1);
		expect(await oldSession.json()).toBeNull();
	});

	/** The same hole in a `sessionSameSite: "strict"` installation, where even the GET carries no cookie. */
	it("replaces the session when the redirect callback carries no session cookie", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS });
		const signedIn = await mounted.auth.handler(callbackRequest(await start(mounted)));
		const firstSession = sessionCookieOf(signedIn) ?? "";

		mounted.provider.reportClaims({ sub: "linked-without-cookie", email: "third@example.com" });
		const linkFlow = await startLink(mounted, firstSession);
		const linked = await mounted.auth.handler(callbackRequest(linkFlow));

		expect(linked.status).toBe(302);
		expect(sessionCookieOf(linked)).not.toBe(firstSession);
		expect(await countRows(mounted, "session")).toBe(1);
	});

	/**
	 * The case the two above cannot see: both begin with one session, so neither tells replacing the
	 * one from revoking them all. `TRUST_LEVEL_EVENT_REVOKES_OTHER_SESSIONS` states
	 * `identity_linked: false` and S-FIX-6 names only the two credential changes; this is what says
	 * so in the database (E-588). The callback carries no session cookie, so the row that goes is
	 * named by `oauth_flow.link_from_session_id` and by nothing the request could carry.
	 */
	it("replaces the session the link began in and leaves the other device signed in", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS });
		const deviceA =
			sessionCookieOf(await mounted.auth.handler(callbackRequest(await start(mounted)))) ?? "";
		const deviceB =
			sessionCookieOf(await mounted.auth.handler(callbackRequest(await start(mounted)))) ?? "";
		expect(await countRows(mounted, "session")).toBe(2);

		mounted.provider.reportClaims({ sub: "linked-on-device-b", email: "second@example.com" });
		const linkFlow = await startLink(mounted, deviceB);
		const linked = await mounted.auth.handler(callbackRequest(linkFlow));

		const stillSignedIn = await mounted.auth.handler(
			requestTo("/session", { method: "GET", cookie: deviceA }),
		);
		const replaced = await mounted.auth.handler(
			requestTo("/session", { method: "GET", cookie: deviceB }),
		);

		expect(linked.status).toBe(302);
		expect(sessionCookieOf(linked)).not.toBe(deviceB);
		expect(await countRows(mounted, "session")).toBe(2);
		expect(await stillSignedIn.json()).not.toBeNull();
		expect(await replaced.json()).toBeNull();
	});

	/**
	 * 3.11 makes a hook a listener with a veto, and a veto at `beforeSessionCreate` must leave the
	 * account as it was: the removal of the old row and the insert of the new one are one
	 * transaction that the refusal never reaches (E-590).
	 */
	it("leaves the previous session standing when a plugin refuses the new one", async () => {
		registerPluginErrorCodes({ "linkguard.refused": { httpStatus: 409, message: "Refused." } });
		let refuseTheNextSession = false;
		const linkguard: VelvePlugin = {
			id: "linkguard",
			hooks: {
				beforeSessionCreate: () =>
					refuseTheNextSession
						? Promise.reject(new VelveError("linkguard.refused"))
						: Promise.resolve(),
			},
		};
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS, plugins: [linkguard] });
		const signedIn = await mounted.auth.handler(callbackRequest(await start(mounted)));
		const session = sessionCookieOf(signedIn) ?? "";

		refuseTheNextSession = true;
		mounted.provider.reportClaims({ sub: "refused-by-the-plugin", email: "second@example.com" });
		const linkFlow = await startLink(mounted, session);
		const refused = await mounted.auth.handler(callbackRequest(linkFlow));
		const survivor = await mounted.auth.handler(
			requestTo("/session", { method: "GET", cookie: session }),
		);

		expect(refused.status).toBe(409);
		expect(await refused.json()).toMatchObject({ error: { code: "linkguard.refused" } });
		expect(await countRows(mounted, "session")).toBe(1);
		expect(await survivor.json()).not.toBeNull();
	});

	/**
	 * A row carrying an account without the session it began in is not one `beginFlow` wrote. Refusing
	 * it is what keeps a link flow from quietly becoming a sign-in, which would run the automatic
	 * linking rule over an account the caller already proved nothing about (E-588).
	 */
	it("refuses a link flow whose row names no session", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS });
		const signedIn = await mounted.auth.handler(callbackRequest(await start(mounted)));
		const session = sessionCookieOf(signedIn) ?? "";

		mounted.provider.reportClaims({ sub: "a-row-nobody-wrote", email: "second@example.com" });
		const linkFlow = await startLink(mounted, session);
		await mounted.auth.connection.query(
			`UPDATE ${mounted.auth.schema}.oauth_flow SET link_from_session_id = NULL`,
			[],
		);
		const refused = await mounted.auth.handler(callbackRequest(linkFlow));

		expect(refused.status).toBe(400);
		expect(await refused.json()).toMatchObject({ error: { code: "oauth_flow_invalid" } });
		expect(await countRows(mounted, "identity")).toBe(1);
		expect(await countRows(mounted, "session")).toBe(1);
	});

	it("refuses to move an identity that belongs to another account", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS });
		await mounted.auth.handler(callbackRequest(await start(mounted)));

		mounted.provider.reportClaims({ sub: "the-other-account", email: "other@example.com" });
		const secondSignIn = await mounted.auth.handler(callbackRequest(await start(mounted)));
		const secondSession = sessionCookieOf(secondSignIn) ?? "";

		mounted.provider.reportClaims(VERIFIED_CLAIMS);
		const linkFlow = await startLink(mounted, secondSession);
		const refused = await mounted.auth.handler(
			callbackRequest(linkFlow, { cookie: secondSession }),
		);

		expect(refused.status).toBe(409);
		expect(await countRows(mounted, "identity")).toBe(2);
		expect(await countRows(mounted, "user")).toBe(2);
	});
});

describe("identity.list and identity.unlink (C89, L-13)", () => {
	/** Mounted with `storeTokens`, so there is a stored token for the listing to fail to withhold (E-583). */
	it("lists the identity without a token and refuses to remove the last way in", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS, storeTokens: true });
		const signedIn = await mounted.auth.handler(callbackRequest(await start(mounted)));
		const cookie = sessionCookieOf(signedIn) ?? "";

		const listed = await mounted.auth.handler(
			requestTo("/identity/list", { method: "GET", cookie, origin: TEST_ORIGIN }),
		);
		const identities = (await listed.json()) as { id: string; subject: string }[];
		const refused = await mounted.auth.handler(
			requestTo("/identity/unlink", { body: { identityId: identities[0]?.id }, cookie }),
		);

		expect(listed.status).toBe(200);
		expect(identities).toHaveLength(1);
		const [stored] = await mounted.auth.connection.query<{ present: number }>(
			`SELECT count(*)::int AS present FROM ${mounted.auth.schema}.identity
			 WHERE access_token_enc IS NOT NULL`,
			[],
		);

		expect(stored?.present).toBe(1);
		expect(JSON.stringify(identities)).not.toContain("provider-access-token");
		expect(JSON.stringify(identities)).not.toContain("provider-refresh-token");
		expect(refused.status).toBe(409);
		expect(await countRows(mounted, "identity")).toBe(1);
	});
});

describe("the form_post callback (section 1 C50, C70)", () => {
	it("takes the posted form and marks its pointer cross-site", async () => {
		const mounted = await mountWith({ claims: VERIFIED_CLAIMS, responseMode: "form_post" });
		const response = await mounted.auth.handler(
			requestTo("/sign-in/oauth/start", { body: { provider: "stubby" } }),
		);
		const written = response.headers.getSetCookie();
		const body = (await response.json()) as {
			authorizationUrl: string;
			stateCookie: { value: string; attributes: string };
		};
		const flow = new URL(body.authorizationUrl);

		const posted = new Request("https://api.example.com/sign-in/oauth/callback/stubby", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Cookie: `__Host-velve_oauth_state=${body.stateCookie.value}`,
			},
			body: new URLSearchParams({
				code: codeCarrying(null),
				state: flow.searchParams.get("state") ?? "",
				user: '{"name":{"firstName":"Ada"}}',
			}),
		});
		const answered = await mounted.auth.handler(posted);

		expect(flow.searchParams.get("response_mode")).toBe("form_post");
		expect(written.some((cookie) => cookie.includes("SameSite=None"))).toBe(true);
		expect(body.stateCookie.attributes).toBe("HttpOnly; Secure; SameSite=None; Path=/");
		expect(answered.status).toBe(302);
		expect(await countRows(mounted, "identity")).toBe(1);
	});
});
