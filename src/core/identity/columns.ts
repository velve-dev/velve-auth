import type { IdentityMode } from "../db/migrations/identity-mode.js";
import type { IdentityConfiguration } from "./configuration.js";
import {
	type EmailRejection,
	type Normalisation,
	normaliseEmail,
	normaliseUsername,
	type UsernameRejection,
} from "./normalise.js";

export type IdentifierKind = "email" | "username";

//this must agree with the user_identity_mode CHECK in the schema (E-195)
export const REQUIRED_IDENTIFIERS: Readonly<Record<IdentityMode, readonly IdentifierKind[]>> = {
	email: ["email"],
	username: ["username"],
	username_email: ["email", "username"],
};

//both username columns are set or neither as the pairing CHECK demands
export type IdentityColumns = { readonly email: string | null } & (
	| { readonly username: string; readonly usernameKey: string }
	| { readonly username: null; readonly usernameKey: null }
);

export interface ProvidedIdentifiers {
	readonly email?: string | null;
	readonly username?: string | null;
}

export interface IdentifierRejection {
	readonly identifier: IdentifierKind;
	readonly rejection: EmailRejection | UsernameRejection | "required" | "not_configured";
}

function isRequired(configuration: IdentityConfiguration, identifier: IdentifierKind): boolean {
	return REQUIRED_IDENTIFIERS[configuration.mode].includes(identifier);
}

function resolveEmailColumn(
	configuration: IdentityConfiguration,
	provided: string | null | undefined,
): Normalisation<string | null, IdentifierRejection> {
	//an address nobody reported is never invented (E-16)
	if (provided === null || provided === undefined) {
		return isRequired(configuration, "email")
			? { accepted: false, rejection: { identifier: "email", rejection: "required" } }
			: { accepted: true, value: null };
	}
	const normalised = normaliseEmail(provided);
	return normalised.accepted
		? { accepted: true, value: normalised.value }
		: {
				accepted: false,
				rejection: { identifier: "email", rejection: normalised.rejection },
			};
}

type UsernameColumns =
	| { readonly username: string; readonly usernameKey: string }
	| { readonly username: null; readonly usernameKey: null };

function resolveUsernameColumns(
	configuration: IdentityConfiguration,
	provided: string | null | undefined,
): Normalisation<UsernameColumns, IdentifierRejection> {
	if (provided === null || provided === undefined) {
		return isRequired(configuration, "username")
			? { accepted: false, rejection: { identifier: "username", rejection: "required" } }
			: { accepted: true, value: { username: null, usernameKey: null } };
	}
	if (configuration.username === undefined) {
		return {
			accepted: false,
			rejection: { identifier: "username", rejection: "not_configured" },
		};
	}
	const normalised = normaliseUsername(provided, configuration.username);
	return normalised.accepted
		? { accepted: true, value: normalised.value }
		: {
				accepted: false,
				rejection: { identifier: "username", rejection: normalised.rejection },
			};
}

export function identityColumns(
	configuration: IdentityConfiguration,
	provided: ProvidedIdentifiers,
): Normalisation<IdentityColumns, IdentifierRejection> {
	const email = resolveEmailColumn(configuration, provided.email);
	if (!email.accepted) {
		return email;
	}
	const username = resolveUsernameColumns(configuration, provided.username);
	if (!username.accepted) {
		return username;
	}
	return { accepted: true, value: { email: email.value, ...username.value } };
}
