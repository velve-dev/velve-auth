import { utf8ToBytes } from "@noble/hashes/utils.js";
import type {
	AuthenticationResponseJSON,
	AuthenticatorTransportFuture,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Actor } from "../../db/actor.js";
import type { Driver } from "../../db/driver.js";
import { ConcealedError, VelveError } from "../../http/error-map.js";
import { removeSignInMethod } from "../../identity/sign-in-methods.js";
import { decodeBase64Url, encodeBase64Url } from "../../keys/base64url.js";
import {
	createWebAuthnChallenges,
	WEBAUTHN_CHALLENGE_LIFETIME_SECONDS,
	type WebAuthnChallenges,
} from "./challenge.js";
import { type WebAuthnConfig, type WebAuthnSettings, webAuthnSettingsOf } from "./config.js";
import {
	createWebAuthnCredentialRepository,
	DuplicateWebAuthnCredentialError,
	type StoredWebAuthnCredential,
	type WebAuthnCredential,
	type WebAuthnCredentialRepository,
} from "./credential-repository.js";
import { isKnownTransport } from "./payload.js";
import {
	assertOriginIsExpected,
	assertRelyingPartyIsExpected,
	assertUserWasVerified,
} from "./verification.js";

/** Architecture 3.15 C. */
export interface WebAuthnRegistrationChallenge {
	readonly publicKeyOptions: PublicKeyCredentialCreationOptionsJSON;
	readonly challengeToken: string;
}

/** Architecture 3.15 C names the passkey form separately; the two ceremonies differ in
 * precondition and in outcome, not in shape. */
export interface WebAuthnAuthenticationChallenge {
	readonly publicKeyOptions: PublicKeyCredentialRequestOptionsJSON;
	readonly challengeToken: string;
}

export interface VerifiedWebAuthnAssertion {
	readonly userId: string;
	readonly credential: WebAuthnCredential;
	/** L-9: reported, never a rejection — a synchronised passkey does not keep the counter. */
	readonly signCountRegressed: boolean;
}

export interface WebAuthnService {
	readonly settings: WebAuthnSettings;
	register: {
		start(input: {
			actor: Actor;
			userName: string;
			userDisplayName?: string;
		}): Promise<WebAuthnRegistrationChallenge>;
		finish(input: {
			actor: Actor;
			challengeToken: string;
			response: RegistrationResponseJSON;
			label: string;
		}): Promise<{ credential: WebAuthnCredential }>;
	};
	authenticate: {
		start(input: { actor: Actor }): Promise<WebAuthnAuthenticationChallenge>;
		finish(input: {
			actor: Actor;
			challengeToken: string;
			response: AuthenticationResponseJSON;
		}): Promise<VerifiedWebAuthnAssertion>;
	};
	passkey: {
		start(): Promise<WebAuthnAuthenticationChallenge>;
		finish(input: {
			challengeToken: string;
			response: AuthenticationResponseJSON;
		}): Promise<VerifiedWebAuthnAssertion>;
	};
	list(input: { actor: Actor }): Promise<WebAuthnCredential[]>;
	rename(input: {
		actor: Actor;
		credentialId: string;
		label: string;
	}): Promise<{ credential: WebAuthnCredential }>;
	remove(input: { actor: Actor; credentialId: string }): Promise<void>;
}

export interface WebAuthnServiceOptions {
	readonly driver: Driver;
	readonly schema?: string;
	readonly webauthn: WebAuthnConfig;
}

const DEFAULT_SCHEMA = "velve";
const CEREMONY_TIMEOUT_MS = WEBAUTHN_CHALLENGE_LIFETIME_SECONDS * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** All zeros is what an authenticator says when it declines to name its model, and the column
 * holds null rather than a uuid meaning "unknown". */
const UNNAMED_AAGUID = "00000000-0000-0000-0000-000000000000";

interface CredentialDescriptor {
	readonly id: string;
	readonly transports?: AuthenticatorTransportFuture[];
}

function aaguidOf(reported: string): string | null {
	return reported === "" || reported === UNNAMED_AAGUID ? null : reported;
}

function credentialIdBytes(base64url: string): Uint8Array<ArrayBuffer> {
	const bytes = decodeBase64Url(base64url);
	if (bytes === null) {
		throw new ConcealedError("credential_unknown");
	}
	return bytes;
}

function descriptorOf(credential: StoredWebAuthnCredential): CredentialDescriptor {
	const transports = credential.transports.filter(isKnownTransport);
	const id = encodeBase64Url(credential.credentialId);
	return transports.length === 0 ? { id } : { id, transports };
}

/** WebAuthn Level 3 §7.2 lets the authenticator keep no counter at all, and then every
 * assertion reports zero; only a counter that was running and has fallen back is a regression. */
function countHasRegressed(stored: number, reported: number): boolean {
	return stored > 0 && reported <= stored;
}

function rejectedCredential(cause: unknown): never {
	if (cause instanceof ConcealedError || cause instanceof VelveError) {
		throw cause;
	}
	throw new ConcealedError("signature_invalid");
}

export function createWebAuthnService(options: WebAuthnServiceOptions): WebAuthnService {
	const settings = webAuthnSettingsOf(options.webauthn);
	const schema = options.schema ?? DEFAULT_SCHEMA;
	const challenges: WebAuthnChallenges = createWebAuthnChallenges({
		driver: options.driver,
		schema,
	});
	const credentials: WebAuthnCredentialRepository = createWebAuthnCredentialRepository({
		driver: options.driver,
		schema,
	});

	async function consumeChallengeOrReject(input: {
		challengeToken: string;
		purpose: "register" | "authenticate";
		userId: string | null;
	}): Promise<void> {
		if (!(await challenges.consume(input))) {
			throw new ConcealedError("challenge_not_found");
		}
	}

	async function requestOptionsFor(actor: Actor | null): Promise<WebAuthnAuthenticationChallenge> {
		const allowCredentials =
			actor === null ? [] : (await credentials.listDescriptorsOwnedBy({ actor })).map(descriptorOf);
		if (actor !== null && allowCredentials.length === 0) {
			throw new VelveError("factor_not_enrolled");
		}
		const { challengeToken, challengeBytes } = await challenges.issue({
			purpose: "authenticate",
			userId: actor,
		});
		const publicKeyOptions = await generateAuthenticationOptions({
			rpID: settings.relyingPartyId,
			challenge: challengeBytes,
			timeout: CEREMONY_TIMEOUT_MS,
			/* Architecture 3.6 and 3.15 A.8: fixed at both verification points, and there is no
			   configuration that lowers it. A second factor without user verification is not one. */
			userVerification: "required",
			...(actor === null ? {} : { allowCredentials }),
		});
		return { publicKeyOptions, challengeToken };
	}

	async function verifyAssertion(input: {
		challengeToken: string;
		response: AuthenticationResponseJSON;
		stored: StoredWebAuthnCredential;
	}): Promise<VerifiedWebAuthnAssertion> {
		assertOriginIsExpected(input.response.response.clientDataJSON, settings.origins);
		assertRelyingPartyIsExpected(
			input.response.response.authenticatorData,
			settings.relyingPartyId,
		);
		assertUserWasVerified(input.response.response.authenticatorData);

		const verification = await verifyAuthenticationResponse({
			response: input.response,
			expectedChallenge: input.challengeToken,
			expectedOrigin: [...settings.origins],
			expectedRPID: settings.relyingPartyId,
			requireUserVerification: true,
			credential: {
				id: encodeBase64Url(input.stored.credentialId),
				publicKey: input.stored.publicKey,
				/* L-9: the verifier raises on a counter that has fallen back, so it is told none
				   and the comparison is made below, where a regression is a field (E-458). */
				counter: 0,
			},
		}).catch(rejectedCredential);
		if (!verification.verified) {
			throw new ConcealedError("signature_invalid");
		}

		const { newCounter, credentialBackedUp, credentialDeviceType } =
			verification.authenticationInfo;
		const credential = await credentials.recordAssertion({
			verified: input.stored,
			signCount: newCounter,
			isBackupEligible: credentialDeviceType === "multiDevice",
			isCurrentlyBackedUp: credentialBackedUp,
		});
		if (credential === null) {
			throw new ConcealedError("credential_unknown");
		}
		return {
			userId: input.stored.userId,
			credential,
			signCountRegressed: countHasRegressed(input.stored.signCount, newCounter),
		};
	}

	return {
		settings,

		register: {
			async start({ actor, userName, userDisplayName }) {
				const enrolled = await credentials.listDescriptorsOwnedBy({ actor });
				const { challengeToken, challengeBytes } = await challenges.issue({
					purpose: "register",
					userId: actor,
				});
				const publicKeyOptions = await generateRegistrationOptions({
					rpID: settings.relyingPartyId,
					rpName: settings.relyingPartyName,
					userName,
					userID: utf8ToBytes(actor),
					challenge: challengeBytes,
					timeout: CEREMONY_TIMEOUT_MS,
					attestationType: "none",
					excludeCredentials: enrolled.map(descriptorOf),
					authenticatorSelection: {
						residentKey: "preferred",
						userVerification: settings.registrationUserVerification,
					},
					...(userDisplayName === undefined ? {} : { userDisplayName }),
				});
				return { publicKeyOptions, challengeToken };
			},

			async finish({ actor, challengeToken, response, label }) {
				await consumeChallengeOrReject({ challengeToken, purpose: "register", userId: actor });
				assertOriginIsExpected(response.response.clientDataJSON, settings.origins);
				const verification = await verifyRegistrationResponse({
					response,
					expectedChallenge: challengeToken,
					expectedOrigin: [...settings.origins],
					expectedRPID: settings.relyingPartyId,
					requireUserPresence: true,
					requireUserVerification: settings.registrationUserVerification === "required",
				}).catch(rejectedCredential);
				if (!verification.verified) {
					throw new ConcealedError("signature_invalid");
				}

				const { credential, aaguid, userVerified, credentialBackedUp, credentialDeviceType } =
					verification.registrationInfo;
				const stored = await credentials
					.insertCredential({
						actor,
						credentialId: credentialIdBytes(credential.id),
						publicKey: credential.publicKey,
						signCount: credential.counter,
						transports: response.response.transports ?? [],
						aaguid: aaguidOf(aaguid),
						isBackupEligible: credentialDeviceType === "multiDevice",
						isCurrentlyBackedUp: credentialBackedUp,
						wasUserVerifiedAtRegistration: userVerified,
						label,
					})
					.catch((cause: unknown) => {
						if (cause instanceof DuplicateWebAuthnCredentialError) {
							throw new VelveError("webauthn_credential_rejected");
						}
						throw cause;
					});
				return { credential: stored };
			},
		},

		authenticate: {
			start: ({ actor }) => requestOptionsFor(actor),

			async finish({ actor, challengeToken, response }) {
				await consumeChallengeOrReject({ challengeToken, purpose: "authenticate", userId: actor });
				const stored = await credentials.findOwnedCredentialByCredentialId({
					credentialId: credentialIdBytes(response.id),
					actor,
				});
				if (stored === null) {
					throw new ConcealedError("credential_unknown");
				}
				return verifyAssertion({ challengeToken, response, stored });
			},
		},

		passkey: {
			start: () => requestOptionsFor(null),

			async finish({ challengeToken, response }) {
				await consumeChallengeOrReject({
					challengeToken,
					purpose: "authenticate",
					userId: null,
				});
				const stored = await credentials.findCredentialByCredentialId({
					credentialId: credentialIdBytes(response.id),
				});
				if (stored === null) {
					throw new ConcealedError("credential_unknown");
				}
				return verifyAssertion({ challengeToken, response, stored });
			},
		},

		list: ({ actor }) => credentials.listCredentialsOwnedBy({ actor }),

		async rename({ actor, credentialId, label }) {
			// S-OWNER-8: a credential of another account, one that never existed and a spelling
			// that names no row at all are one answer.
			if (!UUID.test(credentialId)) {
				throw new VelveError("invalid_input");
			}
			const credential = await credentials.renameCredential({ id: credentialId, actor, label });
			if (credential === null) {
				throw new VelveError("invalid_input");
			}
			return { credential };
		},

		async remove({ actor, credentialId }) {
			/* S-OWNER-3: the deletion runs through the one path that counts what is left first
			   (L-13), and a spelling that cannot name a row takes the same exit as a row that is
			   not the caller's — the route declares no 400. */
			if (!UUID.test(credentialId)) {
				return;
			}
			await removeSignInMethod({
				driver: options.driver,
				schema,
				actor,
				removing: { method: "webauthn_credential", credentialId },
			});
		},
	};
}
