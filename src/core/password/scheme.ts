export const LEGACY_SCHEMES = [
	"argon2i",
	"argon2d",
	"bcrypt",
	"scrypt",
	"pbkdf2-sha256",
	"pbkdf2-sha512",
	"fbscrypt",
] as const;

export type LegacyScheme = (typeof LEGACY_SCHEMES)[number];

/** Argon2id is the only scheme the library creates; the other seven it only verifies (3.3). */
export type PasswordScheme = "argon2id" | LegacyScheme;

export const CREATED_SCHEME = "argon2id";

const SCHEME_BY_PREFIX: ReadonlyArray<readonly [string, PasswordScheme]> = [
	["$argon2id$", "argon2id"],
	["$argon2i$", "argon2i"],
	["$argon2d$", "argon2d"],
	["$2a$", "bcrypt"],
	["$2b$", "bcrypt"],
	["$2y$", "bcrypt"],
	["$2x$", "bcrypt"],
	["$scrypt$", "scrypt"],
	["$pbkdf2-sha256$", "pbkdf2-sha256"],
	["$pbkdf2-sha512$", "pbkdf2-sha512"],
	["$fbscrypt$", "fbscrypt"],
];

export function schemeOfStoredHash(phc: string): PasswordScheme | null {
	return SCHEME_BY_PREFIX.find(([prefix]) => phc.startsWith(prefix))?.[1] ?? null;
}

export function isLegacyScheme(scheme: string): scheme is LegacyScheme {
	return (LEGACY_SCHEMES as readonly string[]).includes(scheme);
}
