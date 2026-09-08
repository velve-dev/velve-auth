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

export const DEFAULT_USERNAME_RULES: UsernameRules = Object.freeze({
	allowedCharacters: /^[a-z0-9_-]+$/,
	minimumLength: 3,
	maximumLength: 32,
	reservedNames: Object.freeze([]) as readonly string[],
});

export class IdentityConfigurationError extends Error {
	readonly code = "invalid_identity_configuration";

	constructor(reason: string) {
		super(`identity configuration rejected: ${reason}`);
		this.name = "IdentityConfigurationError";
	}
}

const REFUSED_FLAGS: Readonly<Record<string, string>> = {
	g: "lastIndex survives between calls, so the same name is accepted and refused in turn",
	y: "lastIndex survives between calls, so the same name is accepted and refused in turn",
	m: "^ and $ then match at a line break, so a name accepts anything after its first line",
};

function refusedFlagIn(flags: string): string | undefined {
	return Object.keys(REFUSED_FLAGS).find((flag) => flags.includes(flag));
}

/** Escapes and character-class contents become dots, so only structure is left to read. */
function structureOf(source: string): string {
	let structure = "";
	let insideCharacterClass = false;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (character === "\\") {
			index += 1;
			structure += "..";
		} else if (insideCharacterClass) {
			insideCharacterClass = character !== "]";
			structure += ".";
		} else if (character === "[") {
			insideCharacterClass = true;
			structure += ".";
		} else {
			structure += character;
		}
	}
	return structure;
}

function hasTopLevelAlternation(structure: string): boolean {
	let groupDepth = 0;
	for (const character of structure) {
		if (character === "(") {
			groupDepth += 1;
		} else if (character === ")") {
			groupDepth -= 1;
		} else if (character === "|" && groupDepth === 0) {
			return true;
		}
	}
	return false;
}

/** Reports why the pattern can match less than a whole name, or nothing if it cannot (E-193). */
function partialMatchIn(source: string): string | undefined {
	const structure = structureOf(source);
	if (hasTopLevelAlternation(structure)) {
		return "each branch of a top-level alternation would need its own anchors";
	}
	if (!structure.startsWith("^") || structure.indexOf("^", 1) !== -1) {
		return "a ^ belongs at the start and nowhere else";
	}
	if (!structure.endsWith("$") || structure.slice(0, -1).includes("$")) {
		return "a $ belongs at the end and nowhere else";
	}
	return undefined;
}

function assertWholeStringPattern(pattern: RegExp): RegExp {
	const partial = partialMatchIn(pattern.source);
	if (partial !== undefined) {
		throw new IdentityConfigurationError(
			`allowedCharacters must match the whole name, and in ${pattern} ${partial}`,
		);
	}
	const flag = refusedFlagIn(pattern.flags);
	if (flag !== undefined) {
		throw new IdentityConfigurationError(
			`allowedCharacters carries the flag ${flag}: ${REFUSED_FLAGS[flag]}`,
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
