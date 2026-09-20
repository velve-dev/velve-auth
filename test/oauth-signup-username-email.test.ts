import { afterEach, describe, expect, it } from "vitest";
import type { OAuthConfig } from "../src/core/oauth/config.js";
import { type MountedAuth, mountAuthInMode, requestTo } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import {
	CALLBACK_BASE_URL,
	codeCarrying,
	createStubProvider,
	type ProviderClaims,
	type StubProvider,
} from "./oauth-provider.js";

const PROVIDER_ORIGIN = "https://provider.example";
const PROVIDER = "stubby";

const mounted: MountedAuth<"username_email">[] = [];

afterEach(async () => {
	for (const instance of mounted.splice(0)) {
		await dropSchema(instance.connection, instance.schema);
		await instance.connection.close();
	}
});

type Contribute = OAuthConfig["identifiersForNewAccount"];

function configWith(emailClaim: string | undefined, contribute?: Contribute): OAuthConfig {
	return {
		providers: {
			[PROVIDER]: {
				clientId: "velve-test-client",
				clientSecret: "client-secret",
				authorizationEndpoint: `${PROVIDER_ORIGIN}/authorize`,
				tokenEndpoint: `${PROVIDER_ORIGIN}/token`,
				userInfoEndpoint: `${PROVIDER_ORIGIN}/userinfo`,
				subjectClaim: "sub",
				...(emailClaim === undefined ? {} : { emailClaim, emailVerifiedClaim: "email_verified" }),
			},
		},
		callbackBaseUrl: CALLBACK_BASE_URL,
		trustedProviders: [PROVIDER],
		...(contribute === undefined ? {} : { identifiersForNewAccount: contribute }),
	} as unknown as OAuthConfig;
}

async function mountWith(input: {
	readonly claims: ProviderClaims;
	readonly emailClaim: string | undefined;
	readonly contribute?: Contribute;
}): Promise<{ auth: MountedAuth<"username_email">; provider: StubProvider }> {
	const provider = await createStubProvider({ claims: input.claims });
	const auth = await mountAuthInMode<"username_email">(
		"oauthsignup",
		{ mode: "username_email", username: { minimumLength: 3, maximumLength: 32 } },
		{ oauth: configWith(input.emailClaim, input.contribute), fetch: provider.fetch },
	);
	mounted.push(auth);
	return { auth, provider };
}

async function signInThrough(auth: MountedAuth<"username_email">): Promise<Response> {
	const started = await auth.handler(
		requestTo("/sign-in/oauth/start", { body: { provider: PROVIDER } }),
	);
	const body = (await started.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const url = new URL(body.authorizationUrl);
	const state = url.searchParams.get("state") ?? "";
	const code = codeCarrying(url.searchParams.get("nonce"));
	return auth.handler(
		requestTo(
			`/sign-in/oauth/callback/${PROVIDER}?code=${code}&state=${encodeURIComponent(state)}`,
			{ method: "GET", cookie: `__Host-velve_oauth_state=${body.stateCookie.value}` },
		),
	);
}

async function usernameOf(auth: MountedAuth<"username_email">): Promise<string | null> {
	const rows = await auth.connection.query<{ username: string | null }>(
		`SELECT username FROM ${auth.schema}.user LIMIT 1`,
		[],
	);
	return rows[0]?.username ?? null;
}

async function accountCount(auth: MountedAuth<"username_email">): Promise<number> {
	const rows = await auth.connection.query<{ count: string }>(
		`SELECT count(*)::text AS count FROM ${auth.schema}.user`,
		[],
	);
	return Number(rows[0]?.count ?? "0");
}

const CLAIMS: ProviderClaims = {
	sub: "provider-subject-1",
	email: "newcomer@example.com",
	email_verified: true,
	preferred_username: "newcomer",
};

/**
 * In `username_email` a person who does not yet exist cannot be created through a provider:
 * `createAccountFor` passes only the address to `identityColumns`, and `resolveUsernameColumns`
 * rejects a missing username as `required` before it ever looks at `identity.username` — so
 * configuring a username policy does not help and the failure is not a misconfiguration.
 */
describe("a provider sign-in creates an account in username_email", () => {
	it("creates the account with the username the application supplied", async () => {
		const { auth } = await mountWith({
			claims: CLAIMS,
			emailClaim: "email",
			contribute: ({ account }) => ({ username: String(account.claims.preferred_username) }),
		});

		const answer = await signInThrough(auth);

		expect(answer.status).toBeLessThan(400);
		expect(await accountCount(auth)).toBe(1);
		expect(await usernameOf(auth)).toBe("newcomer");
	});

	/** The application is told which provider it is naming for, and sees the whole claim set. */
	it("hands the application the provider id and the provider's claims", async () => {
		const seen: unknown[] = [];
		const { auth } = await mountWith({
			claims: CLAIMS,
			emailClaim: "email",
			contribute: (input) => {
				seen.push({ provider: input.provider, subject: input.account.subject });
				return { username: "fromtheapplication" };
			},
		});

		await signInThrough(auth);

		expect(seen).toStrictEqual([{ provider: PROVIDER, subject: "provider-subject-1" }]);
		expect(await usernameOf(auth)).toBe("fromtheapplication");
	});

	/** It may be asynchronous, because naming an account means asking the application's own tables
	 * whether the name is free. */
	it("waits for an asynchronous answer", async () => {
		const { auth } = await mountWith({
			claims: CLAIMS,
			emailClaim: "email",
			contribute: async () => {
				await Promise.resolve();
				return { username: "afterawait" };
			},
		});

		expect((await signInThrough(auth)).status).toBeLessThan(400);
		expect(await usernameOf(auth)).toBe("afterawait");
	});

	/**
	 * The contributed value goes through `normaliseUsername`, which is what makes the seam a
	 * contribution rather than a bypass. Asserted on the folded key rather than on a refusal,
	 * because a refused contribution and an absent one are the same `oauth_flow_invalid` from
	 * outside and the case below cannot tell them apart (E-1902).
	 */
	it("normalises what the application contributed, as it would a typed username", async () => {
		const { auth } = await mountWith({
			claims: CLAIMS,
			emailClaim: "email",
			contribute: () => ({ username: "NewComer" }),
		});

		expect((await signInThrough(auth)).status).toBeLessThan(400);
		const [row] = await auth.connection.query<{ username: string; username_key: string }>(
			`SELECT username, username_key FROM ${auth.schema}.user LIMIT 1`,
			[],
		);
		expect(row?.username).toBe("NewComer");
		expect(row?.username_key).toBe("newcomer");
	});

	/** What comes back is held to the same policy as a username typed into a form: the seam
	 * contributes a value, it does not bypass the rules that value has to meet. */
	it("refuses a contributed username the policy rejects, and creates nothing", async () => {
		const { auth } = await mountWith({
			claims: CLAIMS,
			emailClaim: "email",
			contribute: () => ({ username: "ab" }),
		});

		expect((await signInThrough(auth)).status).toBeGreaterThanOrEqual(400);
		expect(await accountCount(auth)).toBe(0);
	});

	/** The counter-case the report asks for: supply nothing and the refusal is exactly what it was
	 * before this seam existed — no clearer, and nothing invented. */
	it("leaves the refusal unchanged when the application supplies nothing", async () => {
		const silent = await mountWith({ claims: CLAIMS, emailClaim: "email" });
		const empty = await mountWith({ claims: CLAIMS, emailClaim: "email", contribute: () => ({}) });

		for (const mount of [silent, empty]) {
			const answer = await signInThrough(mount.auth);
			expect(answer.status).toBeGreaterThanOrEqual(400);
			expect(await answer.clone().text()).toContain("oauth_flow_invalid");
			expect(await accountCount(mount.auth)).toBe(0);
		}
	});

	/**
	 * The counter-check the report gives: with no `emailClaim` the address is absent and the
	 * rejection is the address's, so the failure reads `oauth_provider_error`. With it configured
	 * the address arrives and the rejection moves to the username — which is what identifies the
	 * username as the blocker rather than the address.
	 */
	it("blames the username and not the address once the address is configured", async () => {
		const withoutAddress = await mountWith({ claims: CLAIMS, emailClaim: undefined });
		const withAddress = await mountWith({ claims: CLAIMS, emailClaim: "email" });

		const [absent, present] = await Promise.all([
			signInThrough(withoutAddress.auth).then((answer) => answer.clone().text()),
			signInThrough(withAddress.auth).then((answer) => answer.clone().text()),
		]);

		expect(absent).toContain("oauth_provider_error");
		expect(present).toContain("oauth_flow_invalid");
	});
});
