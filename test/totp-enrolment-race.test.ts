import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTotpService, timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { createTestClock } from "../src/testing/index.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { HeldDriver } from "./lock-order-fixtures.js";
import { testSecurityState } from "./security-state-fixtures.js";
import { pendingAuthenticationsOn, secretBytesOfBase32, testKeyProvider } from "./totp-fixtures.js";

const FIXED_INSTANT = new Date("2026-10-04T09:15:00.000Z");
const THE_CONFIRMATION = /SET confirmed_at = now\(\)/;

let finisherConnection: TestConnection;
let starterConnection: TestConnection;
let schema: string;
let keys: KeyProvider;

beforeAll(async () => {
	const migrated = await openMigratedSchema("totp_enrol_race");
	finisherConnection = migrated.connection;
	schema = migrated.schema;
	starterConnection = await openTestConnection();
	keys = testKeyProvider();
});

afterAll(async () => {
	await dropSchema(finisherConnection, schema);
	await Promise.all([finisherConnection.close(), starterConnection.close()]);
});

function totpOn(driver: HeldDriver | TestConnection) {
	return createTotpService({
		securityState: testSecurityState(driver, schema, keys),
		driver,
		schema,
		keys,
		pending: pendingAuthenticationsOn(driver, schema),
		issuer: "Velve",
		clock: createTestClock(FIXED_INSTANT),
	});
}

interface StoredRow {
	secret_enc: Uint8Array;
	confirmed_at: Date | null;
}

async function storedCredentialOf(userId: string): Promise<StoredRow | undefined> {
	const [row] = await finisherConnection.query<StoredRow>(
		`SELECT secret_enc, confirmed_at FROM ${schema}.totp_credential WHERE user_id = $1`,
		[userId],
	);
	return row;
}

//an enrolment's finish holds the account lock from its check to its confirmation and a racing start or finish waits for it (E-3385)
describe("a start or a finish arriving while a finish holds the account", () => {
	async function stillWaiting(work: Promise<unknown>): Promise<boolean> {
		const settled = await Promise.race([
			work.then(
				() => "settled",
				() => "settled",
			),
			new Promise((resolve) => setTimeout(() => resolve("waiting"), 300)),
		]);
		return settled === "waiting";
	}

	it("lets the start wait for the confirmation and then refuses it as already enrolled", async () => {
		const userId = await createUser(finisherConnection, schema);
		const actor = actorOfTestUser(userId);
		const held = new HeldDriver(finisherConnection);
		const finisher = totpOn(held);
		const starter = totpOn(starterConnection);

		const proved = await finisher.enroll.start({ actor, accountName: "ada@example.com" });
		const provedCode = totpCodeForStep(
			secretBytesOfBase32(proved.secretBase32),
			timeStepAt(FIXED_INSTANT),
		);
		const storedBeforeTheFinish = await storedCredentialOf(userId);

		const reachedTheConfirmation = held.holdBefore(THE_CONFIRMATION);
		const outcome = finisher.enroll.finish({ actor, code: provedCode }).then(
			() => "confirmed",
			(failure: unknown) => failure,
		);
		await reachedTheConfirmation;
		const replacement = starter.enroll.start({ actor, accountName: "ada@example.com" }).then(
			() => "started",
			(failure: unknown) => failure,
		);
		expect(await stillWaiting(replacement)).toBe(true);
		held.release();

		expect(await outcome).toBe("confirmed");
		expect(await replacement).toMatchObject({ code: "factor_already_enrolled" });
		const stored = await storedCredentialOf(userId);
		expect(stored?.confirmed_at).not.toBeNull();
		expect(Buffer.from(stored?.secret_enc ?? [])).toEqual(
			Buffer.from(storedBeforeTheFinish?.secret_enc ?? [1]),
		);
	});

	it("answers the second finish factor_already_enrolled once the first confirmed the same secret", async () => {
		const userId = await createUser(finisherConnection, schema);
		const actor = actorOfTestUser(userId);
		const held = new HeldDriver(finisherConnection);
		const finisher = totpOn(held);
		const other = totpOn(starterConnection);

		const enrollment = await finisher.enroll.start({ actor, accountName: "ada@example.com" });
		const secretBytes = secretBytesOfBase32(enrollment.secretBase32);
		const step = timeStepAt(FIXED_INSTANT);

		const reachedTheConfirmation = held.holdBefore(THE_CONFIRMATION);
		const outcome = finisher.enroll
			.finish({ actor, code: totpCodeForStep(secretBytes, step) })
			.then(
				() => "confirmed",
				(failure: unknown) => failure,
			);
		await reachedTheConfirmation;
		const second = other.enroll
			.finish({ actor, code: totpCodeForStep(secretBytes, step - 1) })
			.then(
				() => "confirmed",
				(failure: unknown) => failure,
			);
		expect(await stillWaiting(second)).toBe(true);
		held.release();

		expect(await outcome).toBe("confirmed");
		expect(await second).toMatchObject({ code: "factor_already_enrolled" });
	});
});
