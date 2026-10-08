import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { createSessionService } from "../src/core/session/service.js";
import type { TokenBindingRefusal } from "../src/core/token/binding.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { testKeyRing } from "./totp-fixtures.js";

//a resolution that rebinds the kept session under a newer key while revokeEveryOther holds the lock signs nobody out (E-3362)

const NO_REQUEST = { ipAddress: null, userAgent: null };
let migrated: MigratedSchema;
let schema: string;
let other: TestConnection;

beforeAll(async () => {
	migrated = await openMigratedSchema("session_kept_rebind_race");
	schema = migrated.schema;
	other = await openTestConnection();
});

afterAll(async () => {
	await other.close();
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

function resolvingAfterTheKeptRead(inner: Driver, resolve: () => Promise<unknown>): Driver {
	return {
		query: async <T>(sql: string, params: unknown[]) => {
			const rows = await inner.query<T>(sql, params);
			if (
				/^SELECT s\.id, s\.user_id[\s\S]*WHERE s\.id = \$1 AND s\.user_id = \$2/.test(sql.trim())
			) {
				await resolve();
			}
			return rows;
		},
		transaction: (work) => inner.transaction((tx) => work(resolvingAfterTheKeptRead(tx, resolve))),
	};
}

describe("signing out every other session while the same session resolves during a key rotation", () => {
	it("keeps the caller signed in and raises nothing", async () => {
		const ring = testKeyRing(2);
		const old = ring.providerAt(1, [1, 2]);
		const current = ring.providerAt(2, [1, 2]);
		const userId = await createUser(migrated.connection, schema);
		const before = createSessionService({
			sealing: "migrating",
			driver: migrated.connection,
			keys: old,
			schema,
		});
		const { token } = await before.issue({ userId, factors: ["password"], observed: NO_REQUEST });
		const resolved = await before.resolve(token);
		if (resolved === null) {
			throw new Error("no resolution");
		}
		const elsewhere = createSessionService({
			sealing: "migrating",
			driver: other,
			keys: current,
			schema,
		});
		const refusals: TokenBindingRefusal[] = [];
		const revoking = createSessionService({
			sealing: "migrating",
			driver: resolvingAfterTheKeptRead(migrated.connection, () => elsewhere.resolve(token)),
			keys: current,
			schema,
			reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
		});

		await revoking.revokeEveryOther({ resolved }).catch((failure: unknown) => failure);
		const after = await elsewhere.resolve(token);

		expect({ stillSignedIn: after !== null, refusals }).toStrictEqual({
			stillSignedIn: true,
			refusals: [],
		});
	});
});
