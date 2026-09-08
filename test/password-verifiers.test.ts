import { hash as bcryptHash, truncates } from "bcryptjs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	type Argon2Engine,
	type Argon2Request,
	createArgon2idHash,
	nobleArgon2,
	selectArgon2Engine,
} from "../src/core/password/argon2.js";
import { decodeStandardBase64 } from "../src/core/password/base64.js";
import { ARGON2ID_FLOOR, resolvePasswordConfig } from "../src/core/password/config.js";
import {
	argon2CostIsAcceptable,
	bcryptCostIsAcceptable,
	MAXIMUM_STORED_ARGON2_ITERATIONS,
	MAXIMUM_STORED_BCRYPT_COST,
	MAXIMUM_STORED_MEMORY_KIB,
	MAXIMUM_STORED_PARALLELISM,
	MAXIMUM_STORED_PBKDF2_ITERATIONS,
	pbkdf2CostIsAcceptable,
	scryptCostIsAcceptable,
} from "../src/core/password/limits.js";
import { integerParameter, parsePhc } from "../src/core/password/phc.js";
import { type AcceptedPassword, acceptSubmittedPassword } from "../src/core/password/policy.js";
import { type PasswordScheme, schemeOfStoredHash } from "../src/core/password/scheme.js";
import { verifyAgainstScheme } from "../src/core/password/verify-switch.js";
import {
	drawTestPassword,
	FIREBASE_REFERENCE_VECTOR,
	firebaseScryptFor,
	type StoredHashes,
	storedHashesFor,
} from "./password-fixtures.js";

const DEFAULTS = resolvePasswordConfig();
const PASSWORD = drawTestPassword();
const WRONG_PASSWORD = drawTestPassword();

let stored: StoredHashes;

function accepted(plaintext: string): AcceptedPassword {
	const value = acceptSubmittedPassword(plaintext, DEFAULTS);
	if (value === null) {
		throw new Error("the length policy refused a fixture password");
	}
	return value;
}

async function verify(scheme: PasswordScheme, plaintext: string, hash: string): Promise<boolean> {
	return verifyAgainstScheme(scheme, accepted(plaintext), hash);
}

beforeAll(async () => {
	stored = await storedHashesFor(PASSWORD);
}, 60_000);

describe("the prefix switch", () => {
	it("names a scheme for each of the eleven prefixes and for nothing else", () => {
		for (const prefix of stored.byPrefix.keys()) {
			expect(schemeOfStoredHash(`${prefix}rest`), prefix).not.toBeNull();
		}

		expect(stored.byPrefix.size).toBe(11);
		expect(schemeOfStoredHash("$md5$abc")).toBeNull();
		expect(schemeOfStoredHash("$sha1$abc")).toBeNull();
		expect(schemeOfStoredHash("plain")).toBeNull();
	});

	it("verifies every one of the eleven prefixes", async () => {
		for (const [prefix, hash] of stored.byPrefix) {
			const scheme = schemeOfStoredHash(hash);
			expect(scheme, prefix).not.toBeNull();
			expect(await verify(scheme as PasswordScheme, PASSWORD, hash), prefix).toBe(true);
		}
	});

	it("refuses the wrong password for every one of the eleven prefixes", async () => {
		for (const [prefix, hash] of stored.byPrefix) {
			const scheme = schemeOfStoredHash(hash) as PasswordScheme;
			expect(await verify(scheme, WRONG_PASSWORD, hash), prefix).toBe(false);
		}
	});

	it("answers false rather than throwing on a stored value it cannot read", async () => {
		const damaged = [
			["argon2id", "$argon2id$v=19$m=512$c2FsdA$aGFzaA"],
			["argon2id", "not a phc string"],
			["scrypt", "$scrypt$ln=999,r=8,p=1$c2FsdA$aGFzaA"],
			["pbkdf2-sha256", "$pbkdf2-sha256$i=0$c2FsdA$aGFzaA"],
			["fbscrypt", "$fbscrypt$v=1,n=8,r=8,p=1$c2FsdA$aGFzaA"],
			["bcrypt", "$2b$this is not a bcrypt hash"],
		] as const;

		for (const [scheme, hash] of damaged) {
			expect(await verify(scheme, PASSWORD, hash), hash).toBe(false);
		}
	});
});

describe("Argon2", () => {
	it("creates exactly the configured parameters", async () => {
		const created = await createArgon2idHash(accepted(PASSWORD).bytes, ARGON2ID_FLOOR);
		const parsed = parsePhc(created);
		if (parsed === null) {
			throw new Error("the created hash is not a PHC string");
		}

		expect(parsed.id).toBe("argon2id");
		expect(parsed.version).toBe(0x13);
		expect(integerParameter(parsed, "m")).toBe(ARGON2ID_FLOOR.memoryKiB);
		expect(integerParameter(parsed, "t")).toBe(ARGON2ID_FLOOR.iterations);
		expect(integerParameter(parsed, "p")).toBe(ARGON2ID_FLOOR.parallelism);
		expect(parsed.salt).toHaveLength(16);
		expect(parsed.hash).toHaveLength(32);
	}, 30_000);

	it("draws a new salt for every hash it creates", async () => {
		const [first, second] = await Promise.all([
			createArgon2idHash(accepted(PASSWORD).bytes, ARGON2ID_FLOOR),
			createArgon2idHash(accepted(PASSWORD).bytes, ARGON2ID_FLOOR),
		]);

		expect(first).not.toBe(second);
		expect(parsePhc(first)?.salt).not.toEqual(parsePhc(second)?.salt);
	}, 30_000);

	it("verifies what it created", async () => {
		const created = await createArgon2idHash(accepted(PASSWORD).bytes, ARGON2ID_FLOOR);

		expect(await verify("argon2id", PASSWORD, created)).toBe(true);
		expect(await verify("argon2id", WRONG_PASSWORD, created)).toBe(false);
	}, 30_000);

	it("reads a missing version field as 1.0, the way the reference decoder does", async () => {
		const withField = stored.byScheme.argon2id;
		const withoutField = withField.replace("$v=19", "");

		expect(await verify("argon2id", PASSWORD, withField)).toBe(true);
		expect(await verify("argon2id", PASSWORD, withoutField)).toBe(false);
	});

	it("keeps the three variants apart", async () => {
		const identifiers = ["argon2id", "argon2i", "argon2d"] as const;

		for (const mine of identifiers) {
			for (const other of identifiers) {
				const swapped = stored.byScheme[other].replace(`$${other}$`, `$${mine}$`);
				expect(await verify(mine, PASSWORD, swapped), `${other} as ${mine}`).toBe(mine === other);
			}
		}
	});
});

describe("the hash-wasm accelerator", () => {
	it("produces the same bytes as the pure path, so its presence needs no migration", async () => {
		const engine: Argon2Engine = await selectArgon2Engine(0x13);
		const request: Argon2Request = {
			variant: "argon2id",
			password: accepted(PASSWORD).bytes,
			salt: new Uint8Array(16).fill(3),
			memoryKiB: 512,
			iterations: 2,
			parallelism: 1,
			version: 0x13,
			hashBytes: 32,
		};

		expect(await engine.derive(request)).toEqual(await nobleArgon2.derive(request));
	});

	it("stays on the pure path at version 1.0, which the accelerator computes as 1.3", async () => {
		expect((await selectArgon2Engine(0x10)).name).toBe("noble");

		const accelerator = await selectArgon2Engine(0x13);
		// The rest of this case describes the accelerator, so it has nothing to say when the
		// optional dependency is absent; the assertion above covers that installation.
		if (accelerator.name !== "hash-wasm") {
			return;
		}

		const request = {
			variant: "argon2id",
			password: accepted(PASSWORD).bytes,
			salt: new Uint8Array(16).fill(3),
			memoryKiB: 512,
			iterations: 2,
			parallelism: 1,
			hashBytes: 32,
		} as const;

		const acceleratedAtVersionOne = await accelerator.derive({ ...request, version: 0x10 });

		expect(await nobleArgon2.derive({ ...request, version: 0x10 })).not.toEqual(
			acceleratedAtVersionOne,
		);
		expect(await nobleArgon2.derive({ ...request, version: 0x13 })).toEqual(
			acceleratedAtVersionOne,
		);
	});

	it("falls back to the pure path when the dependency is not installed", async () => {
		vi.resetModules();
		vi.doMock("hash-wasm", () => {
			throw new Error("the optional accelerator is not installed");
		});

		const isolated = await import("../src/core/password/argon2.js");
		expect((await isolated.selectArgon2Engine(0x13)).name).toBe("noble");

		vi.doUnmock("hash-wasm");
		vi.resetModules();
	});
});

describe("bcrypt", () => {
	it("verifies the three revisions bcryptjs knows and the fourth it does not", async () => {
		for (const prefix of ["$2a$", "$2b$", "$2y$", "$2x$"]) {
			const hash = stored.byPrefix.get(prefix);
			expect(hash, prefix).toBeDefined();
			expect(await verify("bcrypt", PASSWORD, hash as string), prefix).toBe(true);
		}
	});

	it("proves only the first 72 bytes, which is why the rehash matters", async () => {
		const long = `${"a".repeat(72)}first`;
		const other = `${"a".repeat(72)}second`;

		expect(truncates(long)).toBe(true);

		const stored72 = await bcryptHash(long, 4);
		expect(await verify("bcrypt", other, stored72)).toBe(true);
	});
});

describe("Firebase scrypt", () => {
	it("matches the published reference vector, which is what catches a swapped n and r", async () => {
		const vector = FIREBASE_REFERENCE_VECTOR;
		const decoded = (text: string): Uint8Array<ArrayBuffer> => {
			const bytes = decodeStandardBase64(text);
			if (bytes === null) {
				throw new Error("the reference vector is not base64");
			}
			return bytes;
		};

		const phc = await firebaseScryptFor(vector.password, {
			costExponent: vector.memoryCost,
			blockSize: vector.rounds,
			salt: decoded(vector.saltBase64),
			saltSeparator: decoded(vector.saltSeparatorBase64),
			signerKey: decoded(vector.signerKeyBase64),
		});

		expect(parsePhc(phc)?.hash).toEqual(decoded(vector.passwordHashBase64));
		expect(await verify("fbscrypt", vector.password, phc)).toBe(true);
	}, 30_000);

	it("refuses a credential whose n and r were swapped on import", async () => {
		const swapped = stored.byScheme.fbscrypt.replace("n=8,r=8", "n=9,r=7");

		expect(await verify("fbscrypt", PASSWORD, swapped)).toBe(false);
	});
});

describe("the ceiling on a stored cost parameter", () => {
	it("names a ceiling no documented source reaches", () => {
		expect(MAXIMUM_STORED_MEMORY_KIB).toBe(65536);
		expect(MAXIMUM_STORED_ARGON2_ITERATIONS).toBe(64);
		expect(MAXIMUM_STORED_PARALLELISM).toBe(64);
		expect(MAXIMUM_STORED_PBKDF2_ITERATIONS).toBe(2_000_000);

		// Better Auth's scrypt at 32 MiB, Firebase at 16 MiB, Django's PBKDF2 at 1.2 million.
		expect(scryptCostIsAcceptable(14, 16, 1)).toBe(true);
		expect(scryptCostIsAcceptable(14, 8, 1)).toBe(true);
		expect(argon2CostIsAcceptable(19456, 2, 1)).toBe(true);
		expect(pbkdf2CostIsAcceptable(1_200_000)).toBe(true);

		// GoTrue, Auth0 and Clerk all write cost 10.
		expect(MAXIMUM_STORED_BCRYPT_COST).toBe(14);
		expect(bcryptCostIsAcceptable("$2b$10$abcdefghijklmnopqrstuv")).toBe(true);
		expect(bcryptCostIsAcceptable("$2a$14$abcdefghijklmnopqrstuv")).toBe(true);
	});

	// bcrypt has no memory parameter, so the cost is the only bound there is; `$2a$31$` is about
	// thirty years of one semaphore place.
	it("refuses a bcrypt credential whose cost is beyond the ceiling", async () => {
		expect(bcryptCostIsAcceptable("$2a$15$abcdefghijklmnopqrstuv")).toBe(false);
		expect(bcryptCostIsAcceptable("$2a$31$abcdefghijklmnopqrstuv")).toBe(false);
		expect(bcryptCostIsAcceptable("$2a$03$abcdefghijklmnopqrstuv")).toBe(false);
		expect(bcryptCostIsAcceptable("not a bcrypt hash")).toBe(false);

		const costly = stored.byScheme.bcrypt.replace(/^\$2b\$\d\d\$/, "$2b$15$");
		expect(await verify("bcrypt", PASSWORD, costly)).toBe(false);
	});

	it("refuses at the value one past each ceiling", () => {
		expect(argon2CostIsAcceptable(MAXIMUM_STORED_MEMORY_KIB + 1, 2, 1)).toBe(false);
		expect(argon2CostIsAcceptable(1024, MAXIMUM_STORED_ARGON2_ITERATIONS + 1, 1)).toBe(false);
		expect(argon2CostIsAcceptable(1024, 2, MAXIMUM_STORED_PARALLELISM + 1)).toBe(false);
		expect(scryptCostIsAcceptable(14, 8, MAXIMUM_STORED_PARALLELISM + 1)).toBe(false);
		expect(pbkdf2CostIsAcceptable(MAXIMUM_STORED_PBKDF2_ITERATIONS + 1)).toBe(false);
		expect(bcryptCostIsAcceptable(`$2b$${MAXIMUM_STORED_BCRYPT_COST + 1}$abcdefghijklmnop`)).toBe(
			false,
		);
	});

	it("refuses a credential whose parameters would claim more than the ceiling", async () => {
		const beyond = [
			["argon2id", "$argon2id$v=19$m=65537,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$c29tZWhhc2g"],
			["argon2id", "$argon2id$v=19$m=1024,t=65,p=1$c29tZXNhbHRzb21lc2FsdA$c29tZWhhc2g"],
			["argon2id", "$argon2id$v=19$m=1024,t=2,p=65$c29tZXNhbHRzb21lc2FsdA$c29tZWhhc2g"],
			["scrypt", "$scrypt$ln=20,r=8,p=1$c29tZXNhbHQ$c29tZWhhc2g"],
			["scrypt", "$scrypt$ln=9999999999,r=8,p=1$c29tZXNhbHQ$c29tZWhhc2g"],
			["pbkdf2-sha256", "$pbkdf2-sha256$i=2000001$c29tZXNhbHQ$c29tZWhhc2g"],
			["fbscrypt", "$fbscrypt$v=1,n=20,r=8,p=1,ss=Bw==,sk=c2lnbmVy$c2FsdA$aGFzaA"],
		] as const;

		for (const [scheme, hash] of beyond) {
			expect(await verify(scheme, PASSWORD, hash), hash).toBe(false);
		}
	});

	it("refuses without spending the derivation the parameters asked for", async () => {
		const started = Date.now();

		expect(await verify("scrypt", PASSWORD, "$scrypt$ln=30,r=64,p=1$c29tZXNhbHQ$c29tZWhhc2g")).toBe(
			false,
		);
		expect(Date.now() - started).toBeLessThan(1000);
	});
});
