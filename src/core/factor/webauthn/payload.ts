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

//every key must be declared so a new specification field fails the build (E-454)
type DeclaresEveryFieldOf<Shape> = Record<keyof Shape, unknown>;

//an inherited property is not a property the caller sent (E-456)
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

//what leaves this module must not inherit anything either (E-481)
function withoutInheritance<T extends object>(value: T): T {
	Object.setPrototypeOf(value, null);
	return value;
}

//unknown fields the browser adds are ignored, not answered with invalid input (E-455)
function openObject<Shape extends Record<string, Validator<unknown>>>(shape: Shape) {
	const strict = object(shape);
	return {
		parse: (raw: unknown) =>
			withoutInheritance(strict.parse(declaredFieldsOnly(raw, strict.fields))),
	};
}

//a transport missing here or unknown to the verifier fails the build
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

//transport hints decide nothing so an unknown value is dropped, not rejected (E-453)
export function registrationResponse(): Validator<RegistrationResponseJSON> {
	return {
		parse: (raw) => {
			const parsed = registrationValidator.parse(raw);
			const { transports, ...rest } = parsed.response;
			const known = transports?.filter(isKnownTransport);
			return withoutInheritance({
				id: parsed.id,
				rawId: parsed.rawId,
				clientExtensionResults: parsed.clientExtensionResults,
				type: parsed.type,
				response: withoutInheritance(known === undefined ? rest : { ...rest, transports: known }),
			});
		},
	};
}

export function authenticationResponse(): Validator<AuthenticationResponseJSON> {
	return {
		parse: (raw) => {
			const parsed = authenticationValidator.parse(raw);
			return withoutInheritance({
				id: parsed.id,
				rawId: parsed.rawId,
				clientExtensionResults: parsed.clientExtensionResults,
				type: parsed.type,
				response: withoutInheritance(parsed.response),
			});
		},
	};
}
