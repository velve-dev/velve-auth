import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rebindEnvelopesOfAccount } from "../src/core/auth/account-envelopes.js";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import { createTotpService, timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { encryptWithPurposeKey } from "../src/core/keys/envelope.js";
import {
	type BoundColumn,
	decryptBound,
	type EnvelopeBinding,
	rowOfParts,
} from "../src/core/keys/envelope-binding.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { createOAuthIdentityRepository } from "../src/core/oauth/identity-repository.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, requestTo } from "./auth-fixtures.js";
import { actorOfTestUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import {
	codeCarrying,
	createStubProvider,
	oauthConfigFor,
	type StubProvider,
} from "./oauth-provider.js";
import { pendingAuthenticationsOn, secretBytesOfBase32, testKeyRing } from "./totp-fixtures.js";

/**
 * T-INTEG-1 against a real database and through the paths that decrypt: a password sign-in, a TOTP
 * check on a pending sign-in, an OAuth callback, and for the provider tokens, which no path of the
 * library reads back, the binding an application reading them uses.
 */

const PASSWORD = "a password long enough for the policy 7c1e";
const ring = testKeyRing(2);
const beforeRotation = ring.providerAt(1, [1]);
const afterRotation = ring.providerAt(2, [1, 2]);

type Handler = (request: Request) => Promise<Response>;

let connection: TestConnection;
let schema: string;
let provider: StubProvider;
let handler: Handler;
let accountNumber = 0;

function instanceUnder(
	keys: KeyProvider,
	overrides: Partial<VelveAuthConfig<"email">> = {},
): Handler {
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
	const migrated = await openMigratedSchema("integ_envelope");
	connection = migrated.connection;
	schema = migrated.schema;
	provider = await createStubProvider({ claims: { sub: "nobody" }, openIdConnect: true });
	handler = instanceUnder(beforeRotation);
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

interface Account {
	readonly email: string;
	readonly userId: string;
	totpSecret: Uint8Array<ArrayBuffer> | null;
}

async function signUp(): Promise<Account> {
	accountNumber += 1;
	const email = `envelope${accountNumber}@example.com`;
	const answer = await handler(requestTo("/sign-up", { body: { email, password: PASSWORD } }));
	expect(answer.status).toBe(200);
	const [row] = await connection.query<{ id: string }>(
		`SELECT id FROM ${schema}.user WHERE email = $1`,
		[email],
	);
	if (row === undefined) {
		throw new Error("the sign-up wrote no account");
	}
	return { email, userId: row.id, totpSecret: null };
}

async function enrolTotp(account: Account, keys: KeyProvider = beforeRotation): Promise<void> {
	const totp = createTotpService({
		driver: connection,
		schema,
		keys,
		pending: pendingAuthenticationsOn(connection, schema),
		issuer: "Velve",
		clock: { now: () => new Date() },
	});
	const actor = actorOfTestUser(account.userId);
	const enrolment = await totp.enroll.start({ actor, accountName: account.email });
	const secret = secretBytesOfBase32(enrolment.secretBase32);
	await totp.enroll.finish({ actor, code: currentCodeOf(secret, -1) });
	account.totpSecret = secret;
}

//the enrolment claims the previous step so a check at the current one is not a replay
function currentCodeOf(secret: Uint8Array<ArrayBuffer>, offset = 0): string {
	return totpCodeForStep(secret, timeStepAt(new Date()) + offset);
}

async function signInWithPassword(
	on: Handler,
	email: string,
	password: string,
): Promise<{ status: number; outcome: string | null; pending: string | null }> {
	const answer = await on(requestTo("/sign-in/password", { body: { email, password } }));
	const body = (await answer.json()) as { status?: string; error?: { code: string } };
	return {
		status: answer.status,
		outcome: body.status ?? body.error?.code ?? null,
		pending: cookieOf(answer, DEFAULT_COOKIE_NAMES.pending),
	};
}

//a refused sign-in answers exactly as a wrong password does
const REFUSED_SIGN_IN = { status: 401, outcome: "invalid_credentials", pending: null };

interface Answer {
	readonly status: number;
	readonly code: string | null;
}

async function answerOf(answer: Response): Promise<Answer> {
	const body = (await answer.json().catch(() => ({}))) as { error?: { code: string } };
	return { status: answer.status, code: body.error?.code ?? null };
}

async function checkTotp(on: Handler, account: Account, code: string): Promise<Answer> {
	const signedIn = await signInWithPassword(on, account.email, PASSWORD);
	expect(signedIn.outcome).toBe("second_factor_required");
	return answerOf(
		await on(
			requestTo("/factor/totp/verify", {
				body: { code },
				cookie: `${DEFAULT_COOKIE_NAMES.pending}=${signedIn.pending}`,
			}),
		),
	);
}

//a code no secret produced is the ordinary failure a refused secret must look like
async function wrongCodeAnswer(on: Handler, account: Account): Promise<Answer> {
	const secret = account.totpSecret as Uint8Array<ArrayBuffer>;
	const right = currentCodeOf(secret);
	const wrong = right === "000000" ? "000001" : "000000";
	return checkTotp(on, account, wrong);
}

interface OpenedFlow {
	readonly state: string;
	readonly pointer: string;
	readonly nonce: string | null;
}

async function startOAuth(on: Handler): Promise<OpenedFlow> {
	const answer = await on(requestTo("/sign-in/oauth/start", { body: { provider: "stubby" } }));
	expect(answer.status).toBe(200);
	const body = (await answer.json()) as {
		authorizationUrl: string;
		stateCookie: { value: string };
	};
	return {
		state: new URL(body.authorizationUrl).searchParams.get("state") ?? "",
		pointer: body.stateCookie.value,
		nonce: new URL(body.authorizationUrl).searchParams.get("nonce"),
	};
}

async function completeOAuth(on: Handler, flow: OpenedFlow): Promise<Response> {
	return on(
		requestTo(
			`/sign-in/oauth/callback/stubby?code=${codeCarrying(flow.nonce)}&state=${encodeURIComponent(flow.state)}`,
			{ method: "GET", cookie: `${DEFAULT_COOKIE_NAMES.oauthState}=${flow.pointer}` },
		),
	);
}

function reportFreshAccount(prefix: string): void {
	accountNumber += 1;
	const subject = `${prefix}-${accountNumber}`;
	provider.reportClaims({
		sub: subject,
		email: `${subject}@provider.example`,
		email_verified: true,
	});
}

function stateHashOf(state: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(createHash("sha256").update(state, "utf8").digest());
}

async function signInThroughOAuth(
	subject: string,
): Promise<{ userId: string; identityId: string }> {
	provider.reportClaims({
		sub: subject,
		email: `${subject}@provider.example`,
		email_verified: true,
	});
	const answer = await completeOAuth(handler, await startOAuth(handler));
	expect(answer.status).toBeLessThan(400);
	const [row] = await connection.query<{ id: string; user_id: string }>(
		`SELECT id, user_id FROM ${schema}.identity WHERE subject = $1`,
		[subject],
	);
	if (row === undefined) {
		throw new Error("the OAuth sign-in linked no identity");
	}
	return { userId: row.user_id, identityId: row.id };
}

interface StoredCiphertext {
	readonly keyVersion: number;
	readonly ciphertext: Uint8Array<ArrayBuffer>;
}

async function readPhc(userId: string): Promise<StoredCiphertext> {
	const [row] = await connection.query<{ phc: Uint8Array; key_version: number }>(
		`SELECT phc, key_version FROM ${schema}.password_credential WHERE user_id = $1`,
		[userId],
	);
	if (row === undefined) {
		throw new Error("no password credential");
	}
	return { keyVersion: row.key_version, ciphertext: Uint8Array.from(row.phc) };
}

async function writePhc(userId: string, stored: StoredCiphertext): Promise<void> {
	await connection.query(
		`UPDATE ${schema}.password_credential SET phc = $2, key_version = $3 WHERE user_id = $1`,
		[userId, stored.ciphertext, stored.keyVersion],
	);
}

async function readTotpSecret(userId: string): Promise<StoredCiphertext> {
	const [row] = await connection.query<{ secret_enc: Uint8Array; key_version: number }>(
		`SELECT secret_enc, key_version FROM ${schema}.totp_credential WHERE user_id = $1`,
		[userId],
	);
	if (row === undefined) {
		throw new Error("no TOTP credential");
	}
	return { keyVersion: row.key_version, ciphertext: Uint8Array.from(row.secret_enc) };
}

async function writeTotpSecret(userId: string, stored: StoredCiphertext): Promise<void> {
	await connection.query(
		`UPDATE ${schema}.totp_credential SET secret_enc = $2, key_version = $3 WHERE user_id = $1`,
		[userId, stored.ciphertext, stored.keyVersion],
	);
}

const TOKEN_COLUMN_NAMES = {
	"identity.access_token_enc": "access_token_enc",
	"identity.refresh_token_enc": "refresh_token_enc",
	"identity.id_token_enc": "id_token_enc",
} as const;

type TokenColumn = keyof typeof TOKEN_COLUMN_NAMES;

async function readToken(identityId: string, column: TokenColumn): Promise<StoredCiphertext> {
	const [row] = await connection.query<{ value: Uint8Array | null; key_version: number }>(
		`SELECT ${TOKEN_COLUMN_NAMES[column]} AS value, token_key_version AS key_version
		 FROM ${schema}.identity WHERE id = $1`,
		[identityId],
	);
	if (row?.value === null || row?.value === undefined) {
		throw new Error(`no ${column} on the identity`);
	}
	return { keyVersion: row.key_version, ciphertext: Uint8Array.from(row.value) };
}

async function writeToken(
	identityId: string,
	column: TokenColumn,
	stored: StoredCiphertext,
): Promise<void> {
	await connection.query(
		`UPDATE ${schema}.identity SET ${TOKEN_COLUMN_NAMES[column]} = $2, token_key_version = $3 WHERE id = $1`,
		[identityId, stored.ciphertext, stored.keyVersion],
	);
}

async function readPkce(state: string): Promise<StoredCiphertext> {
	const [row] = await connection.query<{ pkce_verifier_enc: Uint8Array; key_version: number }>(
		`SELECT pkce_verifier_enc, key_version FROM ${schema}.oauth_flow WHERE state_sha256 = $1`,
		[stateHashOf(state)],
	);
	if (row === undefined) {
		throw new Error("no open OAuth flow");
	}
	return { keyVersion: row.key_version, ciphertext: Uint8Array.from(row.pkce_verifier_enc) };
}

async function pkceRowOf(state: string): Promise<Uint8Array<ArrayBuffer>> {
	const [row] = await connection.query<{
		provider: string;
		nonce: string | null;
		redirect_path: string | null;
		link_from_session_id: string | null;
		expires_ms: string;
	}>(
		`SELECT provider, nonce, redirect_path, link_from_session_id,
		 (extract(epoch from expires_at) * 1000)::bigint::text AS expires_ms
		 FROM ${schema}.oauth_flow WHERE state_sha256 = $1`,
		[stateHashOf(state)],
	);
	if (row === undefined) {
		throw new Error("no open OAuth flow");
	}
	return rowOfParts([
		stateHashOf(state),
		row.provider,
		row.nonce,
		row.redirect_path,
		row.link_from_session_id,
		row.expires_ms,
	]);
}

async function writePkce(state: string, stored: StoredCiphertext): Promise<void> {
	await connection.query(
		`UPDATE ${schema}.oauth_flow SET pkce_verifier_enc = $2, key_version = $3 WHERE state_sha256 = $1`,
		[stateHashOf(state), stored.ciphertext, stored.keyVersion],
	);
}

function tokenBinding(
	column: BoundColumn,
	identity: { userId: string; identityId: string },
): EnvelopeBinding {
	return { column, owner: identity.userId, row: identity.identityId };
}

async function decrypts(
	keys: KeyProvider,
	binding: EnvelopeBinding,
	stored: StoredCiphertext,
): Promise<boolean> {
	return decryptBound(keys, binding, stored, "refused").then(
		() => true,
		() => false,
	);
}

const TOKEN_ISSUED_BY_THE_STUB = "provider-access-token";

describe("T-INTEG-1: a ciphertext copied to another owner, row or column does not decrypt (S-INTEG-1)", () => {
	const refusedCopies: string[] = [];

	it("refuses a password ciphertext copied from another account at sign-in", async () => {
		const victim = await signUp();
		const attacker = await signUp();
		expect((await signInWithPassword(handler, attacker.email, PASSWORD)).status).toBe(200);

		await writePhc(victim.userId, await readPhc(attacker.userId));
		const answer = await signInWithPassword(handler, victim.email, PASSWORD);

		expect(answer).toStrictEqual(REFUSED_SIGN_IN);
		refusedCopies.push("password_credential.phc to another account");
	});

	it("refuses a TOTP secret copied from another account at the factor check", async () => {
		const victim = await signUp();
		const attacker = await signUp();
		await enrolTotp(victim);
		await enrolTotp(attacker);
		const attackerSecret = attacker.totpSecret as Uint8Array<ArrayBuffer>;
		expect((await checkTotp(handler, attacker, currentCodeOf(attackerSecret))).status).toBe(200);
		const ordinaryFailure = await wrongCodeAnswer(handler, victim);

		await writeTotpSecret(victim.userId, await readTotpSecret(attacker.userId));
		const answer = await checkTotp(handler, victim, currentCodeOf(attackerSecret));

		expect(answer).toStrictEqual(ordinaryFailure);
		expect(answer.status).toBe(401);
		refusedCopies.push("totp_credential.secret_enc to another account");
	});

	it("refuses a provider token copied to another account's identity", async () => {
		const victim = await signInThroughOAuth(`victim-${accountNumber}`);
		const attacker = await signInThroughOAuth(`attacker-${accountNumber}`);
		const column = "identity.access_token_enc";
		const original = await readToken(attacker.identityId, column);
		expect(await decrypts(beforeRotation, tokenBinding(column, attacker), original)).toBe(true);

		await writeToken(victim.identityId, column, original);

		expect(
			await decrypts(
				beforeRotation,
				tokenBinding(column, victim),
				await readToken(victim.identityId, column),
			),
		).toBe(false);
		refusedCopies.push("identity.access_token_enc to another account");
	});

	it("refuses a PKCE verifier copied from another flow at the callback", async () => {
		const victim = await startOAuth(handler);
		const attacker = await startOAuth(handler);
		reportFreshAccount("pkce");
		const unknownState = await answerOf(
			await completeOAuth(handler, {
				state: "no-such-state",
				pointer: victim.pointer,
				nonce: null,
			}),
		);

		await writePkce(victim.state, await readPkce(attacker.state));
		const copied = await answerOf(await completeOAuth(handler, victim));
		const original = await completeOAuth(handler, attacker);

		expect(copied).toStrictEqual(unknownState);
		expect(copied.status).toBeGreaterThanOrEqual(400);
		expect(original.status).toBeLessThan(400);
		refusedCopies.push("oauth_flow.pkce_verifier_enc to another flow");
	});

	//one purpose key covers the three token columns, so only the binding tells them apart
	//the two copies T-INTEG-1 counts are the access token into the other two columns
	it.each([
		["identity.access_token_enc", "identity.refresh_token_enc", true],
		["identity.access_token_enc", "identity.id_token_enc", true],
		["identity.refresh_token_enc", "identity.id_token_enc", false],
		["identity.id_token_enc", "identity.access_token_enc", false],
	] as const)("refuses %s moved into %s of the same identity", async (from, into, counted) => {
		const identity = await signInThroughOAuth(`columns-${accountNumber}-${from}-${into}`);
		const original = await readToken(identity.identityId, from);
		expect(await decrypts(beforeRotation, tokenBinding(from, identity), original)).toBe(true);

		await writeToken(identity.identityId, into, original);

		expect(
			await decrypts(
				beforeRotation,
				tokenBinding(into, identity),
				await readToken(identity.identityId, into),
			),
		).toBe(false);
		if (counted) {
			refusedCopies.push(`${from} to ${into}`);
		}
	});

	it("counts six of six copies refused", () => {
		expect(refusedCopies).toHaveLength(6);
	});
});

describe("a ciphertext moved to a column of another purpose does not decrypt either (S-INTEG-1)", () => {
	it("refuses a password ciphertext moved into the TOTP column of the same account", async () => {
		const account = await signUp();
		await enrolTotp(account);
		const secret = account.totpSecret as Uint8Array<ArrayBuffer>;

		const ordinaryFailure = await wrongCodeAnswer(handler, account);

		await writeTotpSecret(account.userId, await readPhc(account.userId));

		expect(await checkTotp(handler, account, currentCodeOf(secret))).toStrictEqual(ordinaryFailure);
	});

	it("refuses a TOTP secret moved into the password column of the same account", async () => {
		const account = await signUp();
		await enrolTotp(account);

		await writePhc(account.userId, await readTotpSecret(account.userId));

		expect(await signInWithPassword(handler, account.email, PASSWORD)).toStrictEqual(
			REFUSED_SIGN_IN,
		);
	});

	it("refuses an access token moved into the refresh-token column of the same identity", async () => {
		const identity = await signInThroughOAuth(`columns-${accountNumber}`);
		const access = await readToken(identity.identityId, "identity.access_token_enc");
		expect(
			new TextDecoder().decode(
				await decryptBound(
					beforeRotation,
					tokenBinding("identity.access_token_enc", identity),
					access,
					"refused",
				),
			),
		).toBe(TOKEN_ISSUED_BY_THE_STUB);

		await writeToken(identity.identityId, "identity.refresh_token_enc", access);

		expect(
			await decrypts(
				beforeRotation,
				tokenBinding("identity.refresh_token_enc", identity),
				await readToken(identity.identityId, "identity.refresh_token_enc"),
			),
		).toBe(false);
	});

	it("refuses a PKCE verifier moved into a token column of an identity", async () => {
		const identity = await signInThroughOAuth(`verifier-${accountNumber}`);
		const flow = await startOAuth(handler);

		await writeToken(identity.identityId, "identity.refresh_token_enc", await readPkce(flow.state));

		expect(
			await decrypts(
				beforeRotation,
				tokenBinding("identity.refresh_token_enc", identity),
				await readToken(identity.identityId, "identity.refresh_token_enc"),
			),
		).toBe(false);
	});
});

describe("T-INTEG-1: every original still decrypts after the ring is rotated to v2,v1 (S-INTEG-1)", () => {
	it("opens four of four originals written under v1 with v2 current", async () => {
		const account = await signUp();
		await enrolTotp(account);
		const identity = await signInThroughOAuth(`rotation-${accountNumber}`);
		const flow = await startOAuth(handler);
		const opened: string[] = [];

		if (
			await decrypts(afterRotation, phcBindingOf(account.userId), await readPhc(account.userId))
		) {
			opened.push("password_credential.phc");
		}
		if (
			await decrypts(
				afterRotation,
				secretBindingOf(account.userId),
				await readTotpSecret(account.userId),
			)
		) {
			opened.push("totp_credential.secret_enc");
		}
		if (
			await decrypts(
				afterRotation,
				tokenBinding("identity.access_token_enc", identity),
				await readToken(identity.identityId, "identity.access_token_enc"),
			)
		) {
			opened.push("identity.access_token_enc");
		}
		if (
			await decrypts(
				afterRotation,
				{ column: "oauth_flow.pkce_verifier_enc", owner: null, row: await pkceRowOf(flow.state) },
				await readPkce(flow.state),
			)
		) {
			opened.push("oauth_flow.pkce_verifier_enc");
		}

		expect(opened).toHaveLength(4);
	});

	it("signs in, checks the factor and completes the flow through an instance on the rotated ring", async () => {
		const account = await signUp();
		await enrolTotp(account);
		const flow = await startOAuth(handler);
		const rotated = instanceUnder(afterRotation);
		reportFreshAccount("rotated");
		const secret = account.totpSecret as Uint8Array<ArrayBuffer>;

		expect((await checkTotp(rotated, account, currentCodeOf(secret))).status).toBe(200);
		expect((await completeOAuth(rotated, flow)).status).toBeLessThan(400);
	});

	it("writes a new ciphertext under v2 once v2 is current", async () => {
		const rotated = instanceUnder(afterRotation);
		accountNumber += 1;
		const email = `rotated${accountNumber}@example.com`;
		await rotated(requestTo("/sign-up", { body: { email, password: PASSWORD } }));
		const [row] = await connection.query<{ key_version: number }>(
			`SELECT credential.key_version FROM ${schema}.password_credential credential
			 JOIN ${schema}.user account ON account.id = credential.user_id WHERE account.email = $1`,
			[email],
		);

		expect(row?.key_version).toBe(2);
	});
});

function phcBindingOf(userId: string): EnvelopeBinding {
	return { column: "password_credential.phc", owner: userId, row: userId };
}

function secretBindingOf(userId: string): EnvelopeBinding {
	return { column: "totp_credential.secret_enc", owner: userId, row: userId };
}

const BOUND_FORM_MARKER = 0x02;

async function unboundStartingWithTheMarker(
	plaintext: Uint8Array<ArrayBuffer>,
): Promise<StoredCiphertext> {
	for (let attempt = 0; attempt < 10_000; attempt += 1) {
		const unbound = await encryptWithPurposeKey(beforeRotation, "password-enc", plaintext);
		if (unbound.ciphertext[0] === BOUND_FORM_MARKER) {
			return unbound;
		}
	}
	throw new Error("no nonce began with the marker in ten thousand draws");
}

async function unboundPhcOf(userId: string): Promise<StoredCiphertext> {
	const bound = await readPhc(userId);
	const phc = await decryptBound(beforeRotation, phcBindingOf(userId), bound, "refused");
	return encryptWithPurposeKey(beforeRotation, "password-enc", phc);
}

describe("T-INTEG-1: the unbound form of 1.x is read only while migrating (S-INTEG-1)", () => {
	it("refuses an unbound password ciphertext under the default sealing mode", async () => {
		const account = await signUp();
		await writePhc(account.userId, await unboundPhcOf(account.userId));

		expect(await signInWithPassword(handler, account.email, PASSWORD)).toStrictEqual(
			REFUSED_SIGN_IN,
		);
	});

	it("refuses it under sealing required written out", async () => {
		const account = await signUp();
		await writePhc(account.userId, await unboundPhcOf(account.userId));
		const required = instanceUnder(beforeRotation, { securityState: { sealing: "required" } });

		expect(await signInWithPassword(required, account.email, PASSWORD)).toStrictEqual(
			REFUSED_SIGN_IN,
		);
	});

	it("reads an unbound password ciphertext under sealing migrating", async () => {
		const account = await signUp();
		await writePhc(account.userId, await unboundPhcOf(account.userId));
		const migrating = instanceUnder(beforeRotation, { securityState: { sealing: "migrating" } });

		expect((await signInWithPassword(migrating, account.email, PASSWORD)).status).toBe(200);
	});

	it("reads an unbound TOTP secret under migrating and refuses it under required", async () => {
		const account = await signUp();
		await enrolTotp(account);
		const secret = account.totpSecret as Uint8Array<ArrayBuffer>;
		const unbound = await encryptWithPurposeKey(beforeRotation, "totp-enc", secret);
		const ordinaryFailure = await wrongCodeAnswer(handler, account);
		await writeTotpSecret(account.userId, unbound);
		const migrating = instanceUnder(beforeRotation, { securityState: { sealing: "migrating" } });

		expect(await checkTotp(handler, account, currentCodeOf(secret))).toStrictEqual(ordinaryFailure);
		expect((await checkTotp(migrating, account, currentCodeOf(secret, 1))).status).toBe(200);
	});

	//one old value in 256 begins with the marker of the bound form by its random nonce (E-3111, E-3119)
	it("reads an old password ciphertext whose nonce begins with the bound marker while migrating, and converts it", async () => {
		const account = await signUp();
		const phc = await decryptBound(
			beforeRotation,
			phcBindingOf(account.userId),
			await readPhc(account.userId),
			"refused",
		);
		const unbound = await unboundStartingWithTheMarker(phc);
		await writePhc(account.userId, unbound);
		const migrating = instanceUnder(beforeRotation, { securityState: { sealing: "migrating" } });

		expect((await signInWithPassword(migrating, account.email, PASSWORD)).status).toBe(200);
		expect(await signInWithPassword(handler, account.email, PASSWORD)).toStrictEqual(
			REFUSED_SIGN_IN,
		);

		const rewrite = await connection.transaction((transaction) =>
			rebindEnvelopesOfAccount({
				driver: transaction,
				schema,
				keys: beforeRotation,
				actor: actorOfTestUser(account.userId),
				sealing: "migrating",
			}),
		);
		expect(rewrite.passwordRewritten).toBe(true);
		expect(
			await decryptBound(
				beforeRotation,
				phcBindingOf(account.userId),
				await readPhc(account.userId),
				"refused",
			),
		).toStrictEqual(phc);
		expect((await signInWithPassword(handler, account.email, PASSWORD)).status).toBe(200);
	});

	it("refuses an unbound PKCE verifier even while migrating, so a flow across the upgrade begins again", async () => {
		const migrating = instanceUnder(beforeRotation, { securityState: { sealing: "migrating" } });
		const flow = await startOAuth(migrating);
		const unbound = await encryptWithPurposeKey(
			beforeRotation,
			"pkce-enc",
			new TextEncoder().encode("a verifier written before the upgrade"),
		);
		await writePkce(flow.state, unbound);
		reportFreshAccount("unbound");

		const unknownState = await answerOf(
			await completeOAuth(migrating, {
				state: "no-such-state",
				pointer: flow.pointer,
				nonce: null,
			}),
		);
		const answer = await answerOf(await completeOAuth(migrating, flow));

		expect(answer).toStrictEqual(unknownState);
		expect(answer.status).toBeGreaterThanOrEqual(400);
	});
});

async function unboundTokensOf(identity: { userId: string; identityId: string }): Promise<void> {
	for (const column of [
		"identity.access_token_enc",
		"identity.refresh_token_enc",
	] as const satisfies readonly TokenColumn[]) {
		const plaintext = await decryptBound(
			beforeRotation,
			tokenBinding(column, identity),
			await readToken(identity.identityId, column),
			"refused",
		);
		await writeToken(
			identity.identityId,
			column,
			await encryptWithPurposeKey(beforeRotation, "oauth-token-enc", plaintext),
		);
	}
}

const STORED_PHC = `$argon2id$v=19$m=19456,t=2,p=1$${"c2FsdA".repeat(4)}$${"aGFzaA".repeat(7)}`;

describe("rebindEnvelopesOfAccount, the rewrite a change on an unsealed account runs first (S-INTEG-1, E-3117)", () => {
	async function rebind(userId: string, keys: KeyProvider, sealing: "migrating" | "required") {
		return connection.transaction((transaction) =>
			rebindEnvelopesOfAccount({
				driver: transaction,
				schema,
				keys,
				actor: actorOfTestUser(userId),
				sealing,
			}),
		);
	}

	it("rewrites every unbound envelope of one account into the bound form of the same plaintext", async () => {
		const identity = await signInThroughOAuth(`rebind-${accountNumber}`);
		const [owner] = await connection.query<{ email: string }>(
			`SELECT email FROM ${schema}.user WHERE id = $1`,
			[identity.userId],
		);
		const account: Account = {
			email: owner?.email ?? "",
			userId: identity.userId,
			totpSecret: null,
		};
		const unboundPhc = await encryptWithPurposeKey(
			beforeRotation,
			"password-enc",
			new TextEncoder().encode(STORED_PHC),
		);
		await connection.query(
			`INSERT INTO ${schema}.password_credential (user_id, phc, key_version, scheme)
			 VALUES ($1, $2, $3, 'argon2id')`,
			[identity.userId, unboundPhc.ciphertext, unboundPhc.keyVersion],
		);
		await enrolTotp(account);
		const secret = account.totpSecret as Uint8Array<ArrayBuffer>;
		await writeTotpSecret(
			identity.userId,
			await encryptWithPurposeKey(beforeRotation, "totp-enc", secret),
		);
		await unboundTokensOf(identity);

		await expect(rebind(identity.userId, beforeRotation, "required")).rejects.toMatchObject({
			name: "KeyError",
		});
		const rewrite = await rebind(identity.userId, beforeRotation, "migrating");

		expect(rewrite).toStrictEqual({
			passwordRewritten: true,
			totpRewritten: true,
			identitiesRewritten: 1,
		});
		expect(
			await decryptBound(
				beforeRotation,
				secretBindingOf(identity.userId),
				await readTotpSecret(identity.userId),
				"refused",
			),
		).toStrictEqual(secret);
		expect(
			await decrypts(beforeRotation, phcBindingOf(identity.userId), await readPhc(identity.userId)),
		).toBe(true);
		for (const column of ["identity.access_token_enc", "identity.refresh_token_enc"] as const) {
			expect(
				await decrypts(
					beforeRotation,
					tokenBinding(column, identity),
					await readToken(identity.identityId, column),
				),
			).toBe(true);
		}
		expect(await rebind(identity.userId, beforeRotation, "migrating")).toStrictEqual({
			passwordRewritten: false,
			totpRewritten: false,
			identitiesRewritten: 0,
		});
	});

	it("rewrites the bound envelopes of an account under the current key version after a rotation", async () => {
		const account = await signUp();
		await enrolTotp(account);

		const rewrite = await rebind(account.userId, afterRotation, "required");

		expect(rewrite).toStrictEqual({
			passwordRewritten: true,
			totpRewritten: true,
			identitiesRewritten: 0,
		});
		expect((await readPhc(account.userId)).keyVersion).toBe(2);
		expect((await readTotpSecret(account.userId)).keyVersion).toBe(2);
	});

	it("rewrites nothing of an account whose envelope was copied from another, and throws instead", async () => {
		const victim = await signUp();
		const attacker = await signUp();
		await writePhc(victim.userId, await readPhc(attacker.userId));

		await expect(rebind(victim.userId, beforeRotation, "migrating")).rejects.toMatchObject({
			code: "authentication_failed",
		});
	});
	it("refuses an identity whose token columns hold ciphertexts and whose key version is empty", async () => {
		const identity = await signInThroughOAuth(`no-version-${accountNumber}`);
		await connection.query(`UPDATE ${schema}.identity SET token_key_version = NULL WHERE id = $1`, [
			identity.identityId,
		]);

		await expect(rebind(identity.userId, beforeRotation, "migrating")).rejects.toMatchObject({
			code: "key_version_unknown",
		});
	});

	//a ring whose current version moves between the two passes leaves the first pass behind
	it("fails when the second pass finds an envelope the first one left under an older version", async () => {
		const account = await signUp();
		await writePhc(account.userId, await unboundPhcOf(account.userId));
		let currentCalls = 0;
		const movingRing: KeyProvider = {
			current: (purpose) => {
				currentCalls += 1;
				return (currentCalls <= 2 ? ring.providerAt(1, [1, 2]) : afterRotation).current(purpose);
			},
			byVersion: (purpose, version) => afterRotation.byVersion(purpose, version),
		};

		await expect(rebind(account.userId, movingRing, "migrating")).rejects.toMatchObject({
			code: "internal_error",
		});
		const left = await readPhc(account.userId);
		expect(left.ciphertext[0]).not.toBe(0x02);
	});

	it("refuses to encrypt the tokens of a new identity under two key versions", async () => {
		const account = await signUp();
		let currentCalls = 0;
		const alternating: KeyProvider = {
			current: (purpose) => {
				currentCalls += 1;
				return (currentCalls % 2 === 0 ? afterRotation : ring.providerAt(1, [1, 2])).current(
					purpose,
				);
			},
			byVersion: (purpose, version) => afterRotation.byVersion(purpose, version),
		};

		await expect(
			createOAuthIdentityRepository({
				driver: connection,
				schema,
				keys: alternating,
			}).insertIdentityOfSignIn({
				userId: account.userId,
				provider: "stubby",
				subject: `two-versions-${accountNumber}`,
				providerEmail: null,
				providerEmailVerified: false,
				profile: null,
				scopes: [],
				tokenLifetimeInSeconds: 3600,
				tokens: { accessToken: "access", refreshToken: "refresh", idToken: "id" },
			}),
		).rejects.toMatchObject({ code: "internal_error" });
	});

	it("refuses to write three tokens of one identity under two key versions", async () => {
		const identity = await signInThroughOAuth(`two-versions-${accountNumber}`);
		let calls = 0;
		const alternating: KeyProvider = {
			current: (purpose) => {
				calls += 1;
				return (calls % 2 === 0 ? afterRotation : ring.providerAt(1, [1, 2])).current(purpose);
			},
			byVersion: (purpose, version) => afterRotation.byVersion(purpose, version),
		};
		await unboundTokensOf(identity);

		await expect(rebind(identity.userId, alternating, "migrating")).rejects.toMatchObject({
			code: "internal_error",
		});
	});

	it("fails rather than reporting success when the row changed under the rewrite", async () => {
		const account = await signUp();
		const other = await signUp();
		const unbound = await unboundPhcOf(account.userId);
		await writePhc(account.userId, unbound);
		const replacement = await readPhc(other.userId);

		const attempt = connection.transaction((transaction) =>
			rebindEnvelopesOfAccount({
				driver: {
					async query<T>(sql: string, parameters: unknown[]): Promise<T[]> {
						if (/^UPDATE \S+\.password_credential SET phc = \$2/.test(sql.trim())) {
							await transaction.query(
								`UPDATE ${schema}.password_credential SET phc = $2 WHERE user_id = $1`,
								[account.userId, replacement.ciphertext],
							);
						}
						return transaction.query<T>(sql, parameters);
					},
					transaction: (work) => transaction.transaction(work),
				},
				schema,
				keys: beforeRotation,
				actor: actorOfTestUser(account.userId),
				sealing: "migrating",
			}),
		);

		await expect(attempt).rejects.toMatchObject({ code: "internal_error" });
		expect(
			Buffer.from((await readPhc(account.userId)).ciphertext).equals(
				Buffer.from(unbound.ciphertext),
			),
		).toBe(true);
	});
});
