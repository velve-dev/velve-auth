import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { bookAttemptOn } from "../src/core/factor/pending/booking.js";
import { createPendingAuthenticationService } from "../src/core/factor/pending/index.js";
import type { TokenBindingRefusal } from "../src/core/token/binding.js";
import { testKeyProvider } from "./auth-fixtures.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { testKeyRing } from "./totp-fixtures.js";

//a missed booking over a row that reads back as it was checked is a writer's doing and is refused, not retried (E-3140)

const keys = testKeyProvider();
let migrated: MigratedSchema;
let schema: string;

beforeAll(async () => {
	migrated = await openMigratedSchema("security_state_booking_unchanged_row");
	schema = migrated.schema;
});
afterAll(async () => {
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

function missingTheFirstBooking(inner: Driver): Driver {
	let missed = false;
	return {
		query: async <T>(sql: string, params: unknown[]) => {
			if (!missed && /UPDATE .*pending_authentication/s.test(sql) && /SET attempts/.test(sql)) {
				missed = true;
				return [] as T[];
			}
			return inner.query<T>(sql, params);
		},
		transaction: (work) => inner.transaction(work),
	};
}

describe("a missed booking over a row that reads back unchanged", () => {
	it("is refused with the alarm and books nothing", async () => {
		const refusals: TokenBindingRefusal[] = [];
		const userId = await createUser(migrated.connection, schema);
		const service = createPendingAuthenticationService({
			driver: missingTheFirstBooking(migrated.connection),
			keys,
			schema,
			reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
		});
		const { token } = await service.begin({ userId, factorsCompleted: ["password"] });

		const booked = await bookAttemptOn(service, token);

		expect(booked.outcome).toBe("missing");
		expect(refusals).toHaveLength(1);
		const [row] = await migrated.connection.query<{ attempts: number }>(
			`SELECT attempts FROM ${schema}.pending_authentication WHERE user_id = $1`,
			[userId],
		);
		expect(row?.attempts).toBe(0);
	});

	it("is refused too when the row is under a later key version than the first", async () => {
		const refusals: TokenBindingRefusal[] = [];
		const userId = await createUser(migrated.connection, schema);
		const service = createPendingAuthenticationService({
			driver: missingTheFirstBooking(migrated.connection),
			keys: testKeyRing(2).providerAt(2, [2]),
			schema,
			reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
		});
		const { token } = await service.begin({ userId, factorsCompleted: ["password"] });

		const booked = await bookAttemptOn(service, token);

		expect(booked.outcome).toBe("missing");
		expect(refusals).toHaveLength(1);
	});
});
