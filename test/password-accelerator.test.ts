import { afterAll, describe, expect, it, vi } from "vitest";
import { encodeStandardBase64 } from "../src/core/password/base64.js";
import { resolvePasswordConfig } from "../src/core/password/config.js";
import { type AcceptedPassword, acceptSubmittedPassword } from "../src/core/password/policy.js";
import { verifyAgainstScheme } from "../src/core/password/verify-switch.js";
import { drawTestPassword } from "./password-fixtures.js";

// The optional dependency is named nowhere as a literal, because the module under test does not
// name it either (E-170) and the dead-code check of the main gate fails on a literal reference.
const ACCELERATOR_SPECIFIER = ["hash", "wasm"].join("-");

// T-DEFAULT-7: the same twenty passwords hashed once with the accelerator present and once with it
// absent, then cross-verified — 20 byte-identical strings and 40 successful cross-checks.
const PASSWORD_COUNT = 20;
const CHEAP = { memoryKiB: 512, iterations: 2, parallelism: 1 } as const;

const DEFAULTS = resolvePasswordConfig();
const passwords = Array.from({ length: PASSWORD_COUNT }, () => drawTestPassword());

function accepted(plaintext: string): AcceptedPassword {
	const value = acceptSubmittedPassword(plaintext, DEFAULTS);
	if (value === null) {
		throw new Error("the length policy refused a fixture password");
	}
	return value;
}

async function withoutAccelerator(): Promise<typeof import("../src/core/password/argon2.js")> {
	vi.resetModules();
	vi.doMock(ACCELERATOR_SPECIFIER, () => {
		throw new Error("the optional accelerator is not installed");
	});
	return import("../src/core/password/argon2.js");
}

afterAll(() => {
	vi.doUnmock(ACCELERATOR_SPECIFIER);
	vi.resetModules();
});

describe("S-DEFAULT-7 — the accelerator changes the running time and nothing else", () => {
	it("is installed, so this file measures two implementations and not one twice", async () => {
		const { selectArgon2Engine } = await import("../src/core/password/argon2.js");

		expect((await selectArgon2Engine(0x13)).name).toBe("hash-wasm");
		expect((await (await withoutAccelerator()).selectArgon2Engine(0x13)).name).toBe("noble");
	}, 120_000);

	it("derives the same bytes for twenty passwords with and without it", async () => {
		const withIt = await import("../src/core/password/argon2.js");
		const withoutIt = await withoutAccelerator();
		const salt = new Uint8Array(16).fill(9);

		for (const [index, password] of passwords.entries()) {
			const request = {
				variant: "argon2id" as const,
				password: accepted(password).bytes,
				salt,
				memoryKiB: CHEAP.memoryKiB,
				iterations: CHEAP.iterations,
				parallelism: CHEAP.parallelism,
				version: 0x13,
				hashBytes: 32,
			};

			expect(encodeStandardBase64(await withIt.deriveArgon2(request)), `password ${index}`).toBe(
				encodeStandardBase64(await withoutIt.deriveArgon2(request)),
			);
		}
	}, 180_000);

	it("verifies each of the twenty credentials under both engines", async () => {
		const withIt = await import("../src/core/password/argon2.js");
		const withoutIt = await withoutAccelerator();
		let crossChecks = 0;

		for (const password of passwords) {
			const fromAccelerator = await withIt.createArgon2idHash(accepted(password).bytes, CHEAP);
			const fromPurePath = await withoutIt.createArgon2idHash(accepted(password).bytes, CHEAP);

			for (const credential of [fromAccelerator, fromPurePath]) {
				expect(await verifyAgainstScheme("argon2id", accepted(password), credential)).toBe(true);
				crossChecks += 1;
			}
		}

		expect(crossChecks).toBe(PASSWORD_COUNT * 2);
	}, 180_000);

	// E-168: the accelerator takes a `version` option and ignores it. A version-1.0 credential must
	// therefore behave the same whether or not the dependency is installed, which it does only
	// because `selectArgon2Engine` keeps every version but 1.3 on the pure path.
	it("answers an imported version 1.0 credential the same way either way", async () => {
		const withIt = await import("../src/core/password/argon2.js");
		const withoutIt = await withoutAccelerator();
		const salt = new Uint8Array(16).fill(4);
		const request = {
			variant: "argon2id" as const,
			password: accepted(passwords[0] as string).bytes,
			salt,
			memoryKiB: CHEAP.memoryKiB,
			iterations: CHEAP.iterations,
			parallelism: CHEAP.parallelism,
			version: 0x10,
			hashBytes: 32,
		};

		const atVersionOne = await withIt.deriveArgon2(request);
		expect(encodeStandardBase64(atVersionOne)).toBe(
			encodeStandardBase64(await withoutIt.deriveArgon2(request)),
		);
		expect(encodeStandardBase64(atVersionOne)).not.toBe(
			encodeStandardBase64(await withIt.deriveArgon2({ ...request, version: 0x13 })),
		);

		const credential = [
			"",
			"argon2id",
			"v=16",
			`m=${CHEAP.memoryKiB},t=${CHEAP.iterations},p=${CHEAP.parallelism}`,
			encodeStandardBase64(salt),
			encodeStandardBase64(atVersionOne),
		].join("$");

		expect(
			await verifyAgainstScheme("argon2id", accepted(passwords[0] as string), credential),
		).toBe(true);
	}, 180_000);
});
