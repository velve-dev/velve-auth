import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAXIMUM_STORED_MEMORY_KIB } from "../src/core/password/limits.js";

/**
 * T-DEFAULT-7 at the configured parameters. Each PHC string comes from the library's own
 * `createArgon2idHash`, with the salt it draws fixed per password, once in a module graph that
 * loads `hash-wasm` and once in a graph where the import fails, and each graph then verifies what
 * the other one wrote.
 */

const salts = vi.hoisted(() => ({ queued: [] as Uint8Array<ArrayBuffer>[] }));

vi.mock("../src/core/token/random.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/token/random.js")>();
	return {
		...original,
		randomBytes: (length: number) => salts.queued.shift() ?? original.randomBytes(length),
	};
});

const PASSWORD_COUNT = 20;
const CONFIGURED_ARGON2ID = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const SALT_BYTES = 16;

interface Engine {
	readonly name: string;
	hash(password: string, salt: Uint8Array<ArrayBuffer>): Promise<string>;
	verify(password: string, phc: string): Promise<boolean>;
}

async function loadEngine(): Promise<Engine> {
	const argon2 = await import("../src/core/password/argon2.js");
	const { acceptSubmittedPassword } = await import("../src/core/password/policy.js");
	const { resolvePasswordConfig } = await import("../src/core/password/config.js");
	const { verifyAgainstScheme } = await import("../src/core/password/verify-switch.js");
	const config = resolvePasswordConfig({ argon2id: CONFIGURED_ARGON2ID });
	const accepted = (plaintext: string) => {
		const value = acceptSubmittedPassword(plaintext, config);
		if (value === null) {
			throw new Error("the length policy refused a fixture password");
		}
		return value;
	};

	return {
		name: (await argon2.selectArgon2Engine(0x13)).name,
		hash: (password, salt) => {
			salts.queued.push(salt);
			return argon2.createArgon2idHash(accepted(password).bytes, config.argon2id);
		},
		verify: (password, phc) =>
			verifyAgainstScheme("argon2id", accepted(password), phc, MAXIMUM_STORED_MEMORY_KIB),
	};
}

const passwords = Array.from({ length: PASSWORD_COUNT }, (_, index) => `velve-fixed-${index}-pw`);
const saltOf = (index: number) => new Uint8Array(SALT_BYTES).fill(index + 1);

let accelerated: Engine;
let pure: Engine;
const madeByAccelerator: string[] = [];
const madeByPurePath: string[] = [];

beforeAll(async () => {
	vi.resetModules();
	accelerated = await loadEngine();
	vi.resetModules();
	vi.doMock("hash-wasm", () => {
		throw new Error("the optional accelerator is not installed");
	});
	pure = await loadEngine();

	for (const [index, password] of passwords.entries()) {
		madeByAccelerator.push(await accelerated.hash(password, saltOf(index)));
		madeByPurePath.push(await pure.hash(password, saltOf(index)));
	}
}, 120_000);

afterAll(() => {
	vi.doUnmock("hash-wasm");
	vi.resetModules();
});

describe("T-DEFAULT-7 — the accelerator changes nothing but the running time (S-DEFAULT-7)", () => {
	it("compares two implementations and not one twice", () => {
		expect([accelerated.name, pure.name]).toStrictEqual(["hash-wasm", "noble"]);
		expect(salts.queued).toStrictEqual([]);
	});

	it("writes twenty byte-identical PHC strings at the configured parameters", () => {
		let identical = 0;
		for (const [index, phc] of madeByAccelerator.entries()) {
			const other = madeByPurePath[index] ?? "";
			expect(phc).toContain(
				`$m=${CONFIGURED_ARGON2ID.memoryKiB},t=${CONFIGURED_ARGON2ID.iterations},p=${CONFIGURED_ARGON2ID.parallelism}$`,
			);
			expect(Buffer.compare(Buffer.from(phc), Buffer.from(other)), `password ${index}`).toBe(0);
			identical += 1;
		}

		expect(identical).toBe(PASSWORD_COUNT);
		expect(new Set(madeByAccelerator).size, "twenty distinct strings").toBe(PASSWORD_COUNT);
	});

	it("verifies every string crosswise, forty of forty", async () => {
		let crossChecks = 0;
		for (const [index, password] of passwords.entries()) {
			expect(await pure.verify(password, madeByAccelerator[index] ?? "")).toBe(true);
			crossChecks += 1;
			expect(await accelerated.verify(password, madeByPurePath[index] ?? "")).toBe(true);
			crossChecks += 1;
		}

		expect(crossChecks).toBe(2 * PASSWORD_COUNT);
	}, 120_000);

	it("refuses a wrong password crosswise, so a true above is not the only answer", async () => {
		expect(await pure.verify("velve-not-the-password", madeByAccelerator[0] ?? "")).toBe(false);
		expect(await accelerated.verify("velve-not-the-password", madeByPurePath[0] ?? "")).toBe(false);
	}, 60_000);
});
