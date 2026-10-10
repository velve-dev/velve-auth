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
import type { IssueAuthorisation } from "../../db/repositories/session.js";
import { isRowIdentifier } from "../../db/row-identifier.js";
import { ConcealedError, type ConcealedReason, VelveError } from "../../http/error-map.js";
import { removeSignInMethod } from "../../identity/sign-in-methods.js";
import { decodeBase64Url, encodeBase64Url } from "../../keys/base64url.js";
import { equalsInConstantTime } from "../../keys/constant-time.js";
import type { KeyProvider } from "../../keys/provider.js";
import { assertBelowCredentialLimit } from "../../security-state/limits.js";
import { type SecurityStateRead, sealedComponentsOf } from "../../security-state/read.js";
import {
	checkAccount,
	type SecurityStateRuntime,
	sealChange,
} from "../../security-state/runtime.js";
import { componentsAfter } from "../../security-state/sealing.js";
import type { TokenBindingRefusalReport } from "../../token/binding.js";
import type { PendingResolution } from "../pending/index.js";
import {
	createWebAuthnChallenges,
	WEBAUTHN_CHALLENGE_LIFETIME_SECONDS,
	type WebAuthnChallenges,
} from "./challenge.js";
import { type WebAuthnConfig, type WebAuthnSettings, webAuthnSettingsOf } from "./config.js";
import {
	type CredentialOwner,
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

/** the options and challenge token a browser needs to register a credential */
export interface WebAuthnRegistrationChallenge {
	readonly publicKeyOptions: PublicKeyCredentialCreationOptionsJSON;
	readonly challengeToken: string;
}

/** the options and challenge token to sign in with a credential, as a second factor or a passkey */
export interface WebAuthnAuthenticationChallenge {
	readonly publicKeyOptions: PublicKeyCredentialRequestOptionsJSON;
	readonly challengeToken: string;
}

export interface VerifiedWebAuthnAssertion {
	readonly userId: string;
	readonly credential: WebAuthnCredential;
	/** reported and never a rejection, as a synchronised passkey does not keep the counter */
	readonly signCountRegressed: boolean;
	/** the seal the check before the assertion read, which the session it leads to is bound to */
	readonly authorisedBy: IssueAuthorisation;
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
	/** the second factor after a password, acting on the intermediate state and not a session */
	authenticate: {
		start(input: { pending: PendingResolution }): Promise<WebAuthnAuthenticationChallenge>;
		finish(input: {
			pending: PendingResolution;
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
	readonly keys: KeyProvider;
	readonly reportTokenBindingRefusal?: TokenBindingRefusalReport;
	readonly webauthn: WebAuthnConfig;
	/** the seal a registration reseals and every assertion checks first */
	readonly securityState: SecurityStateRuntime;
}

//the passkey an assertion is verified against must be one of the passkeys the seal covers (S-INTEG-4)
function passkeyOfTheRead(
	read: SecurityStateRead,
	stored: StoredWebAuthnCredential,
): StoredWebAuthnCredential | null {
	const sealed = read.passkeys.find(
		(passkey) =>
			passkey.id === stored.id &&
			equalsInConstantTime(passkey.credentialId, stored.credentialId) &&
			equalsInConstantTime(passkey.publicKey, stored.publicKey),
	);
	return sealed === undefined ? null : { ...stored, publicKey: sealed.publicKey };
}

const DEFAULT_SCHEMA = "velve";
const CEREMONY_TIMEOUT_MS = WEBAUTHN_CHALLENGE_LIFETIME_SECONDS * 1000;

//an all zero aaguid means the model is undisclosed so the column holds null
const UNNAMED_AAGUID = "00000000-0000-0000-0000-000000000000";

interface CredentialDescriptor {
	readonly id: string;
	readonly transports?: AuthenticatorTransportFuture[];
}

//read as an own property so a polluted prototype cannot reach the row (E-481)
function transportsSentWith(response: RegistrationResponseJSON): readonly string[] {
	return Object.hasOwn(response.response, "transports") ? (response.response.transports ?? []) : [];
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

//an authenticator may keep no counter so only a counter that falls back has regressed
function countHasRegressed(counts: {
	readonly readBefore: number;
	readonly reported: number;
	readonly storedAfter: number;
}): boolean {
	const fellBelowTheRead = counts.readBefore > 0 && counts.reported <= counts.readBefore;
	//a higher count written between the read and this write is a fall as well (E-3050)
	const fellBelowTheStoredCounter = counts.storedAfter > counts.reported;
	return fellBelowTheRead || fellBelowTheStoredCounter;
}

//the verifier's cause is never inspected and the outside learns one thing (E-457)
async function verifiedOrRejected<T>(verify: () => Promise<T>): Promise<T> {
	try {
		return await verify();
	} catch {
		throw new ConcealedError("signature_invalid");
	}
}

export function createWebAuthnService(options: WebAuthnServiceOptions): WebAuthnService {
	const settings = webAuthnSettingsOf(options.webauthn);
	const schema = options.schema ?? DEFAULT_SCHEMA;
	const challenges: WebAuthnChallenges = createWebAuthnChallenges({
		driver: options.driver,
		schema,
		keys: options.keys,
		...(options.reportTokenBindingRefusal === undefined
			? {}
			: { reportTokenBindingRefusal: options.reportTokenBindingRefusal }),
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

	async function issueAuthenticationChallenge(
		subject: string | null,
		allowCredentials: CredentialDescriptor[] | undefined,
	): Promise<WebAuthnAuthenticationChallenge> {
		const { challengeToken, challengeBytes } = await challenges.issue({
			purpose: "authenticate",
			userId: subject,
		});
		const publicKeyOptions = await generateAuthenticationOptions({
			rpID: settings.relyingPartyId,
			challenge: challengeBytes,
			timeout: CEREMONY_TIMEOUT_MS,
			//no configuration lowers user verification as a second factor without it is not one
			userVerification: "required",
			...(allowCredentials === undefined ? {} : { allowCredentials }),
		});
		return { publicKeyOptions, challengeToken };
	}

	async function enrolledDescriptorsOf(owner: CredentialOwner): Promise<CredentialDescriptor[]> {
		const enrolled = await credentials.listDescriptorsOwnedBy({ owner });
		if (enrolled.length === 0) {
			throw new VelveError("factor_not_enrolled");
		}
		return enrolled.map(descriptorOf);
	}

	//an assertion checks the seal first and is verified against the passkey of that read (S-INTEG-4)
	async function verifyCheckedAssertion(input: {
		challengeToken: string;
		response: AuthenticationResponseJSON;
		stored: StoredWebAuthnCredential;
		occasion: "sign_in" | "factor_check";
		refusal: ConcealedReason;
	}): Promise<VerifiedWebAuthnAssertion> {
		const check = await checkAccount(options.securityState, input.stored.userId, input.occasion);
		if (check.kind !== "usable") {
			throw new ConcealedError(input.refusal);
		}
		const sealed = passkeyOfTheRead(check.read, input.stored);
		if (sealed === null) {
			options.securityState.alarms.raise({
				userId: input.stored.userId,
				occasion: input.occasion,
				reason: "seal_mismatch",
			});
			throw new ConcealedError(input.refusal);
		}
		const verified = await verifyAssertion({ ...input, stored: sealed });
		return { ...verified, authorisedBy: check.authorisedBy };
	}

	async function verifyAssertion(input: {
		challengeToken: string;
		response: AuthenticationResponseJSON;
		stored: StoredWebAuthnCredential;
	}): Promise<Omit<VerifiedWebAuthnAssertion, "authorisedBy">> {
		assertOriginIsExpected(input.response.response.clientDataJSON, settings.origins);
		assertRelyingPartyIsExpected(
			input.response.response.authenticatorData,
			settings.relyingPartyId,
		);
		assertUserWasVerified(input.response.response.authenticatorData);

		const verification = await verifiedOrRejected(() =>
			verifyAuthenticationResponse({
				response: input.response,
				expectedChallenge: input.challengeToken,
				expectedOrigin: [...settings.origins],
				expectedRPID: settings.relyingPartyId,
				requireUserVerification: true,
				credential: {
					id: encodeBase64Url(input.stored.credentialId),
					publicKey: input.stored.publicKey,
					//the verifier is told no counter so a regression becomes a field (E-458)
					counter: 0,
				},
			}),
		);
		if (!verification.verified) {
			throw new ConcealedError("signature_invalid");
		}

		const { newCounter, credentialBackedUp, credentialDeviceType } =
			verification.authenticationInfo;
		const recorded = await credentials.recordAssertion({
			verified: input.stored,
			signCount: newCounter,
			isBackupEligible: credentialDeviceType === "multiDevice",
			isCurrentlyBackedUp: credentialBackedUp,
		});
		if (recorded === null) {
			throw new ConcealedError("credential_unknown");
		}
		return {
			userId: input.stored.userId,
			credential: recorded.presented,
			signCountRegressed: countHasRegressed({
				readBefore: input.stored.signCount,
				reported: newCounter,
				storedAfter: recorded.signCount,
			}),
		};
	}

	return {
		settings,

		register: {
			async start({ actor, userName, userDisplayName }) {
				const enrolled = await credentials.listDescriptorsOwnedBy({ owner: actor });
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
						//this is the only enrolment ceremony so it must require a resident key (E-483)
						residentKey: "required",
						userVerification: settings.registrationUserVerification,
					},
					...(userDisplayName === undefined ? {} : { userDisplayName }),
				});
				return { publicKeyOptions, challengeToken };
			},

			async finish({ actor, challengeToken, response, label }) {
				await consumeChallengeOrReject({ challengeToken, purpose: "register", userId: actor });
				assertOriginIsExpected(response.response.clientDataJSON, settings.origins);
				const verification = await verifiedOrRejected(() =>
					verifyRegistrationResponse({
						response,
						expectedChallenge: challengeToken,
						expectedOrigin: [...settings.origins],
						expectedRPID: settings.relyingPartyId,
						requireUserPresence: true,
						requireUserVerification: settings.registrationUserVerification === "required",
					}),
				);
				if (!verification.verified) {
					throw new ConcealedError("signature_invalid");
				}

				const { credential, aaguid, userVerified, credentialBackedUp, credentialDeviceType } =
					verification.registrationInfo;
				const credentialId = credentialIdBytes(credential.id);
				//a registration counts the passkeys of the read under the lock and reseals with the new one (S-INTEG-10)
				const sealed = await sealChange(options.securityState, actor, {
					epoch: "keep",
					write: (tx, read) => {
						assertBelowCredentialLimit(read, "passkey", options.securityState.limits);
						return createWebAuthnCredentialRepository({ driver: tx, schema })
							.insertCredential({
								actor,
								credentialId,
								publicKey: credential.publicKey,
								signCount: credential.counter,
								transports: transportsSentWith(response),
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
					},
					after: (read) => {
						const components = sealedComponentsOf(read);
						return {
							...components,
							passkeys: [...components.passkeys, { credentialId, publicKey: credential.publicKey }],
						};
					},
				});
				return { credential: sealed.written };
			},
		},

		authenticate: {
			async start({ pending }) {
				return issueAuthenticationChallenge(pending.userId, await enrolledDescriptorsOf(pending));
			},

			async finish({ pending, challengeToken, response }) {
				await consumeChallengeOrReject({
					challengeToken,
					purpose: "authenticate",
					userId: pending.userId,
				});
				const stored = await credentials.findOwnedCredentialByCredentialId({
					credentialId: credentialIdBytes(response.id),
					owner: pending,
				});
				if (stored === null) {
					throw new ConcealedError("credential_unknown");
				}
				return verifyCheckedAssertion({
					challengeToken,
					response,
					stored,
					occasion: "factor_check",
					refusal: "broken_state_on_passkey_second_factor",
				});
			},
		},

		passkey: {
			//nothing names an account as it is learned from the discoverable credential
			start: () => issueAuthenticationChallenge(null, undefined),

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
				return verifyCheckedAssertion({
					challengeToken,
					response,
					stored,
					occasion: "sign_in",
					refusal: "broken_state_on_passkey_sign_in",
				});
			},
		},

		list: ({ actor }) => credentials.listCredentialsOwnedBy({ actor }),

		async rename({ actor, credentialId, label }) {
			//another account's credential, a missing one and a bad spelling are one answer (S-OWNER-8)
			if (!isRowIdentifier(credentialId)) {
				throw new VelveError("invalid_input");
			}
			const credential = await credentials.renameCredential({ id: credentialId, actor, label });
			if (credential === null) {
				throw new VelveError("invalid_input");
			}
			return { credential };
		},

		async remove({ actor, credentialId }) {
			//deletion goes through the one path that counts what is left first (E-460)
			await sealChange(options.securityState, actor, {
				epoch: "keep",
				write: (tx) =>
					removeSignInMethod({
						driver: tx,
						schema,
						actor,
						removing: { method: "webauthn_credential", credentialId },
					}),
				after: (read) =>
					componentsAfter(read, {
						passkeys: read.passkeys.filter((passkey) => passkey.id !== credentialId),
					}),
			});
		},
	};
}
