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

describe("a start between the code check and the confirmation of an enrolment", () => {
	it("leaves the secret the code never proved unconfirmed and answers like a wrong code", async () => {
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

		const reachedTheConfirmation = held.holdBefore(THE_CONFIRMATION);
		const finishing = finisher.enroll.finish({ actor, code: provedCode });
		const outcome = finishing.then(
			() => "confirmed",
			(failure: unknown) => failure,
		);
		await reachedTheConfirmation;
		const replacement = await starter.enroll.start({ actor, accountName: "ada@example.com" });
		const storedAfterTheStart = await storedCredentialOf(userId);
		held.release();

		expect(await outcome).toMatchObject({ reason: "totp_code_wrong" });
		const stored = await storedCredentialOf(userId);
		expect(stored?.confirmed_at).toBeNull();
		expect(Buffer.from(stored?.secret_enc ?? [])).toEqual(
			Buffer.from(storedAfterTheStart?.secret_enc ?? [1]),
		);

		const replacementCode = totpCodeForStep(
			secretBytesOfBase32(replacement.secretBase32),
			timeStepAt(FIXED_INSTANT) + 1,
		);
		await starter.enroll.finish({ actor, code: replacementCode });
		expect((await storedCredentialOf(userId))?.confirmed_at).not.toBeNull();
	});

	it("still answers factor_already_enrolled when a second finish confirmed the same secret first", async () => {
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
		await other.enroll.finish({ actor, code: totpCodeForStep(secretBytes, step - 1) });
		held.release();

		expect(await outcome).toMatchObject({ code: "factor_already_enrolled" });
	});
});
