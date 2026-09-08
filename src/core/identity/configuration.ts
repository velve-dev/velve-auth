import type { IdentityMode } from "../db/migrations/identity-mode.js";

export interface UsernameRules {
	readonly allowedCharacters: RegExp;
	readonly minimumLength: number;
	readonly maximumLength: number;
	readonly reservedNames: readonly string[];
}

interface EmailIdentity {
	readonly mode: "email";
	readonly username?: never;
}

interface UsernameIdentity {
	readonly mode: "username";
	readonly username: UsernameRules;
}

interface UsernameAndEmailIdentity {
	readonly mode: "username_email";
	readonly username: UsernameRules;
}

interface IdentityByMode {
	readonly email: EmailIdentity;
	readonly username: UsernameIdentity;
	readonly username_email: UsernameAndEmailIdentity;
}

export type IdentityConfiguration<Mode extends IdentityMode = IdentityMode> = IdentityByMode[Mode];

interface IdentityInputByMode {
	readonly email: { readonly mode: "email"; readonly username?: never };
	readonly username: { readonly mode: "username"; readonly username?: Partial<UsernameRules> };
	readonly username_email: {
		readonly mode: "username_email";
		readonly username?: Partial<UsernameRules>;
	};
}

export type IdentityConfigurationInput<Mode extends IdentityMode = IdentityMode> =
	IdentityInputByMode[Mode];

export const DEFAULT_USERNAME_RULES: UsernameRules = {
	allowedCharacters: /^[a-z0-9_-]+$/,
	minimumLength: 3,
	maximumLength: 32,
	reservedNames: [],
};

export class IdentityConfigurationError extends Error {
	readonly code = "invalid_identity_configuration";

	constructor(reason: string) {
		super(`identity configuration rejected: ${reason}`);
		this.name = "IdentityConfigurationError";
	}
}

const STATEFUL_REGEXP_FLAGS = ["g", "y"];

function assertWholeStringPattern(pattern: RegExp): RegExp {
	if (!pattern.source.startsWith("^") || !pattern.source.endsWith("$")) {
		throw new IdentityConfigurationError(
			`allowedCharacters must match the whole name, so ${pattern} needs a leading ^ and a trailing $`,
		);
	}
	const stateful = STATEFUL_REGEXP_FLAGS.filter((flag) => pattern.flags.includes(flag));
	// lastIndex survives between calls, so a global pattern accepts and rejects the same name in turn.
	if (stateful.length > 0) {
		throw new IdentityConfigurationError(
			`allowedCharacters carries the flag ${stateful.join(" and ")}, which makes matching stateful`,
		);
	}
	return pattern;
}

function assertLengthBounds(minimumLength: number, maximumLength: number): void {
	if (!Number.isInteger(minimumLength) || minimumLength < 1) {
		throw new IdentityConfigurationError(
			`minimumLength must be a whole number of at least 1, not ${minimumLength}`,
		);
	}
	if (!Number.isInteger(maximumLength) || maximumLength < minimumLength) {
		throw new IdentityConfigurationError(
			`maximumLength must be a whole number of at least minimumLength, not ${maximumLength}`,
		);
	}
}

function comparisonFormOf(name: string): string {
	return name.normalize("NFKC").toLowerCase();
}

function resolveUsernameRules(overrides: Partial<UsernameRules> | undefined): UsernameRules {
	const allowedCharacters = assertWholeStringPattern(
		overrides?.allowedCharacters ?? DEFAULT_USERNAME_RULES.allowedCharacters,
	);
	const minimumLength = overrides?.minimumLength ?? DEFAULT_USERNAME_RULES.minimumLength;
	const maximumLength = overrides?.maximumLength ?? DEFAULT_USERNAME_RULES.maximumLength;
	assertLengthBounds(minimumLength, maximumLength);
	return {
		allowedCharacters,
		minimumLength,
		maximumLength,
		reservedNames: (overrides?.reservedNames ?? DEFAULT_USERNAME_RULES.reservedNames).map(
			comparisonFormOf,
		),
	};
}

type IdentityBuilders = {
	[Mode in IdentityMode]: (overrides: Partial<UsernameRules> | undefined) => IdentityByMode[Mode];
};

const BUILD_IDENTITY: IdentityBuilders = {
	email: () => ({ mode: "email" }),
	username: (overrides) => ({ mode: "username", username: resolveUsernameRules(overrides) }),
	username_email: (overrides) => ({
		mode: "username_email",
		username: resolveUsernameRules(overrides),
	}),
};

export function resolveIdentityConfiguration<Mode extends IdentityMode>(
	input: IdentityConfigurationInput & { readonly mode: Mode },
): IdentityConfiguration<Mode> {
	return BUILD_IDENTITY[input.mode](input.username);
}
