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
import type { Actor, ConsumedRecoveryChallenge } from "../../db/actor.js";
import type { Driver } from "../../db/driver.js";
import type { IssueAuthorisation } from "../../db/repositories/session.js";
import { isRowIdentifier } from "../../db/row-identifier.js";
import { ConcealedError, type ConcealedReason, VelveError } from "../../http/error-map.js";
import { removeSignInMethod } from "../../identity/sign-in-methods.js";
import { decodeBase64Url, encodeBase64Url } from "../../keys/base64url.js";
import { equalsInConstantTime } from "../../keys/constant-time.js";
import type { KeyProvider } from "../../keys/provider.js";
import { assertBelowCredentialLimit } from "../../security-state/limits.js";
import {
	type SecurityStateRead,
	satisfiesTheAllowlist,
	sealedComponentsOf,
} from "../../security-state/read.js";
import {
	checkAccount,
	type SecurityStateRuntime,
	sealChange,
} from "../../security-state/runtime.js";
import { componentsAfter } from "../../security-state/sealing.js";
import type { TokenBindingRefusalReport } from "../../token/binding.js";
import type { PendingResolution } from "../pending/index.js";
import { attestedAaguidOf } from "./attestation.js";
import {
	createWebAuthnChallenges,
	WEBAUTHN_CHALLENGE_LIFETIME_SECONDS,
	type WebAuthnChallenges,
} from "./challenge.js";
import {
	type RegistrationUserVerification,
	type WebAuthnConfig,
	type WebAuthnSettings,
	webAuthnSettingsOf,
} from "./config.js";
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
	assertClientReportsADiscoverableCredential,
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

/** a credential a registration ceremony verified, before any row holds it */
export interface RegisteredWebAuthnCredential {
	readonly credentialId: Uint8Array<ArrayBuffer>;
	readonly publicKey: Uint8Array<ArrayBuffer>;
	readonly signCount: number;
	readonly transports: readonly string[];
	readonly aaguid: string | null;
	readonly isBackupEligible: boolean;
	readonly isCurrentlyBackedUp: boolean;
	readonly wasUserVerifiedAtRegistration: boolean;
	/** whether the attestation chain verified against the configured roots, which only a credential with an aaguid can */
	readonly attestationVerified: boolean;
}

/** the account a recovery registration's challenge named and the credential the ceremony verified for it */
export interface RecoveredWebAuthnCredential {
	readonly owner: ConsumedRecoveryChallenge;
	readonly credential: RegisteredWebAuthnCredential;
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
	/** the registration that ends a recovery to a new passkey, bound to the recovery and to no session */
	recovery: {
		start(input: {
			transaction: Driver;
			actor: Actor;
			userName: string;
			authenticatorAllowlist: readonly string[] | null;
		}): Promise<WebAuthnRegistrationChallenge>;
		finish(input: {
			transaction: Driver;
			challengeToken: string;
			response: RegistrationResponseJSON;
		}): Promise<RecoveredWebAuthnCredential>;
		withdraw(input: { transaction: Driver; actor: Actor }): Promise<void>;
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
	/** activates a recovery whose waiting period has ended and whose new passkey a sign-in presents */
	readonly activateDuePasskeyRecovery?: (credentialId: Uint8Array<ArrayBuffer>) => Promise<void>;
}

//the passkey an assertion is verified against must be one of the passkeys the seal covers (S-INTEG-4)
function passkeyOfTheRead(
	read: SecurityStateRead,
	stored: StoredWebAuthnCredential,
): (StoredWebAuthnCredential & { readonly attestedAaguid: string | null }) | null {
	const sealed = read.passkeys.find(
		(passkey) =>
			passkey.id === stored.id &&
			equalsInConstantTime(passkey.credentialId, stored.credentialId) &&
			equalsInConstantTime(passkey.publicKey, stored.publicKey),
	);
	return sealed === undefined
		? null
		: { ...stored, publicKey: sealed.publicKey, attestedAaguid: sealed.attestedAaguid };
}

/** the AAGUID a registered credential is attested as, or null where its chain did not verify */
export function attestedAaguidOfRegistered(
	credential: RegisteredWebAuthnCredential,
): string | null {
	return credential.attestationVerified ? credential.aaguid : null;
}

//a list refuses every authenticator outside it and every one whose chain did not verify (S-INTEG-13)
export function refuseAnAuthenticatorOutsideTheList(
	read: SecurityStateRead,
	credential: RegisteredWebAuthnCredential,
): void {
	if (!satisfiesTheAllowlist(read.authenticatorAllowlist, attestedAaguidOfRegistered(credential))) {
		throw new ConcealedError("authenticator_not_allowed");
	}
}

//no sign-in method the list leaves usable may be removed last (E-3850)
function refuseRemovingTheLastUsablePasskey(read: SecurityStateRead, removedId: string): void {
	const allowlist = read.authenticatorAllowlist;
	if (allowlist === null) {
		return;
	}
	const usable = read.passkeys.filter((passkey) =>
		satisfiesTheAllowlist(allowlist, passkey.attestedAaguid),
	);
	const removesAUsableOne = usable.some((passkey) => passkey.id === removedId);
	const othersRemain =
		read.password !== null ||
		read.identities.length > 0 ||
		usable.some((passkey) => passkey.id !== removedId);
	if (removesAUsableOne && !othersRemain) {
		throw new VelveError("last_sign_in_method");
	}
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
	const challengesOn = (driver: Driver): WebAuthnChallenges =>
		createWebAuthnChallenges({
			driver,
			schema,
			keys: options.keys,
			...(options.reportTokenBindingRefusal === undefined
				? {}
				: { reportTokenBindingRefusal: options.reportTokenBindingRefusal }),
		});
	const challenges = challengesOn(options.driver);
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

	//a passkey still held by a recovery whose waiting period ended becomes usable at its first sign-in (E-3768)
	async function findOrActivateCredential(
		credentialId: Uint8Array<ArrayBuffer>,
	): Promise<StoredWebAuthnCredential | null> {
		const stored = await credentials.findCredentialByCredentialId({ credentialId });
		if (stored !== null || options.activateDuePasskeyRecovery === undefined) {
			return stored;
		}
		await options.activateDuePasskeyRecovery(credentialId);
		return credentials.findCredentialByCredentialId({ credentialId });
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

	//attestation is asked for only where a list needs it or the application asks for every account (E-3841)
	function attestationRequestedFor(allowlist: readonly string[] | null): "direct" | "none" {
		const attestation = settings.attestation;
		return attestation !== null && (attestation.requestForEveryAccount || allowlist !== null)
			? "direct"
			: "none";
	}

	//the list a registration in a session asks attestation for is read from the verified state (S-INTEG-4)
	async function allowlistToRequestFor(actor: Actor): Promise<readonly string[] | null> {
		if (settings.attestation === null || settings.attestation.requestForEveryAccount) {
			return null;
		}
		const check = await checkAccount(options.securityState, actor, "change");
		return check.kind === "usable" ? check.read.authenticatorAllowlist : null;
	}

	//every registration ceremony asks the authenticator through this one place (E-3766)
	function registrationOptionsFor(input: {
		readonly actor: Actor;
		readonly userName: string;
		readonly userDisplayName?: string;
		readonly challengeBytes: Uint8Array<ArrayBuffer>;
		readonly enrolled: readonly StoredWebAuthnCredential[];
		readonly userVerification: RegistrationUserVerification;
		readonly authenticatorAllowlist: readonly string[] | null;
	}): Promise<PublicKeyCredentialCreationOptionsJSON> {
		return generateRegistrationOptions({
			rpID: settings.relyingPartyId,
			rpName: settings.relyingPartyName,
			userName: input.userName,
			userID: utf8ToBytes(input.actor),
			challenge: input.challengeBytes,
			timeout: CEREMONY_TIMEOUT_MS,
			attestationType: attestationRequestedFor(input.authenticatorAllowlist),
			excludeCredentials: input.enrolled.map(descriptorOf),
			authenticatorSelection: {
				//this is the only enrolment ceremony so it must require a resident key (E-483)
				residentKey: "required",
				userVerification: input.userVerification,
			},
			//the request names credProps itself and does not rest on a dependency default (E-3815)
			extensions: { credProps: true },
			...(input.userDisplayName === undefined ? {} : { userDisplayName: input.userDisplayName }),
		});
	}

	//every registration ceremony is verified through this one place (E-3766)
	async function verifiedRegistration(input: {
		readonly challengeToken: string;
		readonly response: RegistrationResponseJSON;
		readonly userVerification: RegistrationUserVerification;
	}): Promise<RegisteredWebAuthnCredential> {
		assertOriginIsExpected(input.response.response.clientDataJSON, settings.origins);
		const verification = await verifiedOrRejected(() =>
			verifyRegistrationResponse({
				response: input.response,
				expectedChallenge: input.challengeToken,
				expectedOrigin: [...settings.origins],
				expectedRPID: settings.relyingPartyId,
				requireUserPresence: true,
				requireUserVerification: input.userVerification === "required",
			}),
		);
		if (!verification.verified) {
			throw new ConcealedError("signature_invalid");
		}
		//only a ceremony that verified is told it made no discoverable credential (E-3814)
		if (settings.requireDiscoverableCredential) {
			assertClientReportsADiscoverableCredential(input.response);
		}
		const {
			credential,
			aaguid,
			userVerified,
			credentialBackedUp,
			credentialDeviceType,
			fmt,
			attestationObject,
		} = verification.registrationInfo;
		const attestedAaguid = await attestedAaguidOf(
			{ fmt, aaguid: aaguidOf(aaguid), attestationObject },
			settings.attestation?.trustedRoots ?? null,
		);
		return {
			credentialId: credentialIdBytes(credential.id),
			publicKey: credential.publicKey,
			signCount: credential.counter,
			transports: transportsSentWith(input.response),
			aaguid: aaguidOf(aaguid),
			isBackupEligible: credentialDeviceType === "multiDevice",
			isCurrentlyBackedUp: credentialBackedUp,
			wasUserVerifiedAtRegistration: userVerified,
			attestationVerified: attestedAaguid !== null,
		};
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
		//a passkey outside the list answers as an unknown one before any signature is checked (S-INTEG-13)
		if (!satisfiesTheAllowlist(check.read.authenticatorAllowlist, sealed.attestedAaguid)) {
			throw new ConcealedError("authenticator_not_allowed_on_assertion");
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
				const publicKeyOptions = await registrationOptionsFor({
					actor,
					userName,
					challengeBytes,
					enrolled,
					userVerification: settings.registrationUserVerification,
					authenticatorAllowlist: await allowlistToRequestFor(actor),
					...(userDisplayName === undefined ? {} : { userDisplayName }),
				});
				return { publicKeyOptions, challengeToken };
			},

			async finish({ actor, challengeToken, response, label }) {
				await consumeChallengeOrReject({ challengeToken, purpose: "register", userId: actor });
				const registered = await verifiedRegistration({
					challengeToken,
					response,
					userVerification: settings.registrationUserVerification,
				});
				//a registration counts the passkeys of the read under the lock and reseals with the new one (S-INTEG-10)
				const sealed = await sealChange(options.securityState, actor, {
					epoch: "keep",
					write: (tx, read) => {
						assertBelowCredentialLimit(read, "passkey", options.securityState.limits);
						refuseAnAuthenticatorOutsideTheList(read, registered);
						return createWebAuthnCredentialRepository({ driver: tx, schema })
							.insertCredential({ actor, ...registered, label })
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
							passkeys: [
								...components.passkeys,
								{
									credentialId: registered.credentialId,
									publicKey: registered.publicKey,
									attestedAaguid: attestedAaguidOfRegistered(registered),
								},
							],
						};
					},
				});
				return { credential: sealed.written };
			},
		},

		recovery: {
			//the passkeys the account holds are excluded so the authenticator keeps one that still works (E-3766)
			async start({ transaction, actor, userName, authenticatorAllowlist }) {
				const enrolled = await createWebAuthnCredentialRepository({
					driver: transaction,
					schema,
				}).listDescriptorsOwnedBy({ owner: actor });
				const { challengeToken, challengeBytes } = await challengesOn(transaction).issue({
					purpose: "recover",
					userId: actor,
				});
				const publicKeyOptions = await registrationOptionsFor({
					actor,
					userName,
					challengeBytes,
					enrolled,
					userVerification: "required",
					authenticatorAllowlist,
				});
				return { publicKeyOptions, challengeToken };
			},

			//a passkey that replaces every other way in is registered with user verification whatever the setting (E-3766)
			async finish({ transaction, challengeToken, response }) {
				const owner = await challengesOn(transaction).consumeNamingItsOwner({
					purpose: "recover",
					challengeToken,
				});
				if (owner === null) {
					throw new ConcealedError("challenge_not_found");
				}
				const credential = await verifiedRegistration({
					challengeToken,
					response,
					userVerification: "required",
				});
				return { owner, credential };
			},

			withdraw: ({ transaction, actor }) =>
				challengesOn(transaction).withdrawEveryChallengeOf({ actor, purpose: "recover" }),
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
				const credentialId = credentialIdBytes(response.id);
				const stored = await findOrActivateCredential(credentialId);
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
				write: (tx, read) => {
					refuseRemovingTheLastUsablePasskey(read, credentialId);
					return removeSignInMethod({
						driver: tx,
						schema,
						actor,
						removing: { method: "webauthn_credential", credentialId },
					});
				},
				after: (read) =>
					componentsAfter(read, {
						passkeys: read.passkeys.filter((passkey) => passkey.id !== credentialId),
					}),
			});
		},
	};
}
