import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { convertCertBufferToPEM, validateCertificatePath } from "@simplewebauthn/server/helpers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import type { Driver } from "../src/core/db/driver.js";
import type { WebAuthnAttestationConfig } from "../src/core/factor/webauthn/config.js";
import {
	createWebAuthnService,
	type WebAuthnService,
} from "../src/core/factor/webauthn/service.js";
import { ConcealedError, toVisibleFailure } from "../src/core/http/error-map.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { setAuthenticatorAllowlist } from "../src/core/security-state/authenticator-allowlist.js";
import { checkSecurityState, readSecurityState } from "../src/core/security-state/read.js";
import type { SecurityStateRuntime } from "../src/core/security-state/runtime.js";
import { testKeyProvider } from "./auth-fixtures.js";
import { openConnectionPool } from "./connection-pool-fixtures.js";
import { actorOfTestUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { testSecurityState } from "./security-state-fixtures.js";
import {
	type AttestationIdentity,
	type AttestationKind,
	createAttestingAuthenticator,
	createTestCertificateAuthority,
	type TestCertificateAuthority,
} from "./verified-attestation-fixtures.js";
import { ORIGIN, RELYING_PARTY_ID, TEST_WEBAUTHN_CONFIG } from "./webauthn-fixtures.js";
import type { VirtualAuthenticator } from "./webauthn-simulator.js";

/**
 * Reviewer's cases for S-INTEG-13 at the WebAuthn service, written against the requirement and
 * not against the writer's tests: no registration reaches the network whatever attestation format
 * the client claims (E-3844, the egress promise of E-1844), a chain that is expired, cut short or
 * names another model is never recorded as verified and never satisfies a list, a malformed or
 * oversized attestation object is refused as one ordinary rejection, and a list set beside a
 * removal or a registration on a pooled driver never leaves the account without a usable way in
 * or with a broken seal.
 */

const ALLOWED = "2fc0579f-8113-47ea-b116-bb5a8db9202a";
const OTHER = "cb69481e-8ff7-4039-93ec-0a2729a154a8";
const REVOCATION_LIST = "http://198.51.100.7/attacker-chosen.crl";

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
let bench: Bench;
let unconfigured: Bench;

beforeAll(async () => {
	authority = await createTestCertificateAuthority();
	bench = await openBench("attest_review_verifier", { trustedRoots: [authority.rootPem] });
	unconfigured = await openBench("attest_review_unconfigured");
}, 60_000);

afterAll(async () => {
	await bench.close();
	await unconfigured.close();
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

function authenticatorWith(aaguid: string, attestation: AttestationKind) {
	return createAttestingAuthenticator({
		relyingPartyId: RELYING_PARTY_ID,
		origin: ORIGIN,
		aaguid,
		attestation,
	});
}

function packedFrom(identity: AttestationIdentity): AttestationKind {
	return { kind: "packed", identity };
}

type Rewrite = (response: RegistrationResponseJSON) => RegistrationResponseJSON;

async function register(
	on: Bench,
	actor: Actor,
	authenticator: VirtualAuthenticator,
	rewrite: Rewrite = (response) => response,
) {
	const started = await on.service.register.start({ actor, userName: "someone" });
	const response = rewrite(await authenticator.attest({ challenge: started.challengeToken }));
	return on.service.register.finish({
		actor,
		challengeToken: started.challengeToken,
		response,
		label: "key",
	});
}

function limit(on: Bench, actor: Actor, allowlist: readonly string[] | null, override = false) {
	return setAuthenticatorAllowlist(on.securityState, {
		userId: actor,
		allowlist,
		allowNoUsableSignInMethod: override,
	});
}

async function outcomeOf(attempt: Promise<unknown>): Promise<string> {
	try {
		await attempt;
		return "resolved";
	} catch (cause) {
		return cause instanceof ConcealedError || cause instanceof Error
			? toVisibleFailure(cause).error.code
			: "thrown";
	}
}

async function rowsOf(on: Bench, actor: Actor): Promise<number> {
	const [row] = await on.connection.query<{ total: number }>(
		`SELECT count(*)::integer AS total FROM ${on.schema}.webauthn_credential WHERE user_id = $1`,
		[actor],
	);
	return row?.total ?? -1;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
	outer: for (let index = 0; index + needle.length <= haystack.length; index += 1) {
		for (let offset = 0; offset < needle.length; offset += 1) {
			if (haystack[index + offset] !== needle[offset]) {
				continue outer;
			}
		}
		return index;
	}
	return -1;
}

const FORMAT_ENTRY_NAMING_PACKED = Uint8Array.from([
	0x63, 0x66, 0x6d, 0x74, 0x66, 0x70, 0x61, 0x63, 0x6b, 0x65, 0x64,
]);
const FORMAT_ENTRY_NAMING_APPLE = Uint8Array.from([
	0x63, 0x66, 0x6d, 0x74, 0x65, 0x61, 0x70, 0x70, 0x6c, 0x65,
]);

/** the same attestation statement and chain, claimed under the format apple */
const claimedAsApple: Rewrite = (response) => {
	const object = Uint8Array.from(Buffer.from(response.response.attestationObject, "base64url"));
	const at = indexOfBytes(object, FORMAT_ENTRY_NAMING_PACKED);
	if (at < 0) {
		throw new Error("the attestation object names no packed format to rewrite");
	}
	const rewritten = new Uint8Array([
		...object.slice(0, at),
		...FORMAT_ENTRY_NAMING_APPLE,
		...object.slice(at + FORMAT_ENTRY_NAMING_PACKED.length),
	]);
	return {
		...response,
		response: {
			...response.response,
			attestationObject: Buffer.from(rewritten).toString("base64url"),
		},
	};
};

function withAttestationObject(bytes: Uint8Array): Rewrite {
	return (response) => ({
		...response,
		response: { ...response.response, attestationObject: Buffer.from(bytes).toString("base64url") },
	});
}

describe("no registration reaches the network (E-3844, E-1844)", () => {
	it("proves the fixture's distribution point is one the dependency would fetch", async () => {
		const fetched = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(() => Promise.reject(new Error("no network in a test")));
		try {
			const leaf = await authority.issue({ aaguid: ALLOWED, revocationListUrl: REVOCATION_LIST });
			await validateCertificatePath(
				leaf.chain.map((certificate) => convertCertBufferToPEM(Uint8Array.from(certificate))),
				[authority.rootPem],
			).catch(() => undefined);
			expect(fetched.mock.calls.map(([url]) => String(url))).toContain(REVOCATION_LIST);
		} finally {
			fetched.mockRestore();
		}
	});

	for (const [where, on] of [
		["with roots configured", () => bench],
		["without webauthn.attestation", () => unconfigured],
	] as const) {
		it(`fetches nothing when a chain naming a revocation list is claimed as apple, ${where}`, async () => {
			const fetched = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(() => Promise.reject(new Error("no network in a test")));
			try {
				const actor = await createAccount(on());
				const leaf = await authority.issue({ aaguid: ALLOWED, revocationListUrl: REVOCATION_LIST });
				const outcome = await outcomeOf(
					register(on(), actor, await authenticatorWith(ALLOWED, packedFrom(leaf)), claimedAsApple),
				);
				expect(outcome).toBe("webauthn_credential_rejected");
				expect(fetched.mock.calls.map(([url]) => String(url))).toStrictEqual([]);
			} finally {
				fetched.mockRestore();
			}
		});
	}
});

describe("a chain that does not verify (S-INTEG-13)", () => {
	it("refuses a leaf whose AAGUID extension names another model than the authenticator data", async () => {
		const actor = await createAccount(bench);
		const leaf = await authority.issue({ aaguid: OTHER });
		expect(
			await outcomeOf(register(bench, actor, await authenticatorWith(ALLOWED, packedFrom(leaf)))),
		).toBe("webauthn_credential_rejected");
		expect(await rowsOf(bench, actor)).toBe(0);
	});

	it("refuses an expired leaf and a chain that is only an intermediate", async () => {
		const actor = await createAccount(bench);
		const expired = await authority.issue({ aaguid: ALLOWED, expired: true });
		const through = await authority.issue({ aaguid: ALLOWED, throughIntermediate: true });
		const intermediateOnly: AttestationIdentity = {
			key: through.key,
			chain: through.chain.slice(1),
		};
		for (const identity of [expired, intermediateOnly]) {
			expect(
				await outcomeOf(
					register(bench, actor, await authenticatorWith(ALLOWED, packedFrom(identity))),
				),
			).toBe("webauthn_credential_rejected");
		}
		expect(await rowsOf(bench, actor)).toBe(0);
	});

	it("records a leaf whose intermediate the chain leaves out as unverified, and a list refuses it", async () => {
		const actor = await createAccount(bench);
		const through = await authority.issue({ aaguid: ALLOWED, throughIntermediate: true });
		const leafAlone: AttestationIdentity = { key: through.key, chain: through.chain.slice(0, 1) };
		const { credential } = await register(
			bench,
			actor,
			await authenticatorWith(ALLOWED, packedFrom(leafAlone)),
		);
		expect(credential.attestationVerified).toBe(false);

		const listed = await createAccount(bench);
		await limit(bench, listed, [ALLOWED], true);
		const again = await authority.issue({ aaguid: ALLOWED, throughIntermediate: true });
		expect(
			await outcomeOf(
				register(
					bench,
					listed,
					await authenticatorWith(
						ALLOWED,
						packedFrom({ key: again.key, chain: again.chain.slice(0, 1) }),
					),
				),
			),
		).toBe("authenticator_not_allowed");
		expect(await rowsOf(bench, listed)).toBe(0);
	});

	it("never counts a chain that repeats its intermediate hundreds of times, and answers promptly", async () => {
		const actor = await createAccount(bench);
		const through = await authority.issue({ aaguid: ALLOWED, throughIntermediate: true });
		const [leaf, intermediate] = through.chain;
		if (leaf === undefined || intermediate === undefined) {
			throw new Error("the authority issued no intermediate");
		}
		const padded: AttestationIdentity = {
			key: through.key,
			chain: [leaf, ...Array.from({ length: 300 }, () => intermediate)],
		};
		const began = performance.now();
		const outcome = await outcomeOf(
			register(bench, actor, await authenticatorWith(ALLOWED, packedFrom(padded))),
		);
		expect(performance.now() - began).toBeLessThan(10_000);
		if (outcome === "resolved") {
			const [row] = await bench.connection.query<{ verified: boolean }>(
				`SELECT attestation_verified AS verified FROM ${bench.schema}.webauthn_credential WHERE user_id = $1`,
				[actor],
			);
			expect(row?.verified).toBe(false);
		} else {
			expect(outcome).toBe("webauthn_credential_rejected");
		}
	}, 30_000);
});

describe("a malformed or oversized attestation object (S-INTEG-13)", () => {
	const objects: readonly (readonly [string, () => Uint8Array])[] = [
		["random bytes", () => new Uint8Array(crypto.getRandomValues(new Uint8Array(4096)))],
		["half a megabyte of zeros", () => new Uint8Array(512 * 1024)],
		["arrays nested a hundred thousand deep", () => new Uint8Array(100_000).fill(0x81)],
		[
			"a map that announces more entries than it holds",
			() => Uint8Array.of(0xbb, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
		],
	];

	for (const [what, bytes] of objects) {
		it(`refuses ${what} as an ordinary rejection without a row`, async () => {
			const actor = await createAccount(bench);
			await limit(bench, actor, [ALLOWED], true);
			const began = performance.now();
			const outcome = await outcomeOf(
				register(
					bench,
					actor,
					await authenticatorWith(ALLOWED, { kind: "none" }),
					withAttestationObject(bytes()),
				),
			);
			expect(performance.now() - began).toBeLessThan(10_000);
			expect(outcome).toBe("webauthn_credential_rejected");
			expect(await rowsOf(bench, actor)).toBe(0);
		}, 30_000);
	}
});

describe("a list set beside a removal or a registration on a pooled driver (S-INTEG-13, L-13)", () => {
	const ROUNDS = 6;
	let pool: Awaited<ReturnType<typeof openConnectionPool>>;
	let pooled: Bench;

	beforeAll(async () => {
		pool = await openConnectionPool(6);
		const keys = bench.keys;
		const alarms: SecurityStateAlarm[] = [];
		const securityState = testSecurityState(pool, bench.schema, keys, { alarms });
		pooled = {
			connection: bench.connection,
			schema: bench.schema,
			keys,
			securityState,
			alarms,
			service: createWebAuthnService({
				driver: pool,
				schema: bench.schema,
				keys,
				webauthn: { ...TEST_WEBAUTHN_CONFIG, attestation: { trustedRoots: [authority.rootPem] } },
				securityState,
			}),
			close: () => pool.close(),
		};
	}, 60_000);

	afterAll(async () => {
		await pool.close();
	});

	async function sealVerdictOf(actor: Actor): Promise<string> {
		const read = await readSecurityState(bench.connection, bench.schema, actor);
		if (read === null) {
			return "missing";
		}
		return (await checkSecurityState(bench.keys, read, "migrating")).verdict;
	}

	it("never ends with the list set and the last passkey that satisfies it removed", async () => {
		for (let round = 0; round < ROUNDS; round += 1) {
			const actor = await createAccount(pooled);
			const inside = await register(
				pooled,
				actor,
				await authenticatorWith(ALLOWED, packedFrom(await authority.issue({ aaguid: ALLOWED }))),
			);
			await register(pooled, actor, await authenticatorWith(OTHER, { kind: "none" }));
			const [limited, removed] = await Promise.all([
				outcomeOf(limit(pooled, actor, [ALLOWED])),
				outcomeOf(pooled.service.remove({ actor, credentialId: inside.credential.id })),
			]);
			const both = limited === "resolved" && removed === "resolved";
			expect(both, `round ${round}: ${limited} / ${removed}`).toBe(false);
			expect([limited, removed]).toContain("last_sign_in_method");
			expect(await sealVerdictOf(actor)).toBe("valid");
		}
		expect(pooled.alarms).toStrictEqual([]);
	}, 60_000);

	it("leaves a valid seal and refuses an unverified registration once the list has committed", async () => {
		for (let round = 0; round < ROUNDS; round += 1) {
			const actor = await createAccount(pooled);
			await register(
				pooled,
				actor,
				await authenticatorWith(ALLOWED, packedFrom(await authority.issue({ aaguid: ALLOWED }))),
			);
			const [limited, registered] = await Promise.all([
				outcomeOf(limit(pooled, actor, [ALLOWED])),
				outcomeOf(register(pooled, actor, await authenticatorWith(OTHER, { kind: "none" }))),
			]);
			expect(limited).toBe("resolved");
			expect(["resolved", "authenticator_not_allowed"]).toContain(registered);
			expect(await sealVerdictOf(actor)).toBe("valid");
			expect(
				await outcomeOf(register(pooled, actor, await authenticatorWith(OTHER, { kind: "none" }))),
			).toBe("authenticator_not_allowed");
		}
		expect(pooled.alarms).toStrictEqual([]);
	}, 60_000);
});
