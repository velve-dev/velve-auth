import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rebindEnvelopesOfAccount } from "../src/core/auth/account-envelopes.js";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { decryptBound, rowOfParts } from "../src/core/keys/envelope-binding.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { createOAuthIdentityRepository } from "../src/core/oauth/identity-repository.js";
import type { VelvePlugin } from "../src/core/plugin/config.js";
import { createVelveAuth, registerPluginErrorCodes, VelveError } from "../src/index.js";
import { configFor, requestTo } from "./auth-fixtures.js";
import { actorOfTestUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import {
	codeCarrying,
	createStubProvider,
	oauthConfigFor,
	type StubProvider,
} from "./oauth-provider.js";
import { testKeyRing } from "./totp-fixtures.js";

/**
 * Attacks a database writer without the root key tries against the envelopes and the rows they are
 * bound to, every one expected to be refused (S-INTEG-1).
 */

const PASSWORD = "a password long enough for the policy 7c1e";
const ring = testKeyRing(2);
const v1 = ring.providerAt(1, [1]);
const v2Only = ring.providerAt(2, [2]);

type Handler = (request: Request) => Promise<Response>;

let connection: TestConnection;
let schema: string;
let provider: StubProvider;
let counter = 0;

function instance(keys: KeyProvider, overrides: Partial<VelveAuthConfig<"email">> = {}): Handler {
	return toWebHandler(
		createVelveAuth(
			configFor({
				database: connection,
				schema,
				keys,
				oauth: oauthConfigFor({ openIdConnect: true, storeTokens: true }),
				fetch: provider.fetch,
				rateLimit: {
					perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
					perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
				},
				...overrides,
			}),
		),
	);
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("integ_attacks");
	connection = migrated.connection;
	schema = migrated.schema;
	provider = await createStubProvider({ claims: { sub: "nobody" }, openIdConnect: true });
}, 60_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function cookieOf(answer: Response, name: string): string | null {
	for (const line of answer.headers.getSetCookie()) {
		const [pair = ""] = line.split(";");
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === name && pair.slice(separator + 1) !== "") {
			return pair.slice(separator + 1);
		}
	}
	return null;
}

async function signUp(on: Handler): Promise<{ email: string; userId: string }> {
	counter += 1;
	const email = `attack${counter}-${randomBytes(3).toString("hex")}@example.com`;
	expect((await on(requestTo("/sign-up", { body: { email, password: PASSWORD } }))).status).toBe(
		200,
	);
	const [row] = await connection.query<{ id: string }>(
		`SELECT id FROM ${schema}.user WHERE email = $1`,
		[email],
	);
	return { email, userId: row?.id ?? "" };
}

async function signIn(on: Handler, email: string): Promise<Response> {
	return on(requestTo("/sign-in/password", { body: { email, password: PASSWORD } }));
}

async function answerOf(answer: Response): Promise<{ status: number; code: string | null }> {
	const body = (await answer.json().catch(() => ({}))) as { error?: { code: string } };
	return { status: answer.status, code: body.error?.code ?? null };
}

function stateHashOf(state: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(createHash("sha256").update(state, "utf8").digest());
}

async function startLink(on: Handler, sessionCookie: string) {
	const answer = await on(
		requestTo("/identity/link/start", { body: { provider: "stubby" }, cookie: sessionCookie }),
	);
	expect(answer.status, await answer.clone().text()).toBe(200);
	const body = (await answer.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	const url = new URL(body.authorizationUrl);
	return {
		state: url.searchParams.get("state") ?? "",
		pointer: body.stateCookie.value,
		nonce: url.searchParams.get("nonce"),
	};
}

function callback(
	on: Handler,
	flow: { state: string; pointer: string; nonce: string | null },
	cookie?: string,
) {
	return on(
		requestTo(
			`/sign-in/oauth/callback/stubby?code=${codeCarrying(flow.nonce)}&state=${encodeURIComponent(flow.state)}`,
			{
				method: "GET",
				cookie: [`${DEFAULT_COOKIE_NAMES.oauthState}=${flow.pointer}`, cookie]
					.filter(Boolean)
					.join("; "),
			},
		),
	);
}

async function phcOf(userId: string) {
	const [row] = await connection.query<{ phc: Uint8Array; key_version: number }>(
		`SELECT phc, key_version FROM ${schema}.password_credential WHERE user_id = $1`,
		[userId],
	);
	return { keyVersion: row?.key_version ?? 0, ciphertext: Uint8Array.from(row?.phc ?? []) };
}

describe("a link flow retargeted by a database writer", () => {
	it("does not link the attacker's provider account to the victim when link_to is rewritten", async () => {
		const handler = instance(v1);
		const attacker = await signUp(handler);
		const victim = await signUp(handler);
		const attackerSession = cookieOf(
			await signIn(handler, attacker.email),
			DEFAULT_COOKIE_NAMES.session,
		);
		const victimSignIn = await signIn(handler, victim.email);
		expect(victimSignIn.status).toBe(200);
		const [victimSession] = await connection.query<{ id: string }>(
			`SELECT id FROM ${schema}.session WHERE user_id = $1 LIMIT 1`,
			[victim.userId],
		);
		const flow = await startLink(handler, `${DEFAULT_COOKIE_NAMES.session}=${attackerSession}`);
		const subject = `retarget-${randomBytes(4).toString("hex")}`;
		provider.reportClaims({
			sub: subject,
			email: `${subject}@provider.example`,
			email_verified: true,
		});

		await connection.query(
			`UPDATE ${schema}.oauth_flow SET link_to_user_id = $2, link_from_session_id = $3 WHERE state_sha256 = $1`,
			[stateHashOf(flow.state), victim.userId, victimSession?.id],
		);
		const answer = await callback(
			handler,
			flow,
			`${DEFAULT_COOKIE_NAMES.session}=${attackerSession}`,
		);

		expect(answer.status).toBeGreaterThanOrEqual(300);
		const linked = await connection.query(`SELECT 1 FROM ${schema}.identity WHERE subject = $1`, [
			subject,
		]);
		expect(linked).toHaveLength(0);
	});

	it("does not turn a link flow into a plain sign-in when link_to is set to NULL", async () => {
		const handler = instance(v1);
		const attacker = await signUp(handler);
		const session = cookieOf(await signIn(handler, attacker.email), DEFAULT_COOKIE_NAMES.session);
		const flow = await startLink(handler, `${DEFAULT_COOKIE_NAMES.session}=${session}`);
		const subject = `unlinked-${randomBytes(4).toString("hex")}`;
		provider.reportClaims({
			sub: subject,
			email: `${subject}@provider.example`,
			email_verified: true,
		});

		await connection.query(
			`UPDATE ${schema}.oauth_flow SET link_to_user_id = NULL, link_from_session_id = NULL WHERE state_sha256 = $1`,
			[stateHashOf(flow.state)],
		);
		const answer = await callback(handler, flow);

		expect(cookieOf(answer, DEFAULT_COOKIE_NAMES.session)).toBeNull();
		const linked = await connection.query(`SELECT 1 FROM ${schema}.identity WHERE subject = $1`, [
			subject,
		]);
		expect(linked).toHaveLength(0);
	});
});

//every column that steers a flow is part of the row its verifier is bound to (E-3123)
describe("a flow whose steering columns a database writer rewrote", () => {
	async function startSignIn(on: Handler) {
		const answer = await on(
			requestTo("/sign-in/oauth/start", {
				body: { provider: "stubby", redirectPath: "/welcome" },
			}),
		);
		expect(answer.status, await answer.clone().text()).toBe(200);
		const body = (await answer.json()) as {
			authorizationUrl: string;
			stateCookie: { value: string };
		};
		const url = new URL(body.authorizationUrl);
		return {
			state: url.searchParams.get("state") ?? "",
			pointer: body.stateCookie.value,
			nonce: url.searchParams.get("nonce"),
		};
	}

	function reportAFreshAccount(): void {
		const subject = `steer-${randomBytes(4).toString("hex")}`;
		provider.reportClaims({
			sub: subject,
			email: `${subject}@provider.example`,
			email_verified: true,
		});
	}

	it.each([
		["the nonce", "nonce = NULL"],
		["the redirect path", "redirect_path = '/elsewhere'"],
		["the provider", "provider = 'stubby2'"],
		["the deadline", "expires_at = now() + interval '30 days'"],
	])(
		"refuses the callback after %s was rewritten, as for an unknown state",
		async (_label, change) => {
			const handler = instance(v1);
			const flow = await startSignIn(handler);
			const control = await startSignIn(handler);
			reportAFreshAccount();
			const unknownState = await answerOf(
				await callback(handler, { state: "no-such-state", pointer: flow.pointer, nonce: null }),
			);

			await connection.query(`UPDATE ${schema}.oauth_flow SET ${change} WHERE state_sha256 = $1`, [
				stateHashOf(flow.state),
			]);
			const rewritten = await answerOf(await callback(handler, flow));

			expect(rewritten).toStrictEqual(unknownState);
			expect((await callback(handler, control)).status).toBeLessThan(400);
		},
	);

	it("refuses a link flow whose session to replace was rewritten", async () => {
		const handler = instance(v1);
		const account = await signUp(handler);
		const session = cookieOf(await signIn(handler, account.email), DEFAULT_COOKIE_NAMES.session);
		const second = await signIn(handler, account.email);
		expect(second.status).toBe(200);
		const flow = await startLink(handler, `${DEFAULT_COOKIE_NAMES.session}=${session}`);
		const [other] = await connection.query<{ id: string }>(
			`SELECT id FROM ${schema}.session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
			[account.userId],
		);
		reportAFreshAccount();

		await connection.query(
			`UPDATE ${schema}.oauth_flow SET link_from_session_id = $2 WHERE state_sha256 = $1`,
			[stateHashOf(flow.state), other?.id],
		);
		const answer = await callback(handler, flow, `${DEFAULT_COOKIE_NAMES.session}=${session}`);

		expect(answer.status).toBeGreaterThanOrEqual(300);
		expect(
			answer.headers
				.getSetCookie()
				.some(
					(line) =>
						line.startsWith(`${DEFAULT_COOKIE_NAMES.session}=`) &&
						!line.startsWith(`${DEFAULT_COOKIE_NAMES.session}=;`),
				),
		).toBe(false);
	});
});

//no column of a flow row is acted on before its verifier proves the row (E-3128)
describe("a link flow whose link_to_user_id a writer set to NULL", () => {
	const fired: string[] = [];
	let veto = false;
	let hooked: Handler;
	const spy: VelvePlugin = {
		id: "spy",
		hooks: {
			beforeSignIn: () => {
				fired.push("beforeSignIn");
				return veto ? Promise.reject(new VelveError("spy.refused")) : Promise.resolve();
			},
		},
	};

	beforeAll(() => {
		registerPluginErrorCodes({
			"spy.refused": { httpStatus: 403, message: "Refused by the spy." },
		});
		hooked = instance(v1, { plugins: [spy] });
	});

	async function linkFlowWithItsOwnerRemoved() {
		const account = await signUp(hooked);
		const session = cookieOf(await signIn(hooked, account.email), DEFAULT_COOKIE_NAMES.session);
		const flow = await startLink(hooked, `${DEFAULT_COOKIE_NAMES.session}=${session}`);
		return flow;
	}

	it("asks no hook before the verifier proves the row", async () => {
		veto = false;
		const flow = await linkFlowWithItsOwnerRemoved();
		await connection.query(
			`UPDATE ${schema}.oauth_flow SET link_to_user_id = NULL WHERE state_sha256 = $1`,
			[stateHashOf(flow.state)],
		);
		fired.length = 0;

		await callback(hooked, flow);

		expect(fired, "beforeSignIn fired on a row the verifier refuses").toStrictEqual([]);
	});

	it("answers as for an unknown state even when a plugin vetoes sign-ins", async () => {
		veto = false;
		const flow = await linkFlowWithItsOwnerRemoved();
		veto = true;
		const unknownState = await answerOf(
			await callback(hooked, { state: "no-such-state", pointer: flow.pointer, nonce: null }),
		);
		await connection.query(
			`UPDATE ${schema}.oauth_flow SET link_to_user_id = NULL WHERE state_sha256 = $1`,
			[stateHashOf(flow.state)],
		);

		expect(await answerOf(await callback(hooked, flow))).toStrictEqual(unknownState);
		veto = false;
	});
});

//the owner of a link flow is bound on its own and not only through the session it replaces (E-3128)
describe("the owner binding of a link flow's PKCE verifier", () => {
	it("opens the verifier under link_to_user_id as owner and under no other owner", async () => {
		const handler = instance(v1);
		const account = await signUp(handler);
		const session = cookieOf(await signIn(handler, account.email), DEFAULT_COOKIE_NAMES.session);
		const flow = await startLink(handler, `${DEFAULT_COOKIE_NAMES.session}=${session}`);
		const [row] = await connection.query<{
			pkce_verifier_enc: Uint8Array;
			key_version: number;
			provider: string;
			nonce: string | null;
			redirect_path: string | null;
			link_from_session_id: string | null;
			expires_ms: string;
		}>(
			`SELECT pkce_verifier_enc, key_version, provider, nonce, redirect_path, link_from_session_id,
			 (extract(epoch from expires_at) * 1000)::bigint::text AS expires_ms
			 FROM ${schema}.oauth_flow WHERE state_sha256 = $1`,
			[stateHashOf(flow.state)],
		);
		const stored = {
			keyVersion: row?.key_version ?? 0,
			ciphertext: Uint8Array.from(row?.pkce_verifier_enc ?? []),
		};
		const flowRow = rowOfParts([
			stateHashOf(flow.state),
			row?.provider ?? "",
			row?.nonce ?? null,
			row?.redirect_path ?? null,
			row?.link_from_session_id ?? null,
			row?.expires_ms ?? "",
		]);
		const openAs = (owner: string | null) =>
			decryptBound(
				v1,
				{ column: "oauth_flow.pkce_verifier_enc", owner, row: flowRow },
				stored,
				"refused",
			);

		await expect(openAs(account.userId)).resolves.toBeDefined();
		await expect(openAs(null)).rejects.toMatchObject({ code: "authentication_failed" });
		await expect(openAs(randomUUID())).rejects.toMatchObject({ code: "authentication_failed" });
	});

	it("refuses a link flow whose only rewritten column is link_to_user_id", async () => {
		const handler = instance(v1);
		const attacker = await signUp(handler);
		const victim = await signUp(handler);
		const attackerSession = cookieOf(
			await signIn(handler, attacker.email),
			DEFAULT_COOKIE_NAMES.session,
		);
		const flow = await startLink(handler, `${DEFAULT_COOKIE_NAMES.session}=${attackerSession}`);
		const subject = `owner-only-${randomBytes(4).toString("hex")}`;
		provider.reportClaims({
			sub: subject,
			email: `${subject}@provider.example`,
			email_verified: true,
		});

		await connection.query(
			`UPDATE ${schema}.oauth_flow SET link_to_user_id = $2 WHERE state_sha256 = $1`,
			[stateHashOf(flow.state), victim.userId],
		);
		const answer = await callback(
			handler,
			flow,
			`${DEFAULT_COOKIE_NAMES.session}=${attackerSession}`,
		);

		expect(answer.status).toBeGreaterThanOrEqual(300);
		expect(
			await connection.query(`SELECT 1 FROM ${schema}.identity WHERE subject = $1`, [subject]),
		).toHaveLength(0);
	});
});

describe("an identity row replaced between the lookup and the refresh", () => {
	it("fails the flow as a lost state and not as an internal error", async () => {
		const subject = `replaced-${randomBytes(4).toString("hex")}`;
		const handler = instance(v1);
		const flow = await (async () => {
			const answer = await handler(
				requestTo("/sign-in/oauth/start", { body: { provider: "stubby" } }),
			);
			const body = (await answer.json()) as {
				authorizationUrl: string;
				stateCookie: { value: string };
			};
			const url = new URL(body.authorizationUrl);
			return {
				state: url.searchParams.get("state") ?? "",
				pointer: body.stateCookie.value,
				nonce: url.searchParams.get("nonce"),
			};
		})();
		provider.reportClaims({
			sub: subject,
			email: `${subject}@provider.example`,
			email_verified: true,
		});
		expect((await callback(handler, flow)).status).toBeLessThan(400);
		const [found] = await connection.query<{ id: string; user_id: string }>(
			`SELECT id, user_id FROM ${schema}.identity WHERE subject = $1`,
			[subject],
		);
		const identities = createOAuthIdentityRepository({ driver: connection, schema, keys: v1 });
		const existing = await identities.findIdentityBySubject({ provider: "stubby", subject });
		await connection.query(`UPDATE ${schema}.identity SET id = gen_random_uuid() WHERE id = $1`, [
			found?.id,
		]);

		await expect(
			identities.refreshIdentity({
				existing: existing as NonNullable<typeof existing>,
				provider: "stubby",
				subject,
				providerEmail: null,
				providerEmailVerified: false,
				profile: null,
				scopes: [],
				tokenLifetimeInSeconds: null,
				tokens: null,
			}),
		).rejects.toMatchObject({ name: "ConcealedError", reason: "state_not_found" });
	});
});

describe("truncated, emptied and stale values answer as the ordinary failure", () => {
	const truncations: readonly (readonly [string, Uint8Array])[] = [
		["one byte, the marker", Uint8Array.of(0x02)],
		["the marker and a nonce", Uint8Array.from([0x02, ...randomBytes(12)])],
		["empty", new Uint8Array(0)],
		["marker plus 28 random bytes", Uint8Array.from([0x02, ...randomBytes(28)])],
	];

	for (const sealing of ["required", "migrating"] as const) {
		for (const [name, value] of truncations) {
			it(`answers ${name} as a wrong password under ${sealing}`, async () => {
				const handler = instance(v1, { securityState: { sealing } });
				const account = await signUp(handler);
				const wrong = await answerOf(
					await handler(
						requestTo("/sign-in/password", {
							body: { email: account.email, password: `${PASSWORD} wrong` },
						}),
					),
				);
				await connection.query(
					`UPDATE ${schema}.password_credential SET phc = $2 WHERE user_id = $1`,
					[account.userId, value],
				);

				expect(await answerOf(await signIn(handler, account.email))).toStrictEqual(wrong);
			});
		}
	}

	it("answers a value under a version that left the ring as a wrong password", async () => {
		const account = await signUp(instance(v1));
		const handler = instance(v2Only);
		const wrong = await answerOf(
			await handler(
				requestTo("/sign-in/password", {
					body: { email: account.email, password: `${PASSWORD} wrong` },
				}),
			),
		);
		expect(await answerOf(await signIn(handler, account.email))).toStrictEqual(wrong);
	});
});

describe("the row binding within one owner", () => {
	it("refuses a provider token moved to another identity row of the same account", async () => {
		const handler = instance(v1);
		const account = await signUp(handler);
		let session = cookieOf(await signIn(handler, account.email), DEFAULT_COOKIE_NAMES.session);
		const identities: string[] = [];
		for (let index = 0; index < 2; index += 1) {
			const flow = await startLink(handler, `${DEFAULT_COOKIE_NAMES.session}=${session}`);
			const subject = `same-owner-${index}-${randomBytes(4).toString("hex")}`;
			provider.reportClaims({ sub: subject, email: account.email, email_verified: true });
			const answer = await callback(handler, flow, `${DEFAULT_COOKIE_NAMES.session}=${session}`);
			expect(answer.status, await answer.clone().text()).toBeLessThan(400);
			session = cookieOf(answer, DEFAULT_COOKIE_NAMES.session) ?? session;
			const [row] = await connection.query<{ id: string }>(
				`SELECT id FROM ${schema}.identity WHERE subject = $1`,
				[subject],
			);
			identities.push(row?.id ?? "");
		}
		const [first = "", second = ""] = identities;
		await connection.query(
			`UPDATE ${schema}.identity SET access_token_enc = (SELECT access_token_enc FROM ${schema}.identity WHERE id = $1) WHERE id = $2`,
			[first, second],
		);
		const [moved] = await connection.query<{
			access_token_enc: Uint8Array;
			token_key_version: number;
		}>(`SELECT access_token_enc, token_key_version FROM ${schema}.identity WHERE id = $1`, [
			second,
		]);

		await expect(
			decryptBound(
				v1,
				{ column: "identity.access_token_enc", owner: account.userId, row: second },
				{
					keyVersion: moved?.token_key_version ?? 1,
					ciphertext: Uint8Array.from(moved?.access_token_enc ?? []),
				},
				"readable",
			),
		).rejects.toMatchObject({ code: "authentication_failed" });
		await expect(
			connection.transaction((transaction) =>
				rebindEnvelopesOfAccount({
					driver: transaction,
					schema,
					keys: v1,
					actor: actorOfTestUser(account.userId),
					sealing: "migrating",
				}),
			),
		).rejects.toMatchObject({ code: "authentication_failed" });
		expect((await phcOf(account.userId)).ciphertext[0]).toBe(0x02);
	});
});
