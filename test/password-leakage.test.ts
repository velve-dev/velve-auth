import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { type KeyProvider, rootKeyProvider } from "../src/core/keys/index.js";
import { resolvePasswordConfig } from "../src/core/password/config.js";
import {
	createPasswordCredentialRepository,
	type PasswordCredentialRow,
	sealPhc,
} from "../src/core/password/credential.js";
import { PasswordConfigurationError } from "../src/core/password/errors.js";
import { acceptNewPassword } from "../src/core/password/policy.js";
import { createKdfSemaphore } from "../src/core/password/semaphore.js";
import {
	checkPassword,
	createDummyCredential,
	type PasswordEnvironment,
	setPassword,
} from "../src/core/password/verify.js";
import { generateRootKey } from "./keys-fixtures.js";
import { drawTestPassword, type StoredHashes, storedHashesFor } from "./password-fixtures.js";

const MODULE_DIRECTORY = "src/core/password";
const USER_ID = "11111111-1111-1111-1111-111111111111";
const PASSWORD = drawTestPassword();
const WRONG_PASSWORD = drawTestPassword();
const CHEAP_ARGON2ID = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

interface SourceFile {
	readonly path: string;
	readonly text: string;
}

function readModuleSources(directory: string): SourceFile[] {
	const files: SourceFile[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...readModuleSources(path));
		} else if (entry.name.endsWith(".ts")) {
			files.push({ path, text: readFileSync(path, "utf8") });
		}
	}
	return files;
}

const sources = readModuleSources(MODULE_DIRECTORY);

const CITATION =
	/S-[A-Z]+-\d|L-\d|E-\d|T-[A-Z]+-\d|section \d|\b\d\.\d{1,2}\b|RFC|NIST|OWASP|GoTrue|PHC|crypt_blowfish|Argon2|bcrypt|scrypt|NFKC|Clerk|Auth0|Supabase|Firebase|Better Auth/;

const DERIVATION = /\b(?:deriveArgon2|deriveScrypt|pbkdf2Async|scryptAsync)\(/;
const COMPARISON = /(?:===|!==|\.startsWith\(|\.includes\(|\.localeCompare\(|\.indexOf\()/;
const DERIVED_NAME = /\b(?:derived|encrypted)\b/;

function comparesDerivedKey(line: string): boolean {
	return COMPARISON.test(line) && DERIVED_NAME.test(line);
}

const COMMENT_LINE = /^(?:\/\/|\/\*|\*)/;

interface CommentBlock {
	readonly line: number;
	readonly text: string;
}

function commentBlocksOf(source: SourceFile): CommentBlock[] {
	const blocks: CommentBlock[] = [];
	let started = 0;
	let collected: string[] = [];

	for (const [index, raw] of source.text.split("\n").entries()) {
		const line = raw.trim();
		if (COMMENT_LINE.test(line)) {
			started = collected.length === 0 ? index + 1 : started;
			collected.push(line);
			continue;
		}
		if (collected.length > 0) {
			blocks.push({ line: started, text: collected.join(" ") });
			collected = [];
		}
	}

	return collected.length === 0
		? blocks
		: [...blocks, { line: started, text: collected.join(" ") }];
}

interface Harness {
	readonly environment: PasswordEnvironment;
	readonly rows: Map<string, PasswordCredentialRow>;
	readonly keys: KeyProvider;
	readonly validateCalls: string[];
}

async function createHarness(
	stored: StoredHashes,
	options: {
		readonly validate?: (plaintext: string) => Promise<void>;
		readonly forgetKeyVersion?: boolean;
	} = {},
): Promise<Harness> {
	const validateCalls: string[] = [];
	const inner = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
	const keys: KeyProvider = {
		current: inner.current.bind(inner),
		byVersion: async (purpose, version) =>
			options.forgetKeyVersion === true && version === 1 && purpose === "password-enc"
				? null
				: inner.byVersion(purpose, version),
	};

	const config = resolvePasswordConfig({
		argon2id: CHEAP_ARGON2ID,
		...(options.validate === undefined
			? {}
			: {
					validate: async (plaintext: string) => {
						validateCalls.push(plaintext);
						await options.validate?.(plaintext);
					},
				}),
	});

	const rows = new Map<string, PasswordCredentialRow>();
	const sealed = await sealPhc(inner, stored.byScheme.argon2id);
	rows.set(USER_ID, {
		userId: USER_ID,
		phc: sealed.ciphertext,
		keyVersion: sealed.keyVersion,
		scheme: "argon2id",
	});

	const driver: Driver = {
		async query<T>(sql: string, parameters: unknown[]): Promise<T[]> {
			if (sql.includes("SELECT")) {
				const row = rows.get(String(parameters[0]));
				return row === undefined
					? []
					: ([
							{
								user_id: row.userId,
								phc: row.phc,
								key_version: row.keyVersion,
								scheme: row.scheme,
							},
						] as T[]);
			}
			// The upsert returns the row it wrote; a repository that is told nothing was written
			// refuses, because that is what a false `DO UPDATE … WHERE` looks like (E-185).
			return (sql.includes("INSERT") ? [{ user_id: parameters[0] }] : []) as T[];
		},
		transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
			return fn(driver);
		},
	};

	return {
		environment: {
			config,
			keys,
			credentials: createPasswordCredentialRepository({ driver, keys: inner }),
			semaphore: createKdfSemaphore({ limit: config.concurrentHashLimit }),
			dummy: await createDummyCredential(inner, config),
		},
		rows,
		keys,
		validateCalls,
	};
}

let stored: StoredHashes;

describe("repository rules section 3 — what the module may contain", () => {
	it("reads at least the eighteen files of the module", () => {
		expect(sources.length).toBeGreaterThanOrEqual(18);
	});

	it.each([
		["a console call", /\bconsole\s*\./],
		["an `any` in a type position", /(?::|<|\bas)\s+any\b/],
		["a suppression comment", /@ts-(?:ignore|expect-error)/],
		["a default export", /\bexport\s+default\b/],
		["a `var` declaration", /\bvar\s+[A-Za-z_$]/],
	])("contains no %s", (_name, pattern) => {
		const offenders = sources
			.filter((source) => pattern.test(source.text))
			.map((source) => source.path);

		expect(offenders).toEqual([]);
	});

	// S-TIM-3 forbids `===`, `startsWith`, `includes` and `localeCompare` on a value of the branded
	// type. T-TIM-3 asks for a `ts-morph` rule over all of `src/core/**`; no such rule exists in the
	// repository and `ts-morph` is not a dependency, so this stands in for it inside this module:
	// every derived value must leave its verifier through `derivedKeysAreEqual` and no other way.
	it("compares a derived key only through the constant-time comparison", () => {
		const deriving = sources.filter(
			(source) => source.path.includes("verifiers") && DERIVATION.test(source.text),
		);
		const offenders = deriving.flatMap((source) =>
			source.text
				.split("\n")
				.map((raw, index) => ({ line: raw.trim(), number: index + 1 }))
				.filter((entry) => !COMMENT_LINE.test(entry.line) && comparesDerivedKey(entry.line))
				.map((entry) => `${source.path}:${entry.number}`),
		);

		expect(deriving).toHaveLength(4);
		expect(offenders).toEqual([]);
		for (const source of deriving) {
			expect(source.text, source.path).toContain("derivedKeysAreEqual(");
		}
	});

	// A module specifier that is assembled rather than written is invisible to the bundler, to the
	// dead-code check and to a dependency audit — the connection between this library and the
	// package it loads cannot be found by reading or by tooling. E-170 records the reason and asks
	// the gate to undo it; until then the specifier is a literal nowhere.
	it("writes every dynamic import specifier as a literal", () => {
		const offenders: string[] = [];
		for (const source of sources) {
			for (const [index, line] of source.text.split("\n").entries()) {
				const match = /\bimport\(([^)]*)\)/.exec(line);
				if (match === null) {
					continue;
				}
				const argument = (match[1] ?? "").trim();
				if (!/^["'`][^"'`]+["'`]$/.test(argument)) {
					offenders.push(`${source.path}:${index + 1} ${argument}`);
				}
			}
		}

		expect(offenders).toEqual([]);
	});

	// A single NUL byte makes git classify a source file as binary, which hides it from `git grep`
	// and renders its diff as "Bin" — `ci.yml` names this escape, and this module has already
	// shipped one. The check covers the module's own tests, because that is where it happened.
	it("contains no NUL byte, here or in the tests of this module", () => {
		const scanned = [
			...sources,
			...readdirSync("test")
				.filter((name) => name.startsWith("password-") && name.endsWith(".ts"))
				.map((name) => ({
					path: join("test", name),
					text: readFileSync(join("test", name), "utf8"),
				})),
		];

		expect(scanned.length).toBeGreaterThan(25);
		expect(scanned.filter((source) => source.text.includes("\u0000")).map((s) => s.path)).toEqual(
			[],
		);
	});

	// Repository rules section 3: a comment is permitted only where the reason cannot be expressed
	// in code, and a reference to the specification is the legitimate case. A comment block that
	// cites no clause is a comment that describes what the code does.
	it("cites a specification clause in every comment block", () => {
		const uncited = sources.flatMap((source) =>
			commentBlocksOf(source)
				.filter((block) => !CITATION.test(block.text))
				.map((block) => `${source.path}:${block.line}`),
		);

		expect(uncited).toEqual([]);
	});
});

describe("L-7 — the validate hook cannot run at sign-in", () => {
	it("is not a field of the type the sign-in path takes", () => {
		const policy = readFileSync(join(MODULE_DIRECTORY, "policy.ts"), "utf8");
		const config = readFileSync(join(MODULE_DIRECTORY, "config.ts"), "utf8");

		expect(
			/export function acceptSubmittedPassword\([\s\S]*?policy: PasswordPolicy/.test(policy),
		).toBe(true);
		expect(/interface PasswordPolicy \{[^}]*\}/.exec(config)?.[0]).not.toContain("validate");
	});

	it("is named in no file other than the configuration and the setting path", () => {
		const withoutComments = (text: string): string =>
			text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
		const mentions = sources
			.filter((source) => /\bvalidate\b/.test(withoutComments(source.text)))
			.map((source) => source.path)
			.sort();

		expect(mentions).toEqual([
			join(MODULE_DIRECTORY, "config.ts"),
			join(MODULE_DIRECTORY, "policy.ts"),
		]);
	});

	it("runs for no sign-in outcome at all", async () => {
		stored = stored ?? (await storedHashesFor(PASSWORD));
		const harness = await createHarness(stored, { validate: async () => undefined });

		for (const attempt of [
			{ userId: USER_ID, plaintext: PASSWORD },
			{ userId: USER_ID, plaintext: WRONG_PASSWORD },
			{ userId: null, plaintext: PASSWORD },
			{ userId: "22222222-2222-2222-2222-222222222222", plaintext: PASSWORD },
			{ userId: USER_ID, plaintext: "short" },
		]) {
			await checkPassword(attempt, harness.environment);
		}

		expect(harness.validateCalls).toEqual([]);
	}, 120_000);

	it("runs exactly once when a password is set, on the normalised form", async () => {
		stored = stored ?? (await storedHashesFor(PASSWORD));
		const harness = await createHarness(stored, { validate: async () => undefined });
		const decomposed = "passworéword";

		await setPassword({ userId: USER_ID, plaintext: decomposed }, harness.environment);

		expect(harness.validateCalls).toEqual([decomposed.normalize("NFKC")]);
	}, 120_000);

	it("turns a refusal from the hook into one code and no reason", async () => {
		stored = stored ?? (await storedHashesFor(PASSWORD));
		const secret = "the-hook-saw-this-plaintext";
		const harness = await createHarness(stored, {
			validate: async (plaintext: string) => {
				throw new Error(`rejected ${plaintext} against ${secret}`);
			},
		});

		const failure = await acceptNewPassword(PASSWORD, harness.environment.config).catch(
			(error: unknown) => error,
		);

		expect(failure).toMatchObject({ code: "password_unacceptable" });
		expect(
			JSON.stringify({ ...(failure as object), message: (failure as Error).message }),
		).not.toContain(secret);
		expect((failure as Error).stack ?? "").not.toContain(PASSWORD);
	}, 120_000);
});

describe("nothing carries a password or a derived hash outwards", () => {
	it("keeps the plaintext out of every sign-in answer", async () => {
		stored = stored ?? (await storedHashesFor(PASSWORD));
		const harness = await createHarness(stored);

		for (const attempt of [
			{ userId: USER_ID, plaintext: PASSWORD },
			{ userId: USER_ID, plaintext: WRONG_PASSWORD },
			{ userId: null, plaintext: PASSWORD },
			{ userId: USER_ID, plaintext: "short" },
		]) {
			const check = await checkPassword(attempt, harness.environment);
			const rendered = JSON.stringify(check, (_key, value: unknown) =>
				typeof value === "function" ? String(value) : value,
			);

			expect(rendered).not.toContain(attempt.plaintext);
			expect(rendered).not.toContain(stored.byScheme.argon2id);
		}
	}, 120_000);

	it("keeps a value out of every configuration error message", () => {
		for (const config of [
			{ argon2id: { memoryKiB: 1, iterations: 2, parallelism: 1 } },
			{ minimumLength: 3 },
			{ maximumLengthInBytes: 99999 },
			{ concurrentHashLimit: 0 },
		]) {
			try {
				resolvePasswordConfig(config);
				throw new Error("the configuration was accepted");
			} catch (failure) {
				expect(failure).toBeInstanceOf(PasswordConfigurationError);
				expect((failure as Error).message).not.toMatch(/\b(?:1|3|99999|0)\b(?!9456|096)/);
			}
		}
	});

	it("commits no password and no derived hash beyond the one documented vector", () => {
		const fixture = readFileSync("test/password-fixtures.ts", "utf8");
		const encodedLiterals = fixture.match(/"\$[a-z0-9-]+\$[^"]{20,}"/g) ?? [];

		expect(encodedLiterals).toEqual([]);
		expect(fixture).toContain("FIREBASE_REFERENCE_VECTOR");
		expect(fixture).toContain("E-171");
	});
});

describe("S-TIM-1 — no throw between step 2 and step 4 of the sequence", () => {
	it("answers a credential under a key version that left the ring the way it answers any other failure", async () => {
		stored = stored ?? (await storedHashesFor(PASSWORD));
		const harness = await createHarness(stored, { forgetKeyVersion: true });

		const forMissingUser = await checkPassword(
			{ userId: null, plaintext: PASSWORD },
			harness.environment,
		).catch((failure: unknown) => failure);
		const forDeadKeyVersion = await checkPassword(
			{ userId: USER_ID, plaintext: PASSWORD },
			harness.environment,
		).catch((failure: unknown) => failure);

		expect(forMissingUser).toMatchObject({ outcome: "refused" });
		expect(forDeadKeyVersion).toMatchObject({ outcome: "refused" });
	}, 120_000);
});
