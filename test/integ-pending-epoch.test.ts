import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookAttemptOn } from "../src/core/factor/pending/booking.js";
import { createPendingAuthenticationService } from "../src/core/factor/pending/index.js";
import type { TokenBindingRefusal } from "../src/core/token/binding.js";
import { testKeyProvider } from "./auth-fixtures.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { aFreshEpochOtherThan } from "./session-fixtures.js";

//a pending authentication a mass revocation has overtaken is answered as missing, without an alarm and before its booking (E-3484)

const keys = testKeyProvider();
let migrated: MigratedSchema;
let schema: string;
let refusals: TokenBindingRefusal[];

beforeAll(async () => {
	migrated = await openMigratedSchema("integ_pending_epoch");
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

function pendingService() {
	refusals = [];
	return createPendingAuthenticationService({
		driver: migrated.connection,
		keys,
		schema,
		reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
	});
}

async function sealedAccount(): Promise<{ userId: string; epoch: number }> {
	const userId = await createUser(migrated.connection, schema);
	const epoch = aFreshEpochOtherThan(1);
	await migrated.connection.query(
		`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version, session_epoch)
		 VALUES ($1, 1, $2, 1, $3)`,
		[userId, randomBytes(32), epoch],
	);
	return { userId, epoch };
}

async function revokedAfterwards(userId: string, epoch: number): Promise<void> {
	await migrated.connection.query(
		`UPDATE ${schema}.security_state SET session_epoch = $2 WHERE user_id = $1`,
		[userId, aFreshEpochOtherThan(epoch)],
	);
}

describe("a pending authentication and the epoch it was created under", () => {
	it("stores the account's epoch and resolves while it holds", async () => {
		const { userId, epoch } = await sealedAccount();
		const pending = pendingService();
		const { token } = await pending.begin({ userId, factorsCompleted: ["password"] });
		const [row] = await migrated.connection.query<{ session_epoch: string }>(
			`SELECT session_epoch::text FROM ${schema}.pending_authentication WHERE user_id = $1`,
			[userId],
		);

		expect(row?.session_epoch).toBe(String(epoch));
		expect((await pending.resolve(token))?.userId).toBe(userId);
	});

	it("stores epoch 1 for an account without a seal row", async () => {
		const userId = await createUser(migrated.connection, schema);
		const { token } = await pendingService().begin({ userId, factorsCompleted: ["password"] });
		const [row] = await migrated.connection.query<{ session_epoch: string }>(
			`SELECT session_epoch::text FROM ${schema}.pending_authentication WHERE user_id = $1`,
			[userId],
		);

		expect(row?.session_epoch).toBe("1");
		expect(await pendingService().resolve(token)).not.toBeNull();
	});

	it("is missing after a mass revocation drew a new epoch, on resolve, booking and consumption, with no alarm", async () => {
		const { userId, epoch } = await sealedAccount();
		const pending = pendingService();
		const { token } = await pending.begin({ userId, factorsCompleted: ["password"] });
		await revokedAfterwards(userId, epoch);

		const resolved = await pending.resolve(token);
		const booked = await bookAttemptOn(pending, token);
		const consumed = await pending.consume(token).then(
			() => "consumed",
			(failure: { reason?: string }) => failure.reason,
		);
		const [row] = await migrated.connection.query<{ attempts: number }>(
			`SELECT attempts FROM ${schema}.pending_authentication WHERE user_id = $1`,
			[userId],
		);

		expect({
			resolved,
			booked: booked.outcome,
			consumed,
			attempts: row?.attempts,
			refusals,
		}).toStrictEqual({
			resolved: null,
			booked: "missing",
			consumed: "pending_consumed",
			attempts: undefined,
			refusals: [],
		});
	});

	it("refuses a row whose stored epoch a writer moved to the current one, with one report", async () => {
		const { userId, epoch } = await sealedAccount();
		const pending = pendingService();
		const { token } = await pending.begin({ userId, factorsCompleted: ["password"] });
		await revokedAfterwards(userId, epoch);
		await migrated.connection.query(
			`UPDATE ${schema}.pending_authentication p SET session_epoch = s.session_epoch
			 FROM ${schema}.security_state s WHERE p.user_id = $1 AND s.user_id = $1`,
			[userId],
		);

		expect(await pending.resolve(token)).toBeNull();
		expect(refusals).toStrictEqual([
			{ userId, occasion: "factor_check", reason: "token_binding_mismatch", verdict: "mismatch" },
		]);
	});

	it("binds the epoch the first factor's check read where the caller names it", async () => {
		const { userId, epoch } = await sealedAccount();
		const { token } = await pendingService().begin({
			userId,
			factorsCompleted: ["password"],
			sessionEpoch: aFreshEpochOtherThan(epoch),
		});

		expect(await pendingService().resolve(token)).toBeNull();
		expect(refusals).toStrictEqual([]);
	});
});
