import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionRepository } from "../src/core/db/repositories/session.js";
import { bookAttemptOn } from "../src/core/factor/pending/booking.js";
import {
	createPendingAuthenticationService,
	createSecondFactorCompletion,
	MAXIMUM_PENDING_ATTEMPTS,
	verifyUnderPendingAttemptLimit,
} from "../src/core/factor/pending/index.js";
import { ConcealedError, VelveError } from "../src/core/http/error-map.js";
import { sessionTokenHash } from "../src/core/session/token.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { sessionInsertFor } from "./session-fixtures.js";
import { testKeyRing } from "./totp-fixtures.js";

// The sealing mode reaches every path that issues a session, and a repository built without a
// mode is the one that refuses an account without a seal row (E-3142). A booking
// that finds the budget spent answers too_many_factor_attempts and evaluates nothing.

const NO_REQUEST = { ipAddress: null, userAgent: null };

let migrated: MigratedSchema;
let schema: string;
const keys = testKeyRing(1).providerAt(1);

beforeAll(async () => {
	migrated = await openMigratedSchema("review_sealing_paths");
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

describe("a session repository built without a sealing mode", () => {
	it("refuses to insert a session for an account without a seal row", async () => {
		const repository = createSessionRepository({ driver: migrated.connection, schema, keys });
		const userId = await createUser(migrated.connection, schema);

		await expect(
			repository.insertSession(sessionInsertFor(userId, { tokenHash: sessionTokenHash("t") })),
		).rejects.toThrow(ConcealedError);
	});
});

describe('completing a second factor under "required"', () => {
	it("issues no session for an account without a seal row and leaves the pending state standing", async () => {
		const pending = createPendingAuthenticationService({
			driver: migrated.connection,
			keys,
			schema,
		});
		const completion = createSecondFactorCompletion({
			driver: migrated.connection,
			keys,
			sealing: "required",
			schema,
		});
		const userId = await createUser(migrated.connection, schema);
		const { token } = await pending.begin({ userId, factorsCompleted: ["password"] });

		await expect(
			completion.complete({
				pendingToken: token,
				factor: "totp",
				presentedSessionToken: null,
				observed: NO_REQUEST,
			}),
		).rejects.toThrow(ConcealedError);

		const [row] = await migrated.connection.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM ${schema}.session WHERE user_id = $1`,
			[userId],
		);
		expect(row?.n).toBe(0);
		expect((await pending.resolve(token))?.userId).toBe(userId);
	});
});

describe("a check that finds the attempt budget spent", () => {
	it("answers too_many_factor_attempts and does not evaluate the factor", async () => {
		const pending = createPendingAuthenticationService({
			driver: migrated.connection,
			keys,
			schema,
		});
		const userId = await createUser(migrated.connection, schema);
		const { token } = await pending.begin({ userId, factorsCompleted: ["password"] });
		for (let booked = 0; booked < MAXIMUM_PENDING_ATTEMPTS; booked += 1) {
			expect((await bookAttemptOn(pending, token)).outcome).toBe("booked");
		}
		let evaluated = 0;

		const failure = await verifyUnderPendingAttemptLimit(pending, token, async () => {
			evaluated += 1;
		}).catch((caught: unknown) => caught);

		expect(failure).toBeInstanceOf(VelveError);
		expect(failure).toMatchObject({ code: "too_many_factor_attempts" });
		expect(evaluated).toBe(0);
	});
});
