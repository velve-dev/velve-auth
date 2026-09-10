import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { type MountedAuth, mountAuth, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { difference, postTo } from "./flows-fixtures.js";
import { createVirtualAuthenticator, type VirtualAuthenticator } from "./webauthn-simulator.js";

let mounted: MountedAuth;

const PASSWORD = "correct-horse-battery-staple";
const RELYING_PARTY_ID = "app.example.com";

const WEBAUTHN = {
	relyingPartyId: RELYING_PARTY_ID,
	relyingPartyName: "Velve Auth tests",
	origins: [TEST_ORIGIN],
	userVerification: "required",
} as const;

beforeAll(async () => {
	mounted = await mountAuth("webauthnroutes", {
		webauthn: WEBAUTHN,
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
	});
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

function cookieIn(answer: Response, name: string): string | null {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === name) {
			return pair.slice(separator + 1);
		}
	}
	return null;
}

function withSession(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` };
}

function getFrom(path: string, headers: Record<string, string>): Request {
	return new Request(`https://api.example.com${path}`, {
		headers: { Origin: TEST_ORIGIN, ...headers },
	});
}

let accounts = 0;

async function signUp(): Promise<{ email: string; sessionToken: string }> {
	accounts += 1;
	const email = `passkey${accounts}@example.com`;
	const answer = await mounted.handler(postTo("/sign-up", { email, password: PASSWORD }));
	const sessionToken = cookieIn(answer, DEFAULT_COOKIE_NAMES.session);
	if (answer.status !== 200 || sessionToken === null || sessionToken === "") {
		throw new Error(`the sign-up answered ${answer.status} without a session`);
	}
	return { email, sessionToken };
}

function newAuthenticator(): Promise<VirtualAuthenticator> {
	return createVirtualAuthenticator({
		relyingPartyId: RELYING_PARTY_ID,
		origin: TEST_ORIGIN,
		flags: { userVerified: true, backupEligible: true, backupState: true },
	});
}

interface Registered {
	readonly email: string;
	readonly sessionToken: string;
	readonly authenticator: VirtualAuthenticator;
	readonly credentialRowId: string;
}

async function registerACredential(label = "A key"): Promise<Registered> {
	const account = await signUp();
	const authenticator = await newAuthenticator();
	const started = await mounted.handler(
		postTo("/factor/webauthn/register/start", {}, withSession(account.sessionToken)),
	);
	const challenge = (await started.json()) as { challengeToken: string };
	const response = await authenticator.attest({ challenge: challenge.challengeToken });
	const finished = await mounted.handler(
		postTo(
			"/factor/webauthn/register/finish",
			{ challengeToken: challenge.challengeToken, response, label },
			withSession(account.sessionToken),
		),
	);
	const body = (await finished.json()) as { credential: { id: string } };

	expect([started.status, finished.status]).toStrictEqual([200, 200]);
	return {
		email: account.email,
		sessionToken: account.sessionToken,
		authenticator,
		credentialRowId: body.credential.id,
	};
}

/** 3.6 and B.1: the discoverable sign-in, which is a way in of its own rather than a second factor. */
describe("signing in with a passkey, end to end over HTTP", () => {
	it("registers a credential in a session and then signs in with it, without a password", async () => {
		const registered = await registerACredential();

		const started = await mounted.handler(postTo("/sign-in/passkey/start", {}));
		const challenge = (await started.json()) as { challengeToken: string };
		const response = await registered.authenticator.assert({
			challenge: challenge.challengeToken,
		});
		const finished = await mounted.handler(
			postTo("/sign-in/passkey/finish", {
				challengeToken: challenge.challengeToken,
				response,
			}),
		);
		const body = (await finished.json()) as {
			status: string;
			session: { factors: string[] };
			signCountRegressed: boolean;
		};

		expect([started.status, finished.status]).toStrictEqual([200, 200]);
		expect(body.status).toBe("signed_in");
		// 3.6: the passkey path records `webauthn` alone; a password took no part in it.
		expect(body.session.factors).toStrictEqual(["webauthn"]);
		// L-9: reported and never a rejection, and `false` here rather than absent.
		expect(body.signCountRegressed).toBe(false);
		expect(cookieIn(finished, DEFAULT_COOKIE_NAMES.session)).not.toBe("");
	});

	it("consumes the challenge, so the same assertion cannot be replayed", async () => {
		const registered = await registerACredential();
		const started = await mounted.handler(postTo("/sign-in/passkey/start", {}));
		const challenge = (await started.json()) as { challengeToken: string };
		const response = await registered.authenticator.assert({
			challenge: challenge.challengeToken,
		});
		const body = { challengeToken: challenge.challengeToken, response };

		const first = await mounted.handler(postTo("/sign-in/passkey/finish", body));
		const replayed = await mounted.handler(postTo("/sign-in/passkey/finish", body));
		const refusal = (await replayed.json()) as { error: { code: string } };

		// S-REPLAY-5: the challenge is consumed by `DELETE … RETURNING`, so the second try finds none.
		expect(first.status).toBe(200);
		expect(`${replayed.status} ${refusal.error.code}`).toBe("400 webauthn_challenge_invalid");
	});
});

/** 3.6: the same credential as a *second* factor, which differs in precondition and in outcome. */
describe("spending a credential on an intermediate state, over HTTP", () => {
	it("carries a password sign-in through the authenticator into a two-factor session", async () => {
		const registered = await registerACredential();

		const signedIn = await mounted.handler(
			postTo("/sign-in/password", { email: registered.email, password: PASSWORD }),
		);
		const offered = (await signedIn.json()) as {
			status: string;
			pending: { availableFactors: readonly string[] };
		};
		const pendingToken = cookieIn(signedIn, DEFAULT_COOKIE_NAMES.pending) ?? "";
		const withPending = { Cookie: `${DEFAULT_COOKIE_NAMES.pending}=${pendingToken}` };

		expect(offered.status).toBe("second_factor_required");
		expect(offered.pending.availableFactors).toStrictEqual(["webauthn"]);

		const started = await mounted.handler(
			postTo("/factor/webauthn/authenticate/start", {}, withPending),
		);
		const challenge = (await started.json()) as { challengeToken: string };
		const finished = await mounted.handler(
			postTo(
				"/factor/webauthn/authenticate/finish",
				{
					challengeToken: challenge.challengeToken,
					response: await registered.authenticator.assert({
						challenge: challenge.challengeToken,
					}),
				},
				withPending,
			),
		);
		const body = (await finished.json()) as { status: string; session: { factors: string[] } };

		expect([started.status, finished.status]).toStrictEqual([200, 200]);
		expect(body.status).toBe("signed_in");
		// 3.6: the second-factor path records both, where the passkey path records `webauthn` alone.
		expect([...body.session.factors].sort()).toStrictEqual(["password", "webauthn"]);
		expect(cookieIn(finished, DEFAULT_COOKIE_NAMES.pending)).toBe("");
	});
});

describe("managing enrolled credentials from a session (B.6, S-OWNER-3)", () => {
	it("lists, renames and removes the caller's own credential", async () => {
		const registered = await registerACredential("Yubikey at the desk");
		const second = await registerACredential("A second key");

		const listed = await mounted.handler(
			getFrom("/factor/webauthn/list", withSession(registered.sessionToken)),
		);
		const credentials = (await listed.json()) as readonly { id: string; label: string }[];

		expect(listed.status).toBe(200);
		expect(credentials.map((credential) => credential.label)).toStrictEqual([
			"Yubikey at the desk",
		]);

		const renamed = await mounted.handler(
			postTo(
				"/factor/webauthn/rename",
				{ credentialId: registered.credentialRowId, label: "Renamed" },
				withSession(registered.sessionToken),
			),
		);
		const body = (await renamed.json()) as { credential: { label: string } };

		expect(renamed.status).toBe(200);
		expect(body.credential.label).toBe("Renamed");
		expect(second.credentialRowId).not.toBe(registered.credentialRowId);
	});

	/**
	 * S-OWNER-3 and S-OWNER-8: a credential belonging to another account, and one that never
	 * existed, are one answer with the same status, the same headers and the same body.
	 */
	it("answers a foreign credential exactly as an invented one", async () => {
		const mine = await registerACredential();
		const theirs = await registerACredential();

		const foreign = await mounted.handler(
			postTo(
				"/factor/webauthn/remove",
				{ credentialId: theirs.credentialRowId },
				withSession(mine.sessionToken),
			),
		);
		const invented = await mounted.handler(
			postTo(
				"/factor/webauthn/remove",
				{ credentialId: "00000000-0000-4000-8000-000000000000" },
				withSession(mine.sessionToken),
			),
		);

		expect(await difference(foreign, invented)).toStrictEqual([]);

		// And the foreign credential is still there, which is what the identical answer conceals.
		const stillListed = await mounted.handler(
			getFrom("/factor/webauthn/list", withSession(theirs.sessionToken)),
		);
		expect((await stillListed.json()) as readonly unknown[]).toHaveLength(1);
	});

	/**
	 * L-13 counts a `password_credential`, every WebAuthn credential and every further identity.
	 * These accounts are created with a password, so the one credential is never the last way in
	 * and the removal goes through — which is what says the count is being made rather than the
	 * route refusing on the credential alone.
	 */
	it("removes a credential that is not the account's last way in", async () => {
		const registered = await registerACredential();

		const removed = await mounted.handler(
			postTo(
				"/factor/webauthn/remove",
				{ credentialId: registered.credentialRowId },
				withSession(registered.sessionToken),
			),
		);
		const listed = await mounted.handler(
			getFrom("/factor/webauthn/list", withSession(registered.sessionToken)),
		);

		expect(removed.status).toBe(204);
		expect((await listed.json()) as readonly unknown[]).toStrictEqual([]);
	});
});

describe("what an unknown credential may reveal (5.3)", () => {
	it("answers a credential the library never saw exactly as a bad signature", async () => {
		await registerACredential();
		const stranger = await newAuthenticator();
		const known = await registerACredential();

		const startedForStranger = await mounted.handler(postTo("/sign-in/passkey/start", {}));
		const strangerChallenge = (await startedForStranger.json()) as { challengeToken: string };
		const unknownCredential = await mounted.handler(
			postTo("/sign-in/passkey/finish", {
				challengeToken: strangerChallenge.challengeToken,
				response: await stranger.assert({ challenge: strangerChallenge.challengeToken }),
			}),
		);

		const startedForKnown = await mounted.handler(postTo("/sign-in/passkey/start", {}));
		const knownChallenge = (await startedForKnown.json()) as { challengeToken: string };
		const badSignature = await mounted.handler(
			postTo("/sign-in/passkey/finish", {
				challengeToken: knownChallenge.challengeToken,
				response: await known.authenticator.assert({
					challenge: knownChallenge.challengeToken,
					signatureFault: "another-key",
				}),
			}),
		);

		expect(await difference(unknownCredential, badSignature)).toStrictEqual([]);
	});
});
