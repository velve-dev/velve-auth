import { argon2dAsync, argon2iAsync, argon2idAsync } from "@noble/hashes/argon2.js";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { hash as bcryptHash } from "bcryptjs";
import { encodeStandardBase64 } from "../src/core/password/base64.js";
import type { PasswordScheme } from "../src/core/password/scheme.js";
import { randomBytes } from "../src/core/token/random.js";

/** Drawn per run, so that no password and no derived hash of one is ever committed. */
export function drawTestPassword(): string {
	return `velve-${encodeStandardBase64(randomBytes(18))}`;
}

const utf8 = new TextEncoder();

/** Kept low where the parameter value is not what the test is about; a suite has to stay quick. */
const IMPORT_COST = {
	argon2: { m: 512, t: 2, p: 1 },
	scrypt: { ln: 10, r: 8, p: 1 },
	pbkdf2: { i: 1000 },
	bcrypt: 4,
} as const;

export interface StoredHashes {
	readonly byScheme: Readonly<Record<PasswordScheme, string>>;
	/** The eleven prefixes of the switch in 3.3; `bcrypt` contributes four of them. */
	readonly byPrefix: ReadonlyMap<string, string>;
}

export async function storedHashesFor(password: string): Promise<StoredHashes> {
	const bytes = utf8.encode(password.normalize("NFKC"));
	const salt = randomBytes(16);
	const encodedSalt = encodeStandardBase64(salt);

	const argon2 = async (id: "argon2id" | "argon2i" | "argon2d"): Promise<string> => {
		const derive = { argon2id: argon2idAsync, argon2i: argon2iAsync, argon2d: argon2dAsync }[id];
		const digest = await derive(bytes, salt, { ...IMPORT_COST.argon2, dkLen: 32, version: 0x13 });
		const { m, t, p } = IMPORT_COST.argon2;
		return `$${id}$v=19$m=${m},t=${t},p=${p}$${encodedSalt}$${encodeStandardBase64(digest)}`;
	};

	const scrypt = async (): Promise<string> => {
		const { ln, r, p } = IMPORT_COST.scrypt;
		const digest = await scryptAsync(bytes, salt, { N: 2 ** ln, r, p, dkLen: 64 });
		return `$scrypt$ln=${ln},r=${r},p=${p}$${encodedSalt}$${encodeStandardBase64(digest)}`;
	};

	const pbkdf2 = async (id: "pbkdf2-sha256" | "pbkdf2-sha512"): Promise<string> => {
		const { i } = IMPORT_COST.pbkdf2;
		const digest = await pbkdf2Async(id === "pbkdf2-sha256" ? sha256 : sha512, bytes, salt, {
			c: i,
			dkLen: id === "pbkdf2-sha256" ? 32 : 64,
		});
		return `$${id}$i=${i}$${encodedSalt}$${encodeStandardBase64(digest)}`;
	};

	const byScheme = {
		argon2id: await argon2("argon2id"),
		argon2i: await argon2("argon2i"),
		argon2d: await argon2("argon2d"),
		bcrypt: await bcryptHash(password.normalize("NFKC"), IMPORT_COST.bcrypt),
		scrypt: await scrypt(),
		"pbkdf2-sha256": await pbkdf2("pbkdf2-sha256"),
		"pbkdf2-sha512": await pbkdf2("pbkdf2-sha512"),
		fbscrypt: await firebaseScryptFor(password),
	} satisfies Record<PasswordScheme, string>;

	const byPrefix = new Map<string, string>([
		["$argon2id$", byScheme.argon2id],
		["$argon2i$", byScheme.argon2i],
		["$argon2d$", byScheme.argon2d],
		["$2b$", byScheme.bcrypt],
		["$2a$", byScheme.bcrypt.replace("$2b$", "$2a$")],
		["$2y$", byScheme.bcrypt.replace("$2b$", "$2y$")],
		["$2x$", byScheme.bcrypt.replace("$2b$", "$2x$")],
		["$scrypt$", byScheme.scrypt],
		["$pbkdf2-sha256$", byScheme["pbkdf2-sha256"]],
		["$pbkdf2-sha512$", byScheme["pbkdf2-sha512"]],
		["$fbscrypt$", byScheme.fbscrypt],
	]);

	return { byScheme, byPrefix };
}

/**
 * The derivation of architecture 4.4 d), run forwards to produce a credential the verifier then
 * has to read back. `n` is the exponent of `N` and `r` is scrypt's block size.
 */
export async function firebaseScryptFor(
	password: string,
	parameters: {
		readonly costExponent: number;
		readonly blockSize: number;
		readonly salt: Uint8Array<ArrayBuffer>;
		readonly saltSeparator: Uint8Array<ArrayBuffer>;
		readonly signerKey: Uint8Array<ArrayBuffer>;
	} = {
		costExponent: 8,
		blockSize: 8,
		salt: randomBytes(16),
		saltSeparator: new Uint8Array([7]),
		signerKey: randomBytes(32),
	},
): Promise<string> {
	const salted = new Uint8Array(parameters.salt.length + parameters.saltSeparator.length);
	salted.set(parameters.salt);
	salted.set(parameters.saltSeparator, parameters.salt.length);

	const derived = await scryptAsync(utf8.encode(password.normalize("NFKC")), salted, {
		N: 2 ** parameters.costExponent,
		r: parameters.blockSize,
		p: 1,
		dkLen: 64,
	});

	const key = await crypto.subtle.importKey(
		"raw",
		Uint8Array.from(derived.subarray(0, 32)),
		"AES-CTR",
		false,
		["encrypt"],
	);
	const digest = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-CTR", counter: new Uint8Array(16), length: 128 },
			key,
			parameters.signerKey,
		),
	);

	const settings = [
		"v=1",
		`n=${parameters.costExponent}`,
		`r=${parameters.blockSize}`,
		"p=1",
		`ss=${encodeStandardBase64(parameters.saltSeparator)}`,
		`sk=${encodeStandardBase64(parameters.signerKey)}`,
	].join(",");

	return `$fbscrypt$${settings}$${encodeStandardBase64(parameters.salt)}$${encodeStandardBase64(digest)}`;
}

/**
 * The published reference vector of the Firebase scrypt implementation, for a fictitious `user1`
 * (https://github.com/firebase/scrypt, reproduced by nhairs/firebase-scrypt). It is the only way
 * to prove the derivation matches Firebase rather than merely matching itself, which is what
 * architecture 4.4 d) Fallstrick 1 demands. E-171 records why it is here.
 */
export const FIREBASE_REFERENCE_VECTOR = {
	password: "user1password",
	memoryCost: 14,
	rounds: 8,
	saltBase64: "42xEC+ixf3L2lw==",
	saltSeparatorBase64: "Bw==",
	signerKeyBase64:
		"jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==",
	passwordHashBase64:
		"lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==",
} as const;
