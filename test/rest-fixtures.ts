import { createHash } from "node:crypto";
import type { EmailMessage } from "../src/core/auth/config.js";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { decryptWithPurposeKey } from "../src/core/keys/envelope.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { createPasswordCredentialRepository, openPhc } from "../src/core/password/credential.js";
import { MAXIMUM_STORED_MEMORY_KIB } from "../src/core/password/limits.js";
import {
	type MountedAuth,
	mountAuth,
	requestTo,
	TEST_ORIGIN,
	testKeyProvider,
} from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { codeCarrying, createStubProvider, oauthConfigFor } from "./oauth-provider.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";
import { createVirtualAuthenticator } from "./webauthn-simulator.js";

const REST_PASSWORD = "the password only the at-rest proof knows 4d9a";
const ADDRESS = "at.rest@example.com";
const RELYING_PARTY_ID = "app.example.com";

/** one secret the account's flows produced, under the name T-REST-1 gives it */
export interface Secret {
	readonly name: string;
	readonly value: string;
}

export interface ProviderTokens {
	readonly accessToken: string;
	readonly refreshToken: string;
	readonly idToken: string;
}

export interface DrivenUser {
	readonly mounted: MountedAuth;
	readonly keys: KeyProvider;
	readonly userId: string;
	/** the twenty-four values T-REST-1 counts, in its order */
	readonly secrets: readonly Secret[];
	/** further secrets the flows produced that T-REST-1 does not count */
	readonly beyondTheCount: readonly Secret[];
	readonly totpSecretBase32: string;
	readonly openFlow: { readonly state: string; readonly codeChallenge: string };
	readonly providerTokens: ProviderTokens;
	close(): Promise<void>;
}

class Cookies {
	private readonly jar = new Map<string, string>();

	take(answer: Response): Response {
		for (const line of answer.headers.getSetCookie()) {
			const pair = line.split(";")[0] ?? "";
			const separator = pair.indexOf("=");
			const value = pair.slice(separator + 1);
			if (value === "") {
				this.jar.delete(pair.slice(0, separator));
			} else {
				this.jar.set(pair.slice(0, separator), value);
			}
		}
		return answer;
	}

	value(name: string): string {
		const value = this.jar.get(name);
		if (value === undefined) {
			throw new Error(`no ${name} cookie was set`);
		}
		return value;
	}

	header(...extra: readonly string[]): string {
		return [...[...this.jar].map(([name, value]) => `${name}=${value}`), ...extra].join("; ");
	}
}

function tokenSent(mounted: MountedAuth, kind: EmailMessage["kind"]): string {
	const message = mounted.email.messages.filter((each) => each.kind === kind).at(-1);
	if (message === undefined || !("token" in message)) {
		throw new Error(`no ${kind} message with a token was sent`);
	}
	return message.token;
}

async function ok(answer: Promise<Response>, what: string): Promise<Response> {
	const settled = await answer;
	if (settled.status >= 400) {
		throw new Error(`${what} answered ${settled.status}: ${await settled.clone().text()}`);
	}
	return settled;
}

//the token endpoint's answer is the one place the three provider tokens are seen in the clear
function recordingTokens(fetch: typeof globalThis.fetch): {
	fetch: typeof globalThis.fetch;
	issued: () => ProviderTokens;
} {
	let issued: ProviderTokens | null = null;
	return {
		fetch: async (input, init) => {
			const answer = await fetch(input, init);
			if (String(input).endsWith("/token") && answer.ok) {
				const body = (await answer.clone().json()) as Record<string, string>;
				issued = {
					accessToken: body.access_token ?? "",
					refreshToken: body.refresh_token ?? "",
					idToken: body.id_token ?? "",
				};
			}
			return answer;
		},
		issued: () => {
			if (issued === null) {
				throw new Error("the token endpoint was never answered");
			}
			return issued;
		},
	};
}

async function oauthStart(
	mounted: MountedAuth,
	path: string,
	cookie: string | undefined,
): Promise<{ pointer: string; state: string; nonce: string | null; challenge: string }> {
	const answer = await ok(
		mounted.handler(
			requestTo(path, {
				body: { provider: "stubby" },
				...(cookie === undefined ? {} : { cookie }),
			}),
		),
		path,
	);
	const body = (await answer.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const url = new URL(body.authorizationUrl);
	return {
		pointer: body.stateCookie.value,
		state: url.searchParams.get("state") ?? "",
		nonce: url.searchParams.get("nonce"),
		challenge: url.searchParams.get("code_challenge") ?? "",
	};
}

async function openFlowVerifier(mounted: MountedAuth, keys: KeyProvider, state: string) {
	const [row] = await mounted.connection.query<{
		pkce_verifier_enc: Uint8Array<ArrayBuffer>;
		key_version: number;
	}>(
		`SELECT pkce_verifier_enc, key_version FROM ${mounted.schema}.oauth_flow WHERE state_sha256 = $1`,
		[createHash("sha256").update(state, "utf8").digest()],
	);
	if (row === undefined) {
		throw new Error("the open OAuth flow left no row");
	}
	const verifier = await decryptWithPurposeKey(
		keys,
		"pkce-enc",
		row.key_version,
		row.pkce_verifier_enc,
	);
	return Buffer.from(verifier).toString("utf8");
}

/** one account driven over HTTP through every flow that leaves a secret at rest */
export async function driveOneUserThroughEveryFlow(prefix: string): Promise<DrivenUser> {
	const keys = testKeyProvider();
	const provider = await createStubProvider({
		claims: { sub: "at-rest-subject", email: ADDRESS, email_verified: true },
		openIdConnect: true,
		accessToken: `access-${createHash("sha256").update(prefix).digest("hex")}`,
		refreshToken: `refresh-${createHash("sha256").update(`${prefix}r`).digest("hex")}`,
	});
	const recorded = recordingTokens(provider.fetch);
	const mounted = await mountAuth(prefix, {
		keys,
		webauthn: {
			relyingPartyId: RELYING_PARTY_ID,
			relyingPartyName: "Velve Auth tests",
			origins: [TEST_ORIGIN],
			userVerification: "required",
		},
		recoveryCodes: { count: 10, groupSize: 5 },
		oauth: oauthConfigFor({ openIdConnect: true, storeTokens: true }),
		fetch: recorded.fetch,
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
	});
	const cookies = new Cookies();
	const post = async (path: string, body: unknown): Promise<Response> =>
		cookies.take(
			await ok(mounted.handler(requestTo(path, { body, cookie: cookies.header() })), path),
		);

	await post("/sign-up", { email: ADDRESS, password: REST_PASSWORD });
	const [user] = await mounted.connection.query<{ id: string }>(
		`SELECT id FROM ${mounted.schema}.user WHERE email = $1`,
		[ADDRESS],
	);
	const userId = user?.id ?? "";

	const enrolment = (await (await post("/factor/totp/enroll/start", {})).json()) as {
		secretBase32: string;
	};
	const code = totpCodeForStep(secretBytesOfBase32(enrolment.secretBase32), timeStepAt(new Date()));
	await post("/factor/totp/enroll/finish", { code });

	const { codes } = (await (await post("/factor/recovery/generate", {})).json()) as {
		codes: string[];
	};

	const authenticator = await createVirtualAuthenticator({
		relyingPartyId: RELYING_PARTY_ID,
		origin: TEST_ORIGIN,
		flags: { userVerified: true, backupEligible: true, backupState: true },
	});
	const registration = (await (await post("/factor/webauthn/register/start", {})).json()) as {
		challengeToken: string;
	};
	await post("/factor/webauthn/register/finish", {
		challengeToken: registration.challengeToken,
		response: await authenticator.attest({ challenge: registration.challengeToken }),
		label: "the at-rest key",
	});
	const openChallenge = (await (await post("/factor/webauthn/register/start", {})).json()) as {
		challengeToken: string;
	};

	const link = await oauthStart(mounted, "/identity/link/start", cookies.header());
	cookies.take(
		await ok(
			mounted.handler(
				requestTo(
					`/sign-in/oauth/callback/stubby?code=${codeCarrying(link.nonce)}&state=${encodeURIComponent(link.state)}`,
					{
						method: "GET",
						cookie: cookies.header(`${DEFAULT_COOKIE_NAMES.oauthState}=${link.pointer}`),
					},
				),
			),
			"the link callback",
		),
	);
	const open = await oauthStart(mounted, "/sign-in/oauth/start", undefined);

	await post("/password/request-reset", { email: ADDRESS });
	await post("/sign-in/magic-link/request", { email: ADDRESS });
	await post("/email/request-change", { newEmail: "changed.at.rest@example.com" });
	const sessionToken = cookies.value(DEFAULT_COOKIE_NAMES.session);

	//over HTTP the pending token travels only in its cookie
	const pendingJar = new Cookies();
	const signIn = pendingJar.take(
		await ok(
			mounted.handler(
				requestTo("/sign-in/password", { body: { email: ADDRESS, password: REST_PASSWORD } }),
			),
			"the second sign-in",
		),
	);
	const { status } = (await signIn.json()) as { status: string };
	if (status !== "second_factor_required") {
		throw new Error(`the second sign-in did not stop at the second factor: ${status}`);
	}
	const pendingToken = pendingJar.value(DEFAULT_COOKIE_NAMES.pending);

	const stored = await createPasswordCredentialRepository({
		driver: mounted.connection,
		keys,
		schema: mounted.schema,
		memoryCeilingKiB: MAXIMUM_STORED_MEMORY_KIB,
	}).findByUserId(userId);
	if (stored === null) {
		throw new Error("the password credential is gone");
	}
	const tokens = recorded.issued();

	return {
		mounted,
		keys,
		userId,
		totpSecretBase32: enrolment.secretBase32,
		openFlow: { state: open.state, codeChallenge: open.challenge },
		providerTokens: tokens,
		secrets: [
			{ name: "password", value: REST_PASSWORD },
			{ name: "password hash (PHC)", value: await openPhc(keys, stored) },
			{ name: "session token", value: sessionToken },
			{ name: "pending token", value: pendingToken },
			{ name: "one-time token (email_verify)", value: tokenSent(mounted, "email_verification") },
			{ name: "one-time token (password_reset)", value: tokenSent(mounted, "password_reset") },
			{ name: "one-time token (email_change)", value: tokenSent(mounted, "email_change") },
			{ name: "one-time token (magic_link)", value: tokenSent(mounted, "magic_link") },
			{ name: "TOTP secret", value: enrolment.secretBase32 },
			...codes.map((value, index) => ({ name: `recovery code ${index + 1}`, value })),
			{ name: "WebAuthn challenge", value: openChallenge.challengeToken },
			{ name: "OAuth state", value: open.state },
			{ name: "PKCE verifier", value: await openFlowVerifier(mounted, keys, open.state) },
			{ name: "provider access token", value: tokens.accessToken },
			{ name: "provider refresh token", value: tokens.refreshToken },
		],
		beyondTheCount: [
			{ name: "provider ID token", value: tokens.idToken },
			{ name: "OAuth state pointer of the open flow", value: open.pointer },
			{ name: "OAuth state of the completed link", value: link.state },
		],
		async close() {
			await dropSchema(mounted.connection, mounted.schema);
			await mounted.connection.close();
		},
	};
}
