import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCodeForStep } from "../src/core/factor/totp/code.js";
import {
	TOTP_ALGORITHM,
	TOTP_DIGITS,
	TOTP_PERIOD_SECONDS,
	TOTP_SECRET_BYTES,
	timeStepAt,
} from "../src/core/factor/totp/parameters.js";
import { createTotpService, type TotpService } from "../src/core/factor/totp/service.js";
import { decryptWithPurposeKey } from "../src/core/keys/envelope.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import {
	countRows,
	secretBytesOfBase32,
	type SettableClock,
	settableClock,
	testKeyProvider,
} from "./totp-fixtures.js";

const FIXED_INSTANT = new Date("2026-05-03T18:45:00.000Z");

let connection: TestConnection;
let schema: string;
let clock: SettableClock;
let keys: KeyProvider;
let totp: TotpService;

interface StoredRow {
	secret_enc: Uint8Array;
	key_version: number;
	confirmed_at: Date | null;
}

async function readStoredCredential(userId: string): Promise<StoredRow | undefined> {
	const [row] = await connection.query<StoredRow>(
		`SELECT secret_enc, key_version, confirmed_at FROM ${schema}.totp_credential WHERE user_id = $1`,
		[userId],
	);
	return row;
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("totp_enrolment");
	connection = migrated.connection;
	schema = migrated.schema;
	clock = settableClock(FIXED_INSTANT);
	keys = testKeyProvider();
	totp = createTotpService({ driver: connection, schema, keys, issuer: "Velve", clock });
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

describe("enrolment writes an unconfirmed row and the code confirms it (3.15 B.6)", () => {
	it("hands out a 160 bit secret and a key URI that spells out every parameter", async () => {
		const actor = actorOfTestUser(await createUser(connection, schema));
		const enrollment = await totp.enroll.start({ actor, accountName: "ada@example.com" });

		expect(secretBytesOfBase32(enrollment.secretBase32)).toHaveLength(TOTP_SECRET_BYTES);

		const uri = new URL(enrollment.otpauthUri);
		expect(uri.protocol).toBe("otpauth:");
		expect(uri.host).toBe("totp");
		expect(uri.pathname).toBe("/Velve:ada%40example.com");
		expect(uri.searchParams.get("secret")).toBe(enrollment.secretBase32);
		expect(uri.searchParams.get("issuer")).toBe("Velve");
		expect(uri.searchParams.get("algorithm")).toBe(TOTP_ALGORITHM);
		expect(uri.searchParams.get("digits")).toBe(String(TOTP_DIGITS));
		expect(uri.searchParams.get("period")).toBe(String(TOTP_PERIOD_SECONDS));
	});

	it("counts as absent while confirmed_at is null (3.15 B.6)", async () => {
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);
		await totp.enroll.start({ actor, accountName: "abandoned@example.com" });

		expect((await readStoredCredential(userId))?.confirmed_at).toBeNull();
		expect(await totp.isEnrolled({ userId })).toBe(false);
	});

	it("lets an abandoned attempt be started again and refuses a confirmed one", async () => {
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);

		const first = await totp.enroll.start({ actor, accountName: "twice@example.com" });
		const second = await totp.enroll.start({ actor, accountName: "twice@example.com" });
		expect(second.secretBase32).not.toBe(first.secretBase32);

		await totp.enroll.finish({
			actor,
			code: totpCodeForStep(secretBytesOfBase32(second.secretBase32), timeStepAt(clock.now())),
		});
		expect(await totp.isEnrolled({ userId })).toBe(true);

		await expect(
			totp.enroll.start({ actor, accountName: "twice@example.com" }),
		).rejects.toMatchObject({ code: "factor_already_enrolled" });
	});

	it("refuses to confirm with a code the secret does not produce", async () => {
		const actor = actorOfTestUser(await createUser(connection, schema));
		await totp.enroll.start({ actor, accountName: "wrong@example.com" });

		await expect(totp.enroll.finish({ actor, code: "000000" })).rejects.toMatchObject({
			reason: "totp_code_wrong",
		});
	});

	it("refuses to confirm an enrolment that was never started", async () => {
		const actor = actorOfTestUser(await createUser(connection, schema));
		await expect(totp.enroll.finish({ actor, code: "000000" })).rejects.toMatchObject({
			code: "factor_not_enrolled",
		});
	});
});

describe("T-REST-4 and T-KEY-3, for the one column wave 3 can reach", () => {
	it("stores the secret as AES-256-GCM under totp-enc with its version in the column (S-REST-4, S-KEY-3)", async () => {
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);
		const enrollment = await totp.enroll.start({ actor, accountName: "atrest@example.com" });

		const stored = await readStoredCredential(userId);
		if (stored === undefined) {
			throw new Error("the enrolment wrote no row");
		}

		const current = await keys.current("totp-enc");
		expect(stored.key_version).toBe(current.version);

		const plaintext = await decryptWithPurposeKey(
			keys,
			"totp-enc",
			stored.key_version,
			Uint8Array.from(stored.secret_enc),
		);
		expect(Buffer.from(plaintext).toString("base64")).toBe(
			Buffer.from(secretBytesOfBase32(enrollment.secretBase32)).toString("base64"),
		);
	});

	it("holds no readable trace of the secret in the row (S-REST-1)", async () => {
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);
		const enrollment = await totp.enroll.start({ actor, accountName: "opaque@example.com" });

		const stored = await readStoredCredential(userId);
		const ciphertext = Buffer.from(stored?.secret_enc ?? new Uint8Array());
		const secretBytes = Buffer.from(secretBytesOfBase32(enrollment.secretBase32));

		expect(ciphertext.includes(secretBytes)).toBe(false);
		expect(ciphertext.toString("latin1")).not.toContain(enrollment.secretBase32);
		expect(ciphertext.toString("base64")).not.toContain(secretBytes.toString("base64"));
	});

	it("refuses to decrypt a secret whose key version has left the ring (S-KEY-4)", async () => {
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);
		await totp.enroll.start({ actor, accountName: "rotated@example.com" });

		const withoutTheVersion = createTotpService({
			driver: connection,
			schema,
			keys: testKeyProvider(2),
			issuer: "Velve",
			clock,
		});
		await expect(
			withoutTheVersion.enroll.finish({ actor, code: "000000" }),
		).rejects.toMatchObject({ code: "authentication_failed" });
	});
});

describe("removal demands the factor it removes (3.15 B.6)", () => {
	it("takes the credential and its replay ledger together", async () => {
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);
		const enrollment = await totp.enroll.start({ actor, accountName: "gone@example.com" });
		const secretBytes = secretBytesOfBase32(enrollment.secretBase32);
		await totp.enroll.finish({ actor, code: totpCodeForStep(secretBytes, timeStepAt(clock.now())) });

		clock.advanceSeconds(TOTP_PERIOD_SECONDS);
		expect(await countRows(connection, schema, "totp_used_step", userId)).toBe(1);

		await totp.remove({ actor, code: totpCodeForStep(secretBytes, timeStepAt(clock.now())) });

		expect(await countRows(connection, schema, "totp_credential", userId)).toBe(0);
		expect(await countRows(connection, schema, "totp_used_step", userId)).toBe(0);
	});

	it("refuses removal without a valid code", async () => {
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);
		const enrollment = await totp.enroll.start({ actor, accountName: "kept@example.com" });
		await totp.enroll.finish({
			actor,
			code: totpCodeForStep(secretBytesOfBase32(enrollment.secretBase32), timeStepAt(clock.now())),
		});

		await expect(totp.remove({ actor, code: "000000" })).rejects.toMatchObject({
			reason: "totp_code_wrong",
		});
		expect(await countRows(connection, schema, "totp_credential", userId)).toBe(1);
	});

	it("refuses removal of a factor that is not enrolled", async () => {
		const actor = actorOfTestUser(await createUser(connection, schema));
		await expect(totp.remove({ actor, code: "000000" })).rejects.toMatchObject({
			code: "factor_not_enrolled",
		});
	});
});
