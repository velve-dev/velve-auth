import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import type { Driver } from "../src/core/db/driver.js";
import type { WebAuthnAttestationConfig } from "../src/core/factor/webauthn/config.js";
import {
	createWebAuthnService,
	type WebAuthnService,
} from "../src/core/factor/webauthn/service.js";
import { ConcealedError, toVisibleFailure, VelveError } from "../src/core/http/error-map.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { setAuthenticatorAllowlist } from "../src/core/security-state/authenticator-allowlist.js";
import type { SecurityStateRuntime } from "../src/core/security-state/runtime.js";
import { testKeyProvider } from "./auth-fixtures.js";
import { actorOfTestUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { testSecurityState } from "./security-state-fixtures.js";
import {
	type AttestationKind,
	createAttestingAuthenticator,
	createTestCertificateAuthority,
	type TestCertificateAuthority,
} from "./verified-attestation-fixtures.js";
import {
	beginSecondFactor,
	ORIGIN,
	RELYING_PARTY_ID,
	TEST_WEBAUTHN_CONFIG,
} from "./webauthn-fixtures.js";
import type { VirtualAuthenticator } from "./webauthn-simulator.js";

/**
 * S-INTEG-13 at the WebAuthn service: what a registration asks the authenticator for, which
 * attestations count as verified against the configured roots, that a list refuses every other
 * authenticator at registration and at both passkey sign-ins, that it never leaves an account
 * without a usable sign-in method silently, and that a writer without the root key can change
 * neither the list nor a credential's attestation.
 */

const ALLOWED = "2fc0579f-8113-47ea-b116-bb5a8db9202a";
const OTHER = "cb69481e-8ff7-4039-93ec-0a2729a154a8";

interface Bench {
	readonly connection: TestConnection;
	readonly schema: string;
	readonly keys: KeyProvider;
	readonly securityState: SecurityStateRuntime;
	readonly service: WebAuthnService;
	readonly alarms: SecurityStateAlarm[];
	close(): Promise<void>;
}

async function openBench(prefix: string, attestation?: WebAuthnAttestationConfig): Promise<Bench> {
	const { connection, schema } = await openMigratedSchema(prefix);
	const keys = testKeyProvider();
	const alarms: SecurityStateAlarm[] = [];
	const securityState = testSecurityState(connection, schema, keys, { alarms });
	const service = createWebAuthnService({
		driver: connection as Driver,
		schema,
		keys,
		webauthn: { ...TEST_WEBAUTHN_CONFIG, ...(attestation === undefined ? {} : { attestation }) },
		securityState,
	});
	return {
		connection,
		schema,
		keys,
		securityState,
		service,
		alarms,
		async close() {
			await dropSchema(connection, schema);
			await connection.close();
		},
	};
}

let authority: TestCertificateAuthority;
let stranger: TestCertificateAuthority;
let bench: Bench;
let everyAccount: Bench;
let withoutRoots: Bench;

beforeAll(async () => {
	authority = await createTestCertificateAuthority();
	stranger = await createTestCertificateAuthority({ organisation: "Somebody Else" });
	bench = await openBench("attest_service", { trustedRoots: [authority.rootPem] });
	everyAccount = await openBench("attest_every", {
		trustedRoots: [authority.rootDer],
		requestForEveryAccount: true,
	});
	withoutRoots = await openBench("attest_none");
}, 60_000);

afterAll(async () => {
	await bench.close();
	await everyAccount.close();
	await withoutRoots.close();
});

async function createAccount(on: Bench): Promise<Actor> {
	const [row] = await on.connection.query<{ id: string }>(
		`INSERT INTO ${on.schema}.user (email) VALUES ($1) RETURNING id`,
		[`${crypto.randomUUID()}@example.com`],
	);
	if (row === undefined) {
		throw new Error("the account was not created");
	}
	return actorOfTestUser(row.id);
}

async function packed(
	aaguid: string,
	from: TestCertificateAuthority = authority,
): Promise<AttestationKind> {
	return { kind: "packed", identity: await from.issue({ aaguid }) };
}

function authenticatorWith(aaguid: string, attestation: AttestationKind) {
	return createAttestingAuthenticator({
		relyingPartyId: RELYING_PARTY_ID,
		origin: ORIGIN,
		aaguid,
		attestation,
	});
}

async function register(on: Bench, actor: Actor, authenticator: VirtualAuthenticator) {
	const started = await on.service.register.start({ actor, userName: "someone" });
	const response = await authenticator.attest({ challenge: started.challengeToken });
	return on.service.register.finish({
		actor,
		challengeToken: started.challengeToken,
		response,
		label: "key",
	});
}

function limit(
	on: Bench,
	actor: Actor,
	allowlist: readonly string[] | null,
	allowNoUsableSignInMethod = false,
) {
	return setAuthenticatorAllowlist(on.securityState, {
		userId: actor,
		allowlist,
		allowNoUsableSignInMethod,
	});
}

async function signIn(on: Bench, authenticator: VirtualAuthenticator) {
	const started = await on.service.passkey.start();
	const response = await authenticator.assert({ challenge: started.challengeToken });
	return on.service.passkey.finish({ challengeToken: started.challengeToken, response });
}

async function secondFactor(on: Bench, actor: Actor, authenticator: VirtualAuthenticator) {
	const pending = await beginSecondFactor(
		{
			connection: on.connection,
			schema: on.schema,
			service: on.service,
			keys: on.keys,
			close: on.close,
		},
		actor,
	);
	const started = await on.service.authenticate.start({ pending });
	const response = await authenticator.assert({ challenge: started.challengeToken });
	return on.service.authenticate.finish({
		pending,
		challengeToken: started.challengeToken,
		response,
	});
}

async function failureOf(attempt: Promise<unknown>): Promise<{ reason: string; visible: string }> {
	try {
		await attempt;
	} catch (cause) {
		const visible = toVisibleFailure(cause).error.code;
		return { reason: cause instanceof ConcealedError ? cause.reason : String(visible), visible };
	}
	throw new Error("the attempt succeeded");
}

async function rowsOf(on: Bench, actor: Actor): Promise<number> {
	const [row] = await on.connection.query<{ total: number }>(
		`SELECT count(*)::integer AS total FROM ${on.schema}.webauthn_credential WHERE user_id = $1`,
		[actor],
	);
	return row?.total ?? -1;
}

describe("the attestation a registration asks for (S-INTEG-13)", () => {
	it("asks for none without a list and for direct attestation once the account has one", async () => {
		const actor = await createAccount(bench);
		const unlisted = await bench.service.register.start({ actor, userName: "someone" });
		expect(unlisted.publicKeyOptions.attestation).toBe("none");
		await limit(bench, actor, [ALLOWED], true);
		const listed = await bench.service.register.start({ actor, userName: "someone" });
		expect(listed.publicKeyOptions.attestation).toBe("direct");
	});

	it("asks every account for direct attestation where the application asks for it", async () => {
		const actor = await createAccount(everyAccount);
		const started = await everyAccount.service.register.start({ actor, userName: "someone" });
		expect(started.publicKeyOptions.attestation).toBe("direct");
	});

	it("asks for none without configured roots, whatever the account holds", async () => {
		const actor = await createAccount(withoutRoots);
		await limit(withoutRoots, actor, [ALLOWED], true);
		const started = await withoutRoots.service.register.start({ actor, userName: "someone" });
		expect(started.publicKeyOptions.attestation).toBe("none");
	});
});

describe("which attestation counts as verified (S-INTEG-13)", () => {
	it("records a full packed attestation that chains to a configured root, also through an intermediate", async () => {
		const actor = await createAccount(bench);
		const direct = await register(
			bench,
			actor,
			await authenticatorWith(ALLOWED, await packed(ALLOWED)),
		);
		const through = await register(
			bench,
			actor,
			await authenticatorWith(ALLOWED, {
				kind: "packed",
				identity: await authority.issue({ aaguid: ALLOWED, throughIntermediate: true }),
			}),
		);
		expect(direct.credential.attestationVerified).toBe(true);
		expect(direct.credential.aaguid).toBe(ALLOWED);
		expect(through.credential.attestationVerified).toBe(true);
	});

	it("records none, self, a foreign root and a missing root configuration as unverified", async () => {
		const actor = await createAccount(bench);
		const kinds: AttestationKind[] = [
			{ kind: "none" },
			{ kind: "self" },
			await packed(ALLOWED, stranger),
		];
		for (const kind of kinds) {
			const { credential } = await register(bench, actor, await authenticatorWith(ALLOWED, kind));
			expect(credential.attestationVerified).toBe(false);
		}
		const elsewhere = await createAccount(withoutRoots);
		const { credential } = await register(
			withoutRoots,
			elsewhere,
			await authenticatorWith(ALLOWED, await packed(ALLOWED)),
		);
		expect(credential.attestationVerified).toBe(false);
	});

	it("registers a chain naming a revocation list as unattested, never fetches it, and a list refuses it", async () => {
		const fetched = vi.spyOn(globalThis, "fetch");
		try {
			const naming = async () =>
				authenticatorWith(ALLOWED, {
					kind: "packed",
					identity: await authority.issue({
						aaguid: ALLOWED,
						revocationListUrl: "http://127.0.0.1:9/never.crl",
					}),
				});
			const actor = await createAccount(bench);
			const device = await naming();
			const { credential } = await register(bench, actor, device);
			expect(credential.attestationVerified).toBe(false);
			expect((await signIn(bench, device)).userId).toBe(actor);
			const listed = await createAccount(bench);
			await limit(bench, listed, [ALLOWED], true);
			expect(await failureOf(register(bench, listed, await naming()))).toEqual({
				reason: "authenticator_not_allowed",
				visible: "authenticator_not_allowed",
			});
			expect(await rowsOf(bench, listed)).toBe(0);
			expect(fetched).not.toHaveBeenCalled();
		} finally {
			fetched.mockRestore();
		}
	});
});

describe("registration under a list (S-INTEG-13)", () => {
	it("accepts a verified authenticator on the list and refuses every other with one code and no row", async () => {
		const actor = await createAccount(bench);
		await limit(bench, actor, [ALLOWED], true);
		const accepted = await register(
			bench,
			actor,
			await authenticatorWith(ALLOWED, await packed(ALLOWED)),
		);
		expect(accepted.credential.attestationVerified).toBe(true);
		const refused: AttestationKind[] = [
			await packed(OTHER),
			{ kind: "none" },
			{ kind: "self" },
			await packed(ALLOWED, stranger),
		];
		for (const [index, kind] of refused.entries()) {
			const aaguid = index === 0 ? OTHER : ALLOWED;
			const failure = await failureOf(
				register(bench, actor, await authenticatorWith(aaguid, kind)),
			);
			expect(failure).toEqual({
				reason: "authenticator_not_allowed",
				visible: "authenticator_not_allowed",
			});
		}
		expect(await rowsOf(bench, actor)).toBe(1);
	});
});

describe("sign-in under a list (S-INTEG-13)", () => {
	it("refuses a passkey outside the list at both sign-ins as an unknown one and moves no counter", async () => {
		const actor = await createAccount(bench);
		const outside = await authenticatorWith(OTHER, await packed(OTHER));
		const inside = await authenticatorWith(ALLOWED, await packed(ALLOWED));
		await register(bench, actor, outside);
		await register(bench, actor, inside);
		await limit(bench, actor, [ALLOWED]);
		const [before] = await bench.connection.query<{ sign_count: string }>(
			`SELECT sign_count::text FROM ${bench.schema}.webauthn_credential WHERE aaguid = $1 AND user_id = $2`,
			[OTHER, actor],
		);
		expect(await failureOf(signIn(bench, outside))).toEqual({
			reason: "authenticator_not_allowed_on_assertion",
			visible: "webauthn_credential_rejected",
		});
		expect(await failureOf(secondFactor(bench, actor, outside))).toEqual({
			reason: "authenticator_not_allowed_on_assertion",
			visible: "webauthn_credential_rejected",
		});
		const [after] = await bench.connection.query<{ sign_count: string }>(
			`SELECT sign_count::text FROM ${bench.schema}.webauthn_credential WHERE aaguid = $1 AND user_id = $2`,
			[OTHER, actor],
		);
		expect(after?.sign_count).toBe(before?.sign_count);
		expect((await signIn(bench, inside)).userId).toBe(actor);
		expect((await secondFactor(bench, actor, inside)).userId).toBe(actor);
		await limit(bench, actor, null);
		expect((await signIn(bench, outside)).userId).toBe(actor);
	});

	it("refuses a passkey that was registered without attestation once a list names its model", async () => {
		const actor = await createAccount(bench);
		const unattested = await authenticatorWith(ALLOWED, { kind: "none" });
		await register(bench, actor, unattested);
		await limit(bench, actor, [ALLOWED], true);
		expect((await failureOf(signIn(bench, unattested))).visible).toBe(
			"webauthn_credential_rejected",
		);
	});
});

describe("the last usable sign-in method (L-13)", () => {
	it("refuses a list no passkey of a passkey-only account satisfies unless the caller asks for it", async () => {
		const actor = await createAccount(bench);
		await register(bench, actor, await authenticatorWith(OTHER, await packed(OTHER)));
		await expect(limit(bench, actor, [ALLOWED])).rejects.toMatchObject({
			code: "last_sign_in_method",
		});
		await expect(limit(bench, actor, [ALLOWED], true)).resolves.toBeUndefined();
	});

	it("refuses removing the last passkey the list leaves usable and removes one outside it", async () => {
		const actor = await createAccount(bench);
		const inside = await register(
			bench,
			actor,
			await authenticatorWith(ALLOWED, await packed(ALLOWED)),
		);
		const outside = await register(
			bench,
			actor,
			await authenticatorWith(OTHER, await packed(OTHER)),
		);
		await limit(bench, actor, [ALLOWED]);
		const refused = bench.service.remove({ actor, credentialId: inside.credential.id });
		await expect(refused).rejects.toBeInstanceOf(VelveError);
		await expect(refused).rejects.toMatchObject({ code: "last_sign_in_method" });
		await bench.service.remove({ actor, credentialId: outside.credential.id });
		expect(await rowsOf(bench, actor)).toBe(1);
	});
});

describe("a writer without the root key (S-INTEG-13)", () => {
	async function listedAccount() {
		const actor = await createAccount(bench);
		const inside = await authenticatorWith(ALLOWED, await packed(ALLOWED));
		const outside = await authenticatorWith(OTHER, { kind: "none" });
		await register(bench, actor, inside);
		await register(bench, actor, outside);
		await limit(bench, actor, [ALLOWED]);
		return { actor, inside, outside };
	}

	function alarmsFor(actor: Actor): readonly SecurityStateAlarm[] {
		return bench.alarms.filter((alarm) => alarm.userId === actor);
	}

	const writes: readonly (readonly [string, (schema: string) => string])[] = [
		[
			"adds an aaguid to the list",
			(schema) =>
				`UPDATE ${schema}.user SET allowed_aaguids = allowed_aaguids || '${OTHER}'::uuid WHERE id = $1`,
		],
		[
			"removes the list",
			(schema) => `UPDATE ${schema}.user SET allowed_aaguids = NULL WHERE id = $1`,
		],
		[
			"flips a verified flag",
			(schema) =>
				`UPDATE ${schema}.webauthn_credential SET attestation_verified = true WHERE user_id = $1 AND aaguid = '${OTHER}'`,
		],
		[
			"moves a verified credential's aaguid",
			(schema) =>
				`UPDATE ${schema}.webauthn_credential SET aaguid = '${OTHER}' WHERE user_id = $1 AND attestation_verified`,
		],
	];

	for (const [what, statement] of writes) {
		it(`breaks the state and gains no sign-in where it ${what}`, async () => {
			const { actor, inside, outside } = await listedAccount();
			await bench.connection.query(statement(bench.schema), [actor]);
			expect((await failureOf(signIn(bench, outside))).visible).toBe(
				"webauthn_credential_rejected",
			);
			expect((await failureOf(signIn(bench, inside))).visible).toBe("webauthn_credential_rejected");
			expect(alarmsFor(actor).map((alarm) => alarm.reason)).toContain("seal_mismatch");
		});
	}
});
