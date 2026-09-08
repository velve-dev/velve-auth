import { argon2idAsync } from "@noble/hashes/argon2.js";
import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "../src/core/keys/index.js";
import { encodeStandardBase64 } from "../src/core/password/base64.js";
import { resolvePasswordConfig } from "../src/core/password/config.js";
import { parsePhc } from "../src/core/password/phc.js";
import { type AcceptedPassword, acceptSubmittedPassword } from "../src/core/password/policy.js";
import { LEGACY_SCHEMES, type PasswordScheme } from "../src/core/password/scheme.js";
import { verifyAgainstScheme } from "../src/core/password/verify-switch.js";
import { drawTestPassword, type StoredHashes, storedHashesFor } from "./password-fixtures.js";

const DEFAULTS = resolvePasswordConfig();
const PASSWORD = drawTestPassword();

/** The full switch of architecture 3.3: eight schemes behind eleven prefixes. */
const EVERY_SCHEME: readonly PasswordScheme[] = ["argon2id", ...LEGACY_SCHEMES];

let stored: StoredHashes;

function accepted(plaintext: string): AcceptedPassword {
	const value = acceptSubmittedPassword(plaintext, DEFAULTS);
	if (value === null) {
		throw new Error("the length policy refused a fixture password");
	}
	return value;
}

/** A genuine Argon2id credential at the given version, so that a 1.0 estate can be tested as one. */
async function argon2VectorAtVersion(plaintext: string, version: number): Promise<string> {
	const salt = randomBytes(16);
	const digest = await argon2idAsync(accepted(plaintext).bytes, salt, {
		m: 512,
		t: 2,
		p: 1,
		dkLen: 32,
		version,
	});

	return `$argon2id$v=${version}$m=512,t=2,p=1$${encodeStandardBase64(salt)}$${encodeStandardBase64(digest)}`;
}

beforeAll(async () => {
	stored = await storedHashesFor(PASSWORD);
}, 120_000);

describe("the prefix switch answers false, never a truthy value it cannot explain", () => {
	it("covers every prefix the table in 3.3 lists and refuses everything else", () => {
		expect([...stored.byPrefix.keys()]).toEqual([
			"$argon2id$",
			"$argon2i$",
			"$argon2d$",
			"$2b$",
			"$2a$",
			"$2y$",
			"$2x$",
			"$scrypt$",
			"$pbkdf2-sha256$",
			"$pbkdf2-sha512$",
			"$fbscrypt$",
		]);
	});

	it("refuses a malformed stored value for every one of the eight schemes", async () => {
		const malformed = [
			"",
			"$",
			"$$",
			"$argon2id$",
			"not a hash at all",
			"$md5$v=1$m=1$c2FsdA$aGFzaA",
			"$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA",
			"$argon2id$v=19$m=19456,t=2$c29tZXNhbHRzb21lc2FsdA$aGFzaA",
			"$argon2id$v=19$m=19456,t=2,p=1$c29tZXNh$bHRzb21lc2FsdA$aGFzaA",
			"$argon2id$v=19$m=19456,t=2,p=1$!!!!!!!!$aGFzaA",
			"$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$!!!!",
			"$scrypt$ln=14,r=16$c29tZXNhbHQ$c29tZWhhc2g",
			"$pbkdf2-sha256$$c29tZXNhbHQ$c29tZWhhc2g",
			"$fbscrypt$v=1,n=8,r=8,p=1$c2FsdA$aGFzaA",
		];

		for (const scheme of EVERY_SCHEME) {
			for (const value of malformed) {
				const answer = await verifyAgainstScheme(scheme, accepted(PASSWORD), value);
				expect(answer, `${scheme} on ${JSON.stringify(value)}`).toBe(false);
			}
		}
	}, 120_000);

	it("refuses a credential of one family filed under another family", async () => {
		const familyOf = (scheme: PasswordScheme): string =>
			scheme.startsWith("argon2") ? "argon2" : scheme.startsWith("pbkdf2") ? "pbkdf2" : scheme;

		for (const [prefix, hash] of stored.byPrefix) {
			const filed = prefix.startsWith("$2") ? "bcrypt" : (prefix.slice(1, -1) as PasswordScheme);

			for (const scheme of EVERY_SCHEME) {
				if (familyOf(scheme) === familyOf(filed)) {
					continue;
				}

				const answer = await verifyAgainstScheme(scheme, accepted(PASSWORD), hash);
				expect(answer, `${prefix} filed as ${scheme}`).toBe(false);
			}
		}
	}, 120_000);

	// `acceptLegacy` is applied to the cleartext `scheme` column, but the Argon2 verifier takes its
	// variant from the identifier inside the credential. A row filed as `argon2id` that decrypts to
	// an `$argon2i$` string is therefore verified as Argon2i even when the configuration accepts no
	// legacy scheme at all — the column and the credential disagree and the credential wins.
	it("refuses an Argon2 credential whose identifier disagrees with the scheme it is filed under", async () => {
		for (const filed of ["argon2id", "argon2i", "argon2d"] as const) {
			for (const actual of ["argon2id", "argon2i", "argon2d"] as const) {
				if (filed === actual) {
					continue;
				}

				const answer = await verifyAgainstScheme(
					filed,
					accepted(PASSWORD),
					stored.byScheme[actual],
				);
				expect(answer, `${actual} filed as ${filed}`).toBe(false);
			}
		}
	}, 120_000);

	// The switch indexes a plain object literal with a value that reaches it from the outside. A
	// name inherited from `Object.prototype` therefore resolves to a function, and the result of
	// calling it is not a boolean — `checkPassword` reads it as a match. `isAcceptedScheme` keeps
	// that value away today, so the defect is latent; the exported contract is still `Promise<boolean>`.
	it("answers false for a scheme name inherited from the prototype", async () => {
		for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]) {
			const answer = await verifyAgainstScheme(
				name as PasswordScheme,
				accepted(PASSWORD),
				stored.byScheme.argon2id,
			);
			expect(answer, name).toBe(false);
		}
	}, 120_000);

	// The same shape sits in the PBKDF2 digest table, and there the key does come from the stored
	// string, which an import controls. Today the derivation throws and the switch turns it into
	// `false`; nothing in the code guarantees that the next inherited name behaves the same way.
	it("answers false for a PHC identifier inherited from the prototype", async () => {
		// Only a lower-case identifier reaches the parser, which leaves exactly one inherited name.
		for (const name of ["constructor"]) {
			const value = `$${name}$i=1000$c29tZXNhbHQ$c29tZWhhc2hzb21laGFzaA`;
			expect(parsePhc(value)?.id, name).toBe(name);
			expect(await verifyAgainstScheme("pbkdf2-sha256", accepted(PASSWORD), value), name).toBe(
				false,
			);
		}
	}, 120_000);
});

describe("Argon2 version handling", () => {
	it("verifies a genuine 1.0 credential, spelled with the field and without it", async () => {
		const versionOne = await argon2VectorAtVersion(PASSWORD, 0x10);
		const withoutField = versionOne.replace("$v=16", "");

		expect(parsePhc(withoutField)?.version).toBeUndefined();
		expect(await verifyAgainstScheme("argon2id", accepted(PASSWORD), versionOne)).toBe(true);
		expect(await verifyAgainstScheme("argon2id", accepted(PASSWORD), withoutField)).toBe(true);
	}, 120_000);

	it("keeps a 1.0 credential and a 1.3 credential apart", async () => {
		const versionOne = await argon2VectorAtVersion(PASSWORD, 0x10);
		const thirteen = versionOne.replace("$v=16", "$v=19");

		expect(await verifyAgainstScheme("argon2id", accepted(PASSWORD), versionOne)).toBe(true);
		expect(await verifyAgainstScheme("argon2id", accepted(PASSWORD), thirteen)).toBe(false);
		expect(
			await verifyAgainstScheme("argon2id", accepted(PASSWORD), stored.byScheme.argon2id),
		).toBe(true);
	}, 120_000);
});

describe("the length policy is the same gate for every scheme", () => {
	it("refuses a password of 4097 bytes whatever the stored scheme is", () => {
		expect(acceptSubmittedPassword("a".repeat(4097), DEFAULTS)).toBeNull();
		expect(acceptSubmittedPassword("a".repeat(4096), DEFAULTS)).not.toBeNull();
		expect(acceptSubmittedPassword("1234567", DEFAULTS)).toBeNull();
		expect(acceptSubmittedPassword("12345678", DEFAULTS)).not.toBeNull();
	});

	// L-7 fixes the ceiling in bytes and 3.3 normalises before deriving, so the ceiling applies to
	// the normal form. NFKC composes `U 0308 0301` — three code units, five bytes — into one code
	// unit of two bytes, so the raw code-unit count can exceed the byte count of the normal form.
	// The cheap pre-check compares the raw count against the byte ceiling and refuses a password the
	// ceiling admits.
	it("accepts a password whose normal form is inside the byte ceiling", () => {
		const decomposed = "U\u0308\u0301".repeat(1400);
		const normalised = decomposed.normalize("NFKC");

		expect(decomposed.length).toBeGreaterThan(4096);
		expect(new TextEncoder().encode(normalised).length).toBe(2800);
		expect(acceptSubmittedPassword(decomposed, DEFAULTS)).not.toBeNull();
	});
});
