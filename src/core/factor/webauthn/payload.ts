import type {
	AuthenticationResponseJSON,
	AuthenticatorAssertionResponseJSON,
	AuthenticatorAttestationResponseJSON,
	AuthenticatorTransportFuture,
	RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
	arrayOf,
	isRecord,
	number,
	object,
	oneOf,
	optional,
	string,
	unknownRecord,
} from "../../http/validators.js";

interface Validator<T> {
	parse(raw: unknown): T;
}

/** Every key of the WebAuthn shape has to be declared, so a field the specification adds fails
 * the build instead of being dropped in silence (E-454). */
type DeclaresEveryFieldOf<Shape> = Record<keyof Shape, unknown>;

/** An inherited property is not a property the caller sent. */
function declaredFieldsOnly(raw: unknown, fields: readonly string[]): unknown {
	if (!isRecord(raw)) {
		return raw;
	}
	const declared: Record<string, unknown> = {};
	for (const field of fields) {
		if (Object.hasOwn(raw, field)) {
			declared[field] = raw[field];
		}
	}
	return declared;
}

/**
 * The credential JSON is written by the browser against a living specification, not by the
 * caller, so a field it grows and nothing here reads is ignored rather than answered with
 * `invalid_input` (E-455). The route's own input stays strict.
 */
function openObject<Shape extends Record<string, Validator<unknown>>>(shape: Shape) {
	const strict = object(shape);
	return { parse: (raw: unknown) => strict.parse(declaredFieldsOnly(raw, strict.fields)) };
}

/** Both directions at once: a name the verifier does not know cannot be listed here, and a name
 * the verifier adds leaves a key missing. */
const IS_A_KNOWN_TRANSPORT: Readonly<Record<AuthenticatorTransportFuture, true>> = {
	ble: true,
	cable: true,
	hybrid: true,
	internal: true,
	nfc: true,
	"smart-card": true,
	usb: true,
};

export function isKnownTransport(value: string): value is AuthenticatorTransportFuture {
	return Object.hasOwn(IS_A_KNOWN_TRANSPORT, value);
}

const attestationResponseShape = {
	clientDataJSON: string(),
	attestationObject: string(),
	authenticatorData: optional(string()),
	transports: optional(arrayOf(string())),
	publicKeyAlgorithm: optional(number()),
	publicKey: optional(string()),
} satisfies DeclaresEveryFieldOf<AuthenticatorAttestationResponseJSON>;

const assertionResponseShape = {
	clientDataJSON: string(),
	authenticatorData: string(),
	signature: string(),
	userHandle: optional(string()),
} satisfies DeclaresEveryFieldOf<AuthenticatorAssertionResponseJSON>;

const registrationShape = {
	id: string(),
	rawId: string(),
	response: openObject(attestationResponseShape),
	authenticatorAttachment: optional(string()),
	clientExtensionResults: unknownRecord(),
	type: oneOf("public-key"),
} satisfies DeclaresEveryFieldOf<RegistrationResponseJSON>;

const authenticationShape = {
	id: string(),
	rawId: string(),
	response: openObject(assertionResponseShape),
	authenticatorAttachment: optional(string()),
	clientExtensionResults: unknownRecord(),
	type: oneOf("public-key"),
} satisfies DeclaresEveryFieldOf<AuthenticationResponseJSON>;

const registrationValidator = openObject(registrationShape);
const authenticationValidator = openObject(authenticationShape);

/**
 * `transports` and `authenticatorAttachment` are hints neither verifier reads for acceptance, so
 * a value shipping in a browser ahead of the verifier's type is dropped here rather than
 * rejecting the ceremony over a field that decides nothing (E-453).
 */
export function registrationResponse(): Validator<RegistrationResponseJSON> {
	return {
		parse: (raw) => {
			const parsed = registrationValidator.parse(raw);
			const { transports, ...rest } = parsed.response;
			const known = transports?.filter(isKnownTransport);
			return {
				id: parsed.id,
				rawId: parsed.rawId,
				clientExtensionResults: parsed.clientExtensionResults,
				type: parsed.type,
				response: known === undefined ? rest : { ...rest, transports: known },
			};
		},
	};
}

export function authenticationResponse(): Validator<AuthenticationResponseJSON> {
	return {
		parse: (raw) => {
			const parsed = authenticationValidator.parse(raw);
			return {
				id: parsed.id,
				rawId: parsed.rawId,
				clientExtensionResults: parsed.clientExtensionResults,
				type: parsed.type,
				response: parsed.response,
			};
		},
	};
}
