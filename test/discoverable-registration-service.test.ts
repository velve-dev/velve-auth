import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import { ConcealedError, toVisibleFailure } from "../src/core/http/error-map.js";
import {
	createAccount,
	newAuthenticator,
	openWebAuthnFixture,
	TEST_WEBAUTHN_CONFIG,
	type WebAuthnFixture,
} from "./webauthn-fixtures.js";

/**
 * S-DEFAULT-8 at the WebAuthn service, where both the registration in a session and the one that
 * ends a recovery are checked: what the options ask the authenticator for, which client extension
 * results count as a discoverable credential, that a refusal stores nothing and costs the session
 * ceremony its challenge and nothing more, and that the switch left off changes nothing.
 */

let required: WebAuthnFixture;
let off: WebAuthnFixture;

beforeAll(async () => {
	required = await openWebAuthnFixture("discoverable_on", {
		...TEST_WEBAUTHN_CONFIG,
		requireDiscoverableCredential: true,
	});
	off = await openWebAuthnFixture("discoverable_off");
}, 60_000);

afterAll(async () => {
	await required.close();
	await off.close();
});

async function credentialRowsOf(fixture: WebAuthnFixture, actor: Actor): Promise<number> {
	const [row] = await fixture.connection.query<{ total: number }>(
		`SELECT count(*)::integer AS total FROM ${fixture.schema}.webauthn_credential WHERE user_id = $1`,
		[actor],
	);
	return row?.total ?? -1;
}

function reporting(
	response: RegistrationResponseJSON,
	clientExtensionResults: unknown,
): RegistrationResponseJSON {
	return { ...response, clientExtensionResults } as RegistrationResponseJSON;
}

function withoutExtensionResults(response: RegistrationResponseJSON): RegistrationResponseJSON {
	const { clientExtensionResults: _dropped, ...rest } = response;
	return rest as RegistrationResponseJSON;
}

async function reasonOf(attempt: Promise<unknown>): Promise<string> {
	try {
		await attempt;
	} catch (cause) {
		if (cause instanceof ConcealedError) {
			return cause.reason;
		}
		throw cause;
	}
	return "accepted";
}

describe("what a registration asks the authenticator for (S-DEFAULT-8)", () => {
	it("asks for a resident key, user verification and credProps with the switch on", async () => {
		const actor = await createAccount(required);
		const { publicKeyOptions } = await required.service.register.start({
			actor,
			userName: "someone",
		});

		expect(publicKeyOptions.authenticatorSelection).toMatchObject({
			residentKey: "required",
			requireResidentKey: true,
			userVerification: "required",
		});
		expect(publicKeyOptions.extensions).toMatchObject({ credProps: true });
	});

	it("asks for credProps with the switch off too, so turning it on changes no request", async () => {
		const actor = await createAccount(off);
		const { publicKeyOptions } = await off.service.register.start({ actor, userName: "someone" });

		expect(publicKeyOptions.authenticatorSelection?.residentKey).toBe("required");
		expect(publicKeyOptions.extensions).toMatchObject({ credProps: true });
	});
});

describe("which reported results count as a discoverable credential (S-DEFAULT-8)", () => {
	const REFUSED: readonly (readonly [
		string,
		(response: RegistrationResponseJSON) => RegistrationResponseJSON,
	])[] = [
		["rk false", (response) => reporting(response, { credProps: { rk: false } })],
		["credProps without rk", (response) => reporting(response, { credProps: {} })],
		["no credProps", (response) => reporting(response, {})],
		["rk as the string true", (response) => reporting(response, { credProps: { rk: "true" } })],
		["rk as the number 1", (response) => reporting(response, { credProps: { rk: 1 } })],
		["credProps as true", (response) => reporting(response, { credProps: true })],
		["extension results that are an array", (response) => reporting(response, [])],
		["no extension results at all", withoutExtensionResults],
		[
			"an rk inherited from a prototype",
			(response) => reporting(response, { credProps: Object.create({ rk: true }) }),
		],
		[
			"a credProps inherited from a prototype",
			(response) => reporting(response, Object.create({ credProps: { rk: true } })),
		],
	];

	it.each(REFUSED)(
		"refuses %s, stores nothing and spends only the challenge",
		async (_name, shape) => {
			const actor = await createAccount(required);
			const authenticator = await newAuthenticator();
			const started = await required.service.register.start({ actor, userName: "someone" });
			const attested = await authenticator.attest({ challenge: started.challengeToken });

			const refused = await reasonOf(
				required.service.register.finish({
					actor,
					challengeToken: started.challengeToken,
					response: shape(attested),
					label: "not discoverable",
				}),
			);
			const retried = await reasonOf(
				required.service.register.finish({
					actor,
					challengeToken: started.challengeToken,
					response: reporting(attested, { credProps: { rk: true } }),
					label: "retried",
				}),
			);

			expect(refused).toBe("credential_not_discoverable");
			expect(toVisibleFailure(new ConcealedError("credential_not_discoverable")).error.code).toBe(
				"webauthn_credential_not_discoverable",
			);
			expect(retried).toBe("challenge_not_found");
			expect(await credentialRowsOf(required, actor)).toBe(0);
		},
	);

	it("registers a credential whose client reports rk as an own true", async () => {
		const actor = await createAccount(required);
		const authenticator = await newAuthenticator();
		const started = await required.service.register.start({ actor, userName: "someone" });
		const attested = await authenticator.attest({ challenge: started.challengeToken });

		const { credential } = await required.service.register.finish({
			actor,
			challengeToken: started.challengeToken,
			response: reporting(attested, { credProps: { rk: true } }),
			label: "discoverable",
		});

		expect(credential.label).toBe("discoverable");
		expect(credential.wasUserVerifiedAtRegistration).toBe(true);
		expect(await credentialRowsOf(required, actor)).toBe(1);
	});

	it("refuses an attestation without the user verified flag even when rk is reported", async () => {
		const actor = await createAccount(required);
		const authenticator = await newAuthenticator();
		const started = await required.service.register.start({ actor, userName: "someone" });
		const attested = await authenticator.attest({
			challenge: started.challengeToken,
			flags: { userVerified: false },
		});

		const refused = await reasonOf(
			required.service.register.finish({
				actor,
				challengeToken: started.challengeToken,
				response: reporting(attested, { credProps: { rk: true } }),
				label: "unverified",
			}),
		);

		expect(toVisibleFailure(new ConcealedError(refused as never)).error.code).toBe(
			"webauthn_credential_rejected",
		);
		expect(await credentialRowsOf(required, actor)).toBe(0);
	});

	it("answers a forged attestation as rejected and never as not discoverable", async () => {
		const actor = await createAccount(required);
		const authenticator = await newAuthenticator();
		const started = await required.service.register.start({ actor, userName: "someone" });
		const attested = await authenticator.attest({
			challenge: started.challengeToken,
			origin: "https://evil.example.com",
		});

		const refused = await reasonOf(
			required.service.register.finish({
				actor,
				challengeToken: started.challengeToken,
				response: reporting(attested, {}),
				label: "forged",
			}),
		);

		expect(refused).toBe("origin_mismatch");
		expect(await credentialRowsOf(required, actor)).toBe(0);
	});
});

describe("the switch left off (S-DEFAULT-8)", () => {
	it("registers a credential whose client reports nothing, as before", async () => {
		const actor = await createAccount(off);
		const authenticator = await newAuthenticator();
		const started = await off.service.register.start({ actor, userName: "someone" });
		const attested = await authenticator.attest({ challenge: started.challengeToken });

		await off.service.register.finish({
			actor,
			challengeToken: started.challengeToken,
			response: withoutExtensionResults(attested),
			label: "silent",
		});

		expect(await credentialRowsOf(off, actor)).toBe(1);
	});
});
