import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VelveError } from "../src/core/http/error-map.js";
import { TEST_ORIGIN } from "./auth-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import {
	countOf,
	errorCodeOf,
	finishRecovery,
	generateCodes,
	mailedRecoveryLink,
	newAuthenticator,
	openRecoveryBench,
	type RecoveryBench,
	registerPasskey,
	sessionResolves,
	signInWithPassword,
	signUp,
	startedRecovery,
	withSession,
} from "./passkey-recovery-fixtures.js";

/**
 * Review of S-DEFAULT-8 against the requirement of change 7, over every way a WebAuthn credential
 * reaches a row: the registration in a session over HTTP and as a direct server call, and the
 * registration that ends a recovery to a new passkey. Each odd-shaped `credProps` a client or a
 * caller can send is refused, a refusal leaves the credential table, the held recovery passkey
 * and the seal as they were and spends no more than the ceremony's challenge, a forged
 * attestation never learns the discoverable check exists, and with the switch off the options
 * and the outcome are those of a registration that never heard of it.
 */

let on: RecoveryBench;
let off: RecoveryBench;

const RELYING_PARTY = {
	relyingPartyId: "app.example.com",
	relyingPartyName: "Velve Auth tests",
	origins: [TEST_ORIGIN],
	userVerification: "required",
} as const;

beforeAll(async () => {
	on = await openRecoveryBench("discoverable_review_on", {
		webauthn: {
			...RELYING_PARTY,
			requireDiscoverableCredential: true,
			recovery: { waitingPeriodInSeconds: () => on.waitingPeriod as number },
		},
	});
	off = await openRecoveryBench("discoverable_review_off", {
		webauthn: {
			...RELYING_PARTY,
			recovery: { waitingPeriodInSeconds: () => off.waitingPeriod as number },
		},
	});
}, 60_000);

afterAll(async () => {
	await on.close();
	await off.close();
});

//a key named __proto__ is an own property only when JSON.parse creates it, as a request body does
const OWN_PROTO_RESULTS = JSON.parse('{"__proto__":{"credProps":{"rk":true}}}') as unknown;
const OWN_PROTO_CREDPROPS = JSON.parse('{"credProps":{"__proto__":{"rk":true}}}') as unknown;

const ABSENT = Symbol("absent");

const ODD_REPORTS: readonly (readonly [string, unknown])[] = [
	["rk false", { credProps: { rk: false } }],
	["rk the string true", { credProps: { rk: "true" } }],
	["rk the number 1", { credProps: { rk: 1 } }],
	["rk null", { credProps: { rk: null } }],
	["rk an array holding true", { credProps: { rk: [true] } }],
	["rk an object", { credProps: { rk: {} } }],
	["credProps empty", { credProps: {} }],
	["credProps null", { credProps: null }],
	["credProps true", { credProps: true }],
	["credProps a string", { credProps: "rk" }],
	["credProps an array holding rk", { credProps: [{ rk: true }] }],
	["credProps under another spelling", { CredProps: { rk: true } }],
	["no credProps", {}],
	["extension results null", null],
	["extension results an array", [{ credProps: { rk: true } }]],
	["extension results a string", "credProps"],
	["extension results absent", ABSENT],
	["credProps behind an own __proto__ key", OWN_PROTO_RESULTS],
	["rk behind an own __proto__ key", OWN_PROTO_CREDPROPS],
];

function reporting(
	response: RegistrationResponseJSON,
	results: unknown,
): RegistrationResponseJSON | Record<string, unknown> {
	const { clientExtensionResults: _replaced, ...rest } = response;
	return results === ABSENT ? rest : { ...rest, clientExtensionResults: results };
}

function discoverable(response: RegistrationResponseJSON): RegistrationResponseJSON {
	return { ...response, clientExtensionResults: { credProps: { rk: true } } };
}

interface SealSnapshot {
	readonly row: string;
}

async function sealOf(bench: RecoveryBench, userId: string): Promise<SealSnapshot> {
	const [row] = await bench.migrated.connection.query<{ row: string }>(
		`SELECT row_to_json(s)::text AS row FROM ${bench.migrated.schema}.security_state s WHERE user_id = $1`,
		[userId],
	);
	return { row: row?.row ?? "" };
}

async function registrationStarted(bench: RecoveryBench, sessionToken: string) {
	const answer = await bench.handler(
		postTo("/factor/webauthn/register/start", {}, withSession(sessionToken)),
	);
	expect(answer.status).toBe(200);
	return (await answer.json()) as {
		challengeToken: string;
		publicKeyOptions: Record<string, unknown>;
	};
}

function registrationFinished(
	bench: RecoveryBench,
	sessionToken: string,
	challengeToken: string,
	response: unknown,
): Promise<Response> {
	return bench.handler(
		postTo(
			"/factor/webauthn/register/finish",
			{ challengeToken, response, label: "a key" },
			withSession(sessionToken),
		),
	);
}

describe("a registration in a session with the switch on (S-DEFAULT-8)", () => {
	it.each(ODD_REPORTS)(
		"refuses %s with the one stable code, stores nothing and spends only the challenge",
		async (_label, results) => {
			const account = await signUp(on);
			const sealBefore = await sealOf(on, account.userId);
			const authenticator = await newAuthenticator();
			const started = await registrationStarted(on, account.sessionToken);
			const attested = await authenticator.attest({ challenge: started.challengeToken });

			const refused = await registrationFinished(
				on,
				account.sessionToken,
				started.challengeToken,
				reporting(attested, results),
			);

			expect(refused.status).toBe(400);
			expect(await refused.json()).toStrictEqual({
				error: {
					code: "webauthn_credential_not_discoverable",
					message: "The authenticator did not report a discoverable credential.",
				},
			});
			expect(await countOf(on, "webauthn_credential", account.userId)).toBe(0);
			expect(await sealOf(on, account.userId)).toStrictEqual(sealBefore);

			const replayed = await registrationFinished(
				on,
				account.sessionToken,
				started.challengeToken,
				discoverable(attested),
			);
			expect([replayed.status, await errorCodeOf(replayed)]).toStrictEqual([
				400,
				"webauthn_challenge_invalid",
			]);
			expect(await sessionResolves(on, account.sessionToken)).toBe(true);

			const again = await registrationStarted(on, account.sessionToken);
			const accepted = await registrationFinished(
				on,
				account.sessionToken,
				again.challengeToken,
				discoverable(await authenticator.attest({ challenge: again.challengeToken })),
			);
			expect(accepted.status).toBe(200);
			expect(await countOf(on, "webauthn_credential", account.userId)).toBe(1);
		},
	);

	it("answers a forged attestation that reports no discoverable credential as a rejected one", async () => {
		const account = await signUp(on);
		const authenticator = await newAuthenticator();
		const started = await registrationStarted(on, account.sessionToken);
		const forged = await authenticator.attest({ challenge: "a-challenge-nobody-issued" });

		const refused = await registrationFinished(
			on,
			account.sessionToken,
			started.challengeToken,
			reporting(forged, { credProps: { rk: false } }),
		);

		expect([refused.status, await errorCodeOf(refused)]).toStrictEqual([
			401,
			"webauthn_credential_rejected",
		]);
		expect(await countOf(on, "webauthn_credential", account.userId)).toBe(0);
	});

	it("refuses an attestation without user verification that reports rk, and stores nothing", async () => {
		const account = await signUp(on);
		const sealBefore = await sealOf(on, account.userId);
		const authenticator = await newAuthenticator();
		const started = await registrationStarted(on, account.sessionToken);
		const attested = await authenticator.attest({
			challenge: started.challengeToken,
			flags: { userVerified: false, backupEligible: true, backupState: true },
		});

		const refused = await registrationFinished(
			on,
			account.sessionToken,
			started.challengeToken,
			discoverable(attested),
		);

		expect([refused.status, await errorCodeOf(refused)]).toStrictEqual([
			401,
			"webauthn_credential_rejected",
		]);
		expect(await countOf(on, "webauthn_credential", account.userId)).toBe(0);
		expect(await sealOf(on, account.userId)).toStrictEqual(sealBefore);
	});

	it("does not take an rk a polluted Object.prototype answers for", async () => {
		const account = await signUp(on);
		const authenticator = await newAuthenticator();
		const started = await registrationStarted(on, account.sessionToken);
		const attested = await authenticator.attest({ challenge: started.challengeToken });
		const body = JSON.stringify({
			challengeToken: started.challengeToken,
			response: { ...attested, clientExtensionResults: {} },
			label: "a key",
		});

		Object.defineProperty(Object.prototype, "credProps", {
			value: { rk: true },
			configurable: true,
			enumerable: false,
			writable: true,
		});
		let refused: Response;
		try {
			refused = await on.handler(
				new Request("https://api.example.com/factor/webauthn/register/finish", {
					method: "POST",
					headers: {
						Origin: TEST_ORIGIN,
						"Content-Type": "application/json",
						...withSession(account.sessionToken),
					},
					body,
				}),
			);
		} finally {
			delete (Object.prototype as Record<string, unknown>).credProps;
		}

		expect([refused.status, await errorCodeOf(refused)]).toStrictEqual([
			400,
			"webauthn_credential_not_discoverable",
		]);
		expect(await countOf(on, "webauthn_credential", account.userId)).toBe(0);
	});
});

describe("a registration in a session as a direct server call with the switch on (S-DEFAULT-8)", () => {
	async function directFinish(
		sessionToken: string,
		challengeToken: string,
		response: Record<string, unknown>,
	): Promise<unknown> {
		try {
			await on.auth.factor.webauthn.register.finish({
				challengeToken,
				response: response as never,
				label: "a key",
				origin: TEST_ORIGIN,
				sessionToken,
			});
			return "accepted";
		} catch (cause) {
			return cause instanceof VelveError ? cause.code : cause;
		}
	}

	it("refuses an inherited rk and an inherited credProps a caller can only build in code", async () => {
		const account = await signUp(on);
		const authenticator = await newAuthenticator();
		const answers: unknown[] = [];
		for (const results of [
			{ credProps: Object.create({ rk: true }) as unknown },
			Object.create({ credProps: { rk: true } }) as unknown,
		]) {
			const started = await on.auth.factor.webauthn.register.start({
				origin: TEST_ORIGIN,
				sessionToken: account.sessionToken,
			});
			const attested = await authenticator.attest({ challenge: started.challengeToken });
			answers.push(
				await directFinish(account.sessionToken, started.challengeToken, {
					...attested,
					clientExtensionResults: results,
				}),
			);
		}

		expect(answers).toStrictEqual([
			"webauthn_credential_not_discoverable",
			"webauthn_credential_not_discoverable",
		]);
		expect(await countOf(on, "webauthn_credential", account.userId)).toBe(0);
	});

	it("stores nothing when reading the report throws", async () => {
		const account = await signUp(on);
		const authenticator = await newAuthenticator();
		const started = await on.auth.factor.webauthn.register.start({
			origin: TEST_ORIGIN,
			sessionToken: account.sessionToken,
		});
		const attested = await authenticator.attest({ challenge: started.challengeToken });
		const credProps = {};
		Object.defineProperty(credProps, "rk", {
			enumerable: true,
			get: () => {
				throw new Error("a getter that refuses to be read");
			},
		});

		const answer = await directFinish(account.sessionToken, started.challengeToken, {
			...attested,
			clientExtensionResults: { credProps },
		});

		expect(answer).not.toBe("accepted");
		expect(await countOf(on, "webauthn_credential", account.userId)).toBe(0);
	});
});

interface RecoveryUnderway {
	readonly userId: string;
	readonly email: string;
	readonly sessionToken: string;
	readonly challengeToken: string;
	readonly publicKeyOptions: Record<string, unknown>;
}

async function recoveryUnderway(bench: RecoveryBench): Promise<RecoveryUnderway> {
	const account = await signUp(bench);
	await registerDiscoverablePasskey(bench, account.sessionToken);
	const codes = await generateCodes(bench, account);
	const token = await mailedRecoveryLink(bench, account.email);
	const started = await startedRecovery(bench, token, codes[0] ?? "");
	return {
		userId: account.userId,
		email: account.email,
		sessionToken: account.sessionToken,
		challengeToken: started.challengeToken,
		publicKeyOptions: started.publicKeyOptions as Record<string, unknown>,
	};
}

async function registerDiscoverablePasskey(
	bench: RecoveryBench,
	sessionToken: string,
): Promise<void> {
	const authenticator = await newAuthenticator();
	const started = await registrationStarted(bench, sessionToken);
	const finished = await registrationFinished(
		bench,
		sessionToken,
		started.challengeToken,
		discoverable(await authenticator.attest({ challenge: started.challengeToken })),
	);
	expect(finished.status).toBe(200);
}

const RECOVERY_REPORTS = ODD_REPORTS.filter(([label]) =>
	[
		"rk false",
		"rk the string true",
		"credProps null",
		"extension results an array",
		"extension results absent",
		"credProps behind an own __proto__ key",
	].includes(label),
);

describe("the registration that ends a recovery with the switch on (S-DEFAULT-8, S-ENUM-10)", () => {
	it.each(RECOVERY_REPORTS)(
		"answers %s as an unknown challenge and leaves the account as the start left it",
		async (_label, results) => {
			on.waitingPeriod = 3600;
			const underway = await recoveryUnderway(on);
			const sealBefore = await sealOf(on, underway.userId);
			const passkeysBefore = await countOf(on, "webauthn_credential", underway.userId);
			const sessionsBefore = await countOf(on, "session", underway.userId);
			const codesBefore = await countOf(on, "recovery_code", underway.userId);
			const authenticator = await newAuthenticator();
			const attested = await authenticator.attest({ challenge: underway.challengeToken });

			const refused = await finishRecovery(
				on,
				underway.challengeToken,
				reporting(attested, results),
			);
			const unknown = await finishRecovery(on, "an-unknown-challenge", discoverable(attested));

			expect(refused.status).toBe(400);
			expect(refused.headers.get("content-type")).toBe(unknown.headers.get("content-type"));
			expect(await refused.text()).toBe(await unknown.text());
			expect(await countOf(on, "passkey_recovery", underway.userId)).toBe(0);
			expect(await countOf(on, "webauthn_credential", underway.userId)).toBe(passkeysBefore);
			expect(await countOf(on, "session", underway.userId)).toBe(sessionsBefore);
			expect(await countOf(on, "recovery_code", underway.userId)).toBe(codesBefore);
			expect(await sealOf(on, underway.userId)).toStrictEqual(sealBefore);
			expect(on.started.filter((event) => event.userId === underway.userId)).toStrictEqual([]);
			expect(on.revoked.filter((event) => event.userId === underway.userId)).toStrictEqual([]);
		},
	);

	it("leaves every way in standing when a recovery without a waiting period is refused", async () => {
		on.waitingPeriod = 0;
		try {
			const underway = await recoveryUnderway(on);
			const authenticator = await newAuthenticator();
			const attested = await authenticator.attest({ challenge: underway.challengeToken });

			const refused = await finishRecovery(
				on,
				underway.challengeToken,
				reporting(attested, { credProps: { rk: false } }),
			);

			expect([refused.status, await errorCodeOf(refused)]).toStrictEqual([
				400,
				"passkey_recovery_failed",
			]);
			expect(await countOf(on, "webauthn_credential", underway.userId)).toBe(1);
			expect(await sessionResolves(on, underway.sessionToken)).toBe(true);
			expect((await signInWithPassword(on, underway.email)).status).toBe(200);
		} finally {
			on.waitingPeriod = 3600;
		}
	});
});

function comparableOptions(options: Record<string, unknown>): Record<string, unknown> {
	const { challenge: _challenge, user: _user, excludeCredentials, ...rest } = options;
	return { ...rest, excludeCredentialCount: (excludeCredentials as unknown[] | undefined)?.length };
}

describe("the switch left off (S-DEFAULT-8)", () => {
	it("asks a session registration and a recovery registration for exactly what the switch on asks for", async () => {
		const onAccount = await signUp(on);
		const offAccount = await signUp(off);
		const onStarted = await registrationStarted(on, onAccount.sessionToken);
		const offStarted = await registrationStarted(off, offAccount.sessionToken);
		on.waitingPeriod = 3600;
		off.waitingPeriod = 3600;
		const onRecovery = await recoveryUnderway(on);
		const offRecovery = await recoveryUnderway(off);

		expect(comparableOptions(offStarted.publicKeyOptions)).toStrictEqual(
			comparableOptions(onStarted.publicKeyOptions),
		);
		expect(comparableOptions(offRecovery.publicKeyOptions)).toStrictEqual(
			comparableOptions(onRecovery.publicKeyOptions),
		);
		expect(onStarted.publicKeyOptions).toMatchObject({
			authenticatorSelection: { residentKey: "required", userVerification: "required" },
			extensions: { credProps: true },
		});
		expect(onRecovery.publicKeyOptions).toMatchObject({
			authenticatorSelection: { residentKey: "required", userVerification: "required" },
			extensions: { credProps: true },
		});
	});

	it.each([
		["rk false", { credProps: { rk: false } }],
		["extension results absent", ABSENT],
		["rk the string true", { credProps: { rk: "true" } }],
	] as const)("accepts a session registration that reports %s", async (_label, results) => {
		const account = await signUp(off);
		const authenticator = await newAuthenticator();
		const started = await registrationStarted(off, account.sessionToken);
		const attested = await authenticator.attest({ challenge: started.challengeToken });

		const finished = await registrationFinished(
			off,
			account.sessionToken,
			started.challengeToken,
			reporting(attested, results),
		);

		expect(finished.status).toBe(200);
		expect(await countOf(off, "webauthn_credential", account.userId)).toBe(1);
	});

	it("accepts a recovery registration that reports no discoverable credential", async () => {
		off.waitingPeriod = 3600;
		const underway = await recoveryUnderway(off);
		const authenticator = await newAuthenticator();
		const attested = await authenticator.attest({ challenge: underway.challengeToken });

		const finished = await finishRecovery(
			off,
			underway.challengeToken,
			reporting(attested, { credProps: { rk: false } }),
		);

		expect(finished.status).toBe(200);
		expect(await countOf(off, "passkey_recovery", underway.userId)).toBe(1);
	});

	it("still registers through the fixtures every other suite uses, which send empty results", async () => {
		const account = await signUp(off);

		await expect(registerPasskey(off, account)).resolves.toBeDefined();
	});
});
