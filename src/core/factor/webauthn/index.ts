export type {
	IssuedWebAuthnChallenge,
	WebAuthnChallengePurpose,
	WebAuthnChallenges,
} from "./challenge.js";
export {
	createWebAuthnChallenges,
	WEBAUTHN_CHALLENGE_LIFETIME_SECONDS,
	WEBAUTHN_CHALLENGE_PURPOSES,
} from "./challenge.js";
export type {
	RegistrationUserVerification,
	WebAuthnConfig,
	WebAuthnConfigErrorCode,
	WebAuthnSettings,
} from "./config.js";
export {
	DEFAULT_REGISTRATION_USER_VERIFICATION,
	InvalidWebAuthnConfigError,
	webAuthnSettingsOf,
} from "./config.js";
export type {
	StoredWebAuthnCredential,
	WebAuthnCredential,
	WebAuthnCredentialRepository,
} from "./credential-repository.js";
export {
	createWebAuthnCredentialRepository,
	DuplicateWebAuthnCredentialError,
} from "./credential-repository.js";
export { authenticationResponse, isKnownTransport, registrationResponse } from "./payload.js";
export type {
	VerifiedWebAuthnAssertion,
	WebAuthnAuthenticationChallenge,
	WebAuthnRegistrationChallenge,
	WebAuthnService,
	WebAuthnServiceOptions,
} from "./service.js";
export { createWebAuthnService } from "./service.js";
