import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sealRowPresenceOf, unboundReadingOf } from "../src/core/auth/security-state.js";
import { VelveStartupError } from "../src/core/auth/startup.js";
import { encryptWithPurposeKey, type PurposeCiphertext } from "../src/core/keys/envelope.js";
import {
	type BoundColumn,
	boundAdditionalData,
	decryptBound,
	type EnvelopeBinding,
	encryptBound,
	rebindEnvelope,
} from "../src/core/keys/envelope-binding.js";
import { KeyError } from "../src/core/keys/errors.js";
import { createVelveAuth } from "../src/index.js";
import { configFor } from "./auth-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { testKeyRing } from "./totp-fixtures.js";

/**
 * The binding of S-INTEG-1 at the level of the envelope: what the additional data encodes, how the
 * two stored forms are told apart, and what the maintenance step will call to rewrite a value.
 */

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

	it("names a key version that left the ring as such", async () => {
		const binding = bindingFor("totp_credential.secret_enc");
		const sealed = await encryptBound(keys, binding, PLAINTEXT);

		expect(
			await errorCodeOf(decryptBound(ring.providerAt(2, [2]), binding, sealed, "readable")),
		).toBe("key_version_unknown");
	});
});

//an unbound value whose random nonce opens with the marker byte is the case the first byte cannot decide
async function unboundStartingWith(firstByte: number): Promise<PurposeCiphertext> {
	for (let attempt = 0; attempt < 10_000; attempt += 1) {
		const unbound = await encryptWithPurposeKey(keys, "password-enc", PLAINTEXT);
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

describe("no module writes the unbound form (S-INTEG-1, E-3124)", () => {
	const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
	const sources = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => `${entry.parentPath}/${entry.name}`);

	it("names the old-form writers in the envelope module alone", () => {
		const naming = sources
			.filter((path) =>
				/\b(?:encryptWithPurposeKey|sealEnvelope|openEnvelope)\b/.test(readFileSync(path, "utf8")),
			)
			.map((path) => path.replace(`${sourceRoot}/`, ""));

		expect(sources.length).toBeGreaterThan(100);
		expect(naming).toStrictEqual(["core/keys/envelope.ts"]);
	});
});
