import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import { inOneTransaction, type OpenTransaction } from "../src/core/auth/account-envelopes.js";
import { sealRowPresenceOf, unboundReadingOf } from "../src/core/auth/security-state.js";
import { VelveStartupError } from "../src/core/auth/startup.js";
import type { Driver } from "../src/core/db/driver.js";
import {
	decryptUnderAdditionalData,
	encryptWithPurposeKey,
	type PurposeCiphertext,
} from "../src/core/keys/envelope.js";
import {
	type BoundColumn,
	boundAdditionalData,
	decryptBound,
	type EnvelopeBinding,
	encryptBound,
	rebindEnvelope,
	rowOfParts,
} from "../src/core/keys/envelope-binding.js";
import { KeyError } from "../src/core/keys/errors.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import type { EncryptionKeyPurpose } from "../src/core/keys/purpose.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { testKeyRing } from "./totp-fixtures.js";

//the envelope's additional data names its column, its owner and its row (S-INTEG-1)

const ring = testKeyRing(2);
const keys = ring.providerAt(1, [1]);
const PLAINTEXT = new TextEncoder().encode("a value worth binding");

const COLUMNS: readonly BoundColumn[] = [
	"password_credential.phc",
	"totp_credential.secret_enc",
	"identity.access_token_enc",
	"identity.refresh_token_enc",
	"identity.id_token_enc",
	"oauth_flow.pkce_verifier_enc",
];

function bindingFor(column: BoundColumn): EnvelopeBinding {
	const owner = randomUUID();
	return { column, owner, row: column.startsWith("identity.") ? randomUUID() : owner };
}

async function errorCodeOf(attempt: Promise<unknown>): Promise<string> {
	const failure = await attempt.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	return failure instanceof KeyError ? failure.code : String(failure);
}

function hex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

describe("the additional data is a canonical and unambiguous encoding (S-INTEG-1)", () => {
	it("gives a thousand random pairs of distinct bindings distinct bytes", () => {
		const seen = new Map<string, string>();
		let collisions = 0;
		for (let index = 0; index < 1000; index += 1) {
			const column = COLUMNS[index % COLUMNS.length] as BoundColumn;
			const binding: EnvelopeBinding =
				index % 3 === 0
					? { column, owner: null, row: new Uint8Array(Buffer.from(randomUUID())) }
					: bindingFor(column);
			const key = JSON.stringify([
				binding.column,
				binding.owner,
				typeof binding.row === "string" ? binding.row : hex(binding.row),
			]);
			const encoded = hex(boundAdditionalData(binding, 1 + (index % 2)));
			const previous = seen.get(encoded);
			if (previous !== undefined && previous !== key) {
				collisions += 1;
			}
			seen.set(encoded, key);
		}

		expect(collisions).toBe(0);
		expect(seen.size).toBe(1000);
	});

	it("tells an absent owner from every present one, and a uuid row from its bytes", () => {
		const uuid = randomUUID();
		const asUuid = boundAdditionalData(
			{ column: "oauth_flow.pkce_verifier_enc", owner: null, row: uuid },
			1,
		);
		const asBytes = boundAdditionalData(
			{
				column: "oauth_flow.pkce_verifier_enc",
				owner: null,
				row: Uint8Array.from(Buffer.from(uuid.replaceAll("-", ""), "hex")),
			},
			1,
		);
		const owned = boundAdditionalData(
			{ column: "oauth_flow.pkce_verifier_enc", owner: uuid, row: uuid },
			1,
		);

		expect(hex(asUuid)).not.toBe(hex(asBytes));
		expect(hex(asUuid)).not.toBe(hex(owned));
	});

	it("does not let bytes move between the owner and the row", () => {
		const first = randomUUID();
		const second = randomUUID();

		expect(
			hex(boundAdditionalData({ column: "identity.id_token_enc", owner: first, row: second }, 1)),
		).not.toBe(
			hex(boundAdditionalData({ column: "identity.id_token_enc", owner: second, row: first }, 1)),
		);
	});

	it("reads a uuid in either case as the same owner", () => {
		const owner = randomUUID();
		const lower = boundAdditionalData({ column: "password_credential.phc", owner, row: owner }, 1);
		const upper = boundAdditionalData(
			{ column: "password_credential.phc", owner: owner.toUpperCase(), row: owner.toUpperCase() },
			1,
		);

		expect(hex(lower)).toBe(hex(upper));
	});

	it("refuses an owner or a row that is not a uuid with a code of its own", async () => {
		expect(
			await errorCodeOf(
				encryptBound(
					keys,
					{ column: "password_credential.phc", owner: "not-a-uuid", row: randomUUID() },
					PLAINTEXT,
				),
			),
		).toBe("envelope_binding_malformed");
		expect(
			await errorCodeOf(
				encryptBound(
					keys,
					{ column: "totp_credential.secret_enc", owner: randomUUID(), row: "" },
					PLAINTEXT,
				),
			),
		).toBe("envelope_binding_malformed");
	});
});

describe("a bound ciphertext opens only under its own binding (S-INTEG-1)", () => {
	it.each(COLUMNS)("round-trips in the column %s", async (column) => {
		const binding = bindingFor(column);
		const sealed = await encryptBound(keys, binding, PLAINTEXT);

		expect(await decryptBound(keys, binding, sealed, "refused")).toStrictEqual(PLAINTEXT);
	});

	it.each(COLUMNS)("fails under another owner, row or column of %s", async (column) => {
		const binding = bindingFor(column);
		const sealed = await encryptBound(keys, binding, PLAINTEXT);
		const sameKeyColumn: BoundColumn = column.startsWith("identity.")
			? column === "identity.access_token_enc"
				? "identity.refresh_token_enc"
				: "identity.access_token_enc"
			: column;
		const variants: EnvelopeBinding[] = [
			{ ...binding, owner: randomUUID() },
			{ ...binding, owner: null },
			{ ...binding, row: randomUUID() },
			...(sameKeyColumn === column ? [] : [{ ...binding, column: sameKeyColumn }]),
		];

		for (const variant of variants) {
			expect(await errorCodeOf(decryptBound(keys, variant, sealed, "readable"))).toBe(
				"authentication_failed",
			);
		}
	});

	it("fails when the stored key version is rewritten to another version in the ring", async () => {
		const rotated = ring.providerAt(2, [1, 2]);
		const binding = bindingFor("password_credential.phc");
		const sealed = await encryptBound(keys, binding, PLAINTEXT);

		expect(
			await errorCodeOf(decryptBound(rotated, binding, { ...sealed, keyVersion: 2 }, "refused")),
		).toBe("authentication_failed");
		expect(await decryptBound(rotated, binding, sealed, "refused")).toStrictEqual(PLAINTEXT);
	});

	//a ring that hands out one key under two versions makes the version in the additional data the only defence
	it("fails when the key version is rewritten even where both versions share a key", async () => {
		const sharedKey = await keys.current("totp-enc");
		const oneKeyTwoVersions: KeyProvider = {
			current: () => Promise.resolve(sharedKey),
			byVersion: (_purpose, version) =>
				Promise.resolve(version === 1 || version === 2 ? sharedKey.key : null),
		};
		const binding = bindingFor("totp_credential.secret_enc");
		const sealed = await encryptBound(oneKeyTwoVersions, binding, PLAINTEXT);

		expect(await decryptBound(oneKeyTwoVersions, binding, sealed, "refused")).toStrictEqual(
			PLAINTEXT,
		);
		expect(
			await errorCodeOf(
				decryptBound(oneKeyTwoVersions, binding, { ...sealed, keyVersion: 2 }, "refused"),
			),
		).toBe("authentication_failed");
	});

	it("names a key version that left the ring as such", async () => {
		const binding = bindingFor("totp_credential.secret_enc");
		const sealed = await encryptBound(keys, binding, PLAINTEXT);

		expect(
			await errorCodeOf(decryptBound(ring.providerAt(2, [2]), binding, sealed, "readable")),
		).toBe("key_version_unknown");
	});
});

//an unbound value whose random nonce opens with the marker byte is the case the first byte cannot decide
async function unboundStartingWith(
	firstByte: number,
	plaintext: Uint8Array = PLAINTEXT,
): Promise<PurposeCiphertext> {
	for (let attempt = 0; attempt < 10_000; attempt += 1) {
		const unbound = await encryptWithPurposeKey(keys, "password-enc", plaintext);
		if (unbound.ciphertext[0] === firstByte) {
			return unbound;
		}
	}
	throw new Error("no nonce opened with the requested byte in ten thousand draws");
}

describe("the unbound form of 1.x (S-INTEG-1)", () => {
	const binding = bindingFor("password_credential.phc");

	it("starts every bound value with the marker byte", async () => {
		for (let index = 0; index < 50; index += 1) {
			expect((await encryptBound(keys, binding, PLAINTEXT)).ciphertext[0]).toBe(0x02);
		}
	});

	it("is read where the policy reads it and refused with its own code where it does not", async () => {
		const unbound = await unboundStartingWith(0x00);

		expect(await decryptBound(keys, binding, unbound, "readable")).toStrictEqual(PLAINTEXT);
		expect(await errorCodeOf(decryptBound(keys, binding, unbound, "refused"))).toBe(
			"envelope_unbound",
		);
	});

	it("still reads an unbound value whose nonce opens with the marker, and only where the form is read", async () => {
		const unbound = await unboundStartingWith(0x02);

		expect(await decryptBound(keys, binding, unbound, "readable")).toStrictEqual(PLAINTEXT);
		expect(await errorCodeOf(decryptBound(keys, binding, unbound, "refused"))).toBe(
			"authentication_failed",
		);
	});

	it("still reads an unbound empty value whose nonce opens with the marker, too short to be a bound one", async () => {
		const unbound = await unboundStartingWith(0x02, new Uint8Array(0));

		expect(await decryptBound(keys, binding, unbound, "readable")).toHaveLength(0);
		expect(await errorCodeOf(decryptBound(keys, binding, unbound, "refused"))).toBe(
			"ciphertext_malformed",
		);
	});

	it("never reads a bound value of another binding as unbound", async () => {
		const other = await encryptBound(keys, bindingFor("password_credential.phc"), PLAINTEXT);

		expect(await errorCodeOf(decryptBound(keys, binding, other, "readable"))).toBe(
			"authentication_failed",
		);
	});
});

describe("rebindEnvelope, the rewrite the maintenance step calls (S-INTEG-1, E-3115)", () => {
	const binding = bindingFor("totp_credential.secret_enc");

	it("rewrites an unbound value into the bound form of the same plaintext", async () => {
		const unbound = await encryptWithPurposeKey(keys, "totp-enc", PLAINTEXT);
		const rebound = await rebindEnvelope(keys, binding, unbound, "readable");

		expect(rebound).not.toBeNull();
		expect(rebound?.ciphertext[0]).toBe(0x02);
		expect(
			await decryptBound(keys, binding, rebound as PurposeCiphertext, "refused"),
		).toStrictEqual(PLAINTEXT);
	});

	it("leaves a bound value under the current key alone", async () => {
		const bound = await encryptBound(keys, binding, PLAINTEXT);

		expect(await rebindEnvelope(keys, binding, bound, "readable")).toBeNull();
	});

	it("rewrites a bound value under an older key version to the current one", async () => {
		const bound = await encryptBound(keys, binding, PLAINTEXT);
		const rotated = ring.providerAt(2, [1, 2]);
		const rebound = await rebindEnvelope(rotated, binding, bound, "refused");

		expect(rebound?.keyVersion).toBe(2);
		expect(
			await decryptBound(rotated, binding, rebound as PurposeCiphertext, "refused"),
		).toStrictEqual(PLAINTEXT);
	});

	it("refuses to rebind a value bound to someone else, and an unbound one where that form is refused", async () => {
		const foreign = await encryptBound(keys, bindingFor("totp_credential.secret_enc"), PLAINTEXT);
		const unbound = await encryptWithPurposeKey(keys, "totp-enc", PLAINTEXT);

		expect(await errorCodeOf(rebindEnvelope(keys, binding, foreign, "readable"))).toBe(
			"authentication_failed",
		);
		expect(await errorCodeOf(rebindEnvelope(keys, binding, unbound, "refused"))).toMatch(
			/^(envelope_unbound|authentication_failed)$/,
		);
	});
});

describe("securityState.sealing decides whether the unbound form is read (S-INTEG-1)", () => {
	it("reads it under migrating for an account without a seal row and refuses it otherwise", () => {
		const readings = (["required", "migrating"] as const).flatMap((sealing) =>
			(["present", "absent"] as const).map(
				(sealRow) => `${sealing}/${sealRow}: ${unboundReadingOf(sealing, sealRow)}`,
			),
		);

		expect(readings).toStrictEqual([
			"required/present: refused",
			"required/absent: refused",
			"migrating/present: refused",
			"migrating/absent: readable",
		]);
	});

	it("reads a seal row as present only from an explicit true", () => {
		expect([true, false, null, undefined, "t", 1].map(sealRowPresenceOf)).toStrictEqual([
			"present",
			"absent",
			"absent",
			"absent",
			"absent",
			"absent",
		]);
	});

	it.each([
		["a misspelled mode", { sealing: "migrate" }],
		["no mode at all", {}],
		["a mode that is not a string", { sealing: true }],
		["a value that is not an object", "migrating"],
	])("refuses to start with %s", (_label, securityState) => {
		const start = () =>
			createVelveAuth(
				configFor({
					database: {} as TestConnection,
					securityState: securityState as never,
				}),
			);

		expect(start).toThrow(VelveStartupError);
		expect(() => start()).toThrow(/securityState\.sealing must be/);
	});

	it.each(["required", "migrating"] as const)("starts under %s", (sealing) => {
		expect(() =>
			createVelveAuth(
				configFor({ database: {} as TestConnection, securityState: { sealing }, log: () => {} }),
			),
		).not.toThrow();
	});
});

//the old form is reached only through the binding module, which applies the sealing policy (E-3129)
const UNBOUND_WRITERS = /\b(?:encryptWithPurposeKey|sealEnvelope|openEnvelope)\b/;
const UNBOUND_PRIMITIVES =
	/\b(?:decryptWithPurposeKey|encryptUnderAdditionalData|decryptUnderAdditionalData)\b/;
const ENVELOPE_MODULE = "core/keys/envelope.ts";
const BINDING_MODULE = "core/keys/envelope-binding.ts";

interface Source {
	readonly path: string;
	readonly text: string;
}

function modulesReachingTheUnboundForm(sources: readonly Source[]): string[] {
	return sources
		.filter(
			(source) =>
				source.path !== ENVELOPE_MODULE &&
				(UNBOUND_WRITERS.test(source.text) ||
					(source.path !== BINDING_MODULE && UNBOUND_PRIMITIVES.test(source.text))),
		)
		.map((source) => source.path);
}

describe("no module reaches the unbound form but the binding module (S-INTEG-1, E-3124)", () => {
	const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
	const sources: Source[] = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => `${entry.parentPath}/${entry.name}`)
		.map((path) => ({
			path: path.replace(`${sourceRoot}/`, ""),
			text: readFileSync(path, "utf8"),
		}));

	it("finds no module of src/ that names an unbound writer or primitive outside its place", () => {
		expect(sources.length).toBeGreaterThan(100);
		expect(sources.some((source) => source.path === BINDING_MODULE)).toBe(true);
		expect(modulesReachingTheUnboundForm(sources)).toStrictEqual([]);
	});

	it.each([
		[
			"reads the old form with no policy",
			`import { decryptWithPurposeKey } from "../keys/envelope.js";
export const open = (keys, version, value) => decryptWithPurposeKey(keys, "totp-enc", version, value);`,
		],
		[
			"writes a value bound to nothing",
			`import { encryptUnderAdditionalData } from "../keys/envelope.js";
export const seal = (keys, value) => encryptUnderAdditionalData(keys, "totp-enc", () => new Uint8Array(0), value);`,
		],
		[
			"decrypts with additional data of its own",
			`import { decryptUnderAdditionalData } from "../keys/envelope.js";
export const open = (keys, stored) => decryptUnderAdditionalData(keys, "totp-enc", stored, new Uint8Array(0));`,
		],
		[
			"writes the old form",
			`import { encryptWithPurposeKey } from "../keys/envelope.js";
export const seal = (keys, value) => encryptWithPurposeKey(keys, "totp-enc", value);`,
		],
	])("catches a planted module that %s", (_name, text) => {
		expect(
			modulesReachingTheUnboundForm([...sources, { path: "core/planted.ts", text }]),
		).toStrictEqual(["core/planted.ts"]);
	});

	it("catches the binding module itself naming an unbound writer", () => {
		const planted = sources.map((source) =>
			source.path === BINDING_MODULE
				? { ...source, text: `${source.text}\nexport { sealEnvelope } from "./envelope.js";` }
				: source,
		);

		expect(modulesReachingTheUnboundForm(planted)).toStrictEqual([BINDING_MODULE]);
	});
});

describe("the account rewrite runs only inside an open transaction (E-3129)", () => {
	it("does not take a pool where it needs a transaction", () => {
		expectTypeOf<Driver>().not.toMatchTypeOf<OpenTransaction>();
		expectTypeOf<OpenTransaction>().toMatchTypeOf<Driver>();
	});
});

describe("the account rewrite's transaction states its isolation (E-3310)", () => {
	it("sends SET TRANSACTION ISOLATION LEVEL READ COMMITTED first, even over a driver nobody wrapped", async () => {
		const statements: string[] = [];
		const bare: Driver = {
			async query<T>(sql: string): Promise<T[]> {
				statements.push(sql);
				return [];
			},
			transaction: (work) => work(bare),
		};

		await inOneTransaction(bare, async (transaction) => {
			await transaction.query("SELECT 1", []);
		});

		expect(statements).toStrictEqual([
			"SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
			"SELECT 1",
		]);
	});
});

describe("a uuid in a binding is the whole value and not a part of it (S-INTEG-1, E-3110)", () => {
	it.each([
		["a prefix", (uuid: string) => `x${uuid}`],
		["a suffix", (uuid: string) => `${uuid}x`],
		["a line feed", (uuid: string) => `${uuid}\n`],
	])("refuses an owner with %s around a uuid", (_name, wrap) => {
		const owner = randomUUID();
		expect(() =>
			boundAdditionalData({ column: "password_credential.phc", owner: wrap(owner), row: owner }, 1),
		).toThrow(KeyError);
	});
});

const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);

describe("the row of several columns is a canonical encoding (S-INTEG-1, E-3123)", () => {
	it("gives two parts and one part holding the first part's framing different bytes", () => {
		const separated = rowOfParts(["a", "b"]);
		const forged = rowOfParts([`a${SOH}${NUL}${NUL}${NUL}${NUL}b`]);
		const framed = rowOfParts([`a${SOH}${NUL}${NUL}${NUL}${String.fromCharCode(1)}b`]);

		expect(hex(separated)).not.toBe(hex(forged));
		expect(hex(separated)).not.toBe(hex(framed));
	});

	it("pins the layout the log freezes: type byte, four length bytes, then the bytes", () => {
		expect(hex(rowOfParts(["ab"]))).toBe("010000000261" + "62");
		expect(hex(rowOfParts([new Uint8Array([1, 2, 3])]))).toBe("03000000030102" + "03");
		expect(hex(rowOfParts([null]))).toBe("0000000000");
	});

	it("tells an absent part from an empty text", () => {
		expect(hex(rowOfParts([null]))).not.toBe(hex(rowOfParts([""])));
	});

	it("tells a text from the same bytes", () => {
		expect(hex(rowOfParts(["a"]))).not.toBe(hex(rowOfParts([new Uint8Array([97])])));
	});

	it("does not drop an absent part", () => {
		expect(hex(rowOfParts(["a", null, "b"]))).not.toBe(hex(rowOfParts(["a", "b"])));
		expect(hex(rowOfParts([null, "a"]))).not.toBe(hex(rowOfParts(["a"])));
	});
});

describe("the additional data has the frozen layout of E-3110 (S-INTEG-1)", () => {
	it("starts with the context and the algorithm and carries the key version as four bytes", () => {
		const owner = "11111111-2222-3333-4444-555555555555";
		const written = hex(
			boundAdditionalData({ column: "password_credential.phc", owner, row: owner }, 7),
		);
		const text = (value: string): string =>
			`01${value.length.toString(16).padStart(8, "0")}${Buffer.from(value).toString("hex")}`;
		const uuid = "11111111222233334444555555555555";

		expect(written).toBe(
			text("velve-auth/envelope/v2") +
				text("A256GCM") +
				"0400000004" +
				"00000007" +
				text("password_credential.phc") +
				`0200000010${uuid}` +
				`0200000010${uuid}`,
		);
	});

	it("tells an absent owner from the all-zero uuid", () => {
		const row = randomUUID();
		const absent = boundAdditionalData(
			{ column: "oauth_flow.pkce_verifier_enc", owner: null, row },
			1,
		);
		const zero = boundAdditionalData(
			{
				column: "oauth_flow.pkce_verifier_enc",
				owner: "00000000-0000-0000-0000-000000000000",
				row,
			},
			1,
		);

		expect(hex(absent)).not.toBe(hex(zero));
	});
});

describe("each column is encrypted under the key of its own purpose (S-INTEG-1, E-3110)", () => {
	const keys = testKeyRing(1).providerAt(1);
	const PURPOSES: readonly [BoundColumn, EncryptionKeyPurpose][] = [
		["password_credential.phc", "password-enc"],
		["totp_credential.secret_enc", "totp-enc"],
		["identity.access_token_enc", "oauth-token-enc"],
		["identity.refresh_token_enc", "oauth-token-enc"],
		["identity.id_token_enc", "oauth-token-enc"],
		["oauth_flow.pkce_verifier_enc", "pkce-enc"],
	];
	const ALL: readonly EncryptionKeyPurpose[] = [
		"password-enc",
		"totp-enc",
		"oauth-token-enc",
		"pkce-enc",
	];

	it.each(PURPOSES)("opens %s under %s alone", async (column, purpose) => {
		const owner = randomUUID();
		const binding: EnvelopeBinding = {
			column,
			owner,
			row: column.startsWith("identity.") ? randomUUID() : owner,
		};
		const sealed = await encryptBound(keys, binding, new TextEncoder().encode("secret"));
		const additionalData = boundAdditionalData(binding, sealed.keyVersion);
		const stored = { keyVersion: sealed.keyVersion, ciphertext: sealed.ciphertext.subarray(1) };

		for (const other of ALL) {
			const attempt = decryptUnderAdditionalData(keys, other, stored, additionalData);
			if (other === purpose) {
				await expect(attempt).resolves.toBeDefined();
			} else {
				await expect(attempt).rejects.toBeInstanceOf(KeyError);
			}
		}
	});
});
