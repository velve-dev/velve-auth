import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { bookAttemptOn } from "../src/core/factor/pending/booking.js";
import { createPendingAuthenticationService } from "../src/core/factor/pending/index.js";
import type { TokenBindingRefusal } from "../src/core/token/binding.js";
import { rebindTokenRowsUnderCurrentKey } from "../src/core/token/rebind.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { testKeyRing } from "./totp-fixtures.js";

//five concurrent bookings and one maintenance rebinding are six legitimate advances and raise no alarm (E-3140)

let migrated: MigratedSchema;
let schema: string;
let other: TestConnection;

beforeAll(async () => {
	migrated = await openMigratedSchema("security_state_booking_advances");
	schema = migrated.schema;
	other = await openTestConnection();
});

afterAll(async () => {
	await other.close();
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

function interferingBeforeEachBooking(inner: Driver, interfere: () => Promise<void>): Driver {
	return {
		query: async <T>(sql: string, params: unknown[]) => {
			if (/^\s*UPDATE\b[\s\S]*SET attempts = \$3/.test(sql)) {
				await interfere();
			}
			return inner.query<T>(sql, params);
		},
		transaction: (work) =>
			inner.transaction((tx) => work(interferingBeforeEachBooking(tx, interfere))),
	};
}

describe("a booking that loses to five bookings and one maintenance rebinding", () => {
	it("answers exhausted without an alarm", async () => {
		const ring = testKeyRing(2);
		const old = ring.providerAt(1, [1, 2]);
		const current = ring.providerAt(2, [1, 2]);
		const userId = await createUser(migrated.connection, schema);
		const issuer = createPendingAuthenticationService({
			driver: migrated.connection,
			keys: old,
			schema,
		});
		const { token } = await issuer.begin({ userId, factorsCompleted: ["password"] });
		const rival = createPendingAuthenticationService({ driver: other, keys: current, schema });
		const refusals: TokenBindingRefusal[] = [];
		let interference = 0;
		const booker = createPendingAuthenticationService({
			driver: interferingBeforeEachBooking(migrated.connection, async () => {
				interference += 1;
				if (interference === 1) {
					await rebindTokenRowsUnderCurrentKey({
						driver: other,
						schema,
						keys: current,
						sealing: "migrating",
						table: "pending_authentication",
						batchSize: 10,
					});
				} else if (interference <= 6) {
					await bookAttemptOn(rival, token);
				}
			}),
			keys: current,
			schema,
			reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
		});

		const booked = await bookAttemptOn(booker, token);

		expect({ outcome: booked.outcome, refusals }).toStrictEqual({
			outcome: "exhausted",
			refusals: [],
		});
	});
});
