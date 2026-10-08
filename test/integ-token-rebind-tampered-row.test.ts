import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionRepository } from "../src/core/db/repositories/session.js";
import { createSessionService } from "../src/core/session/service.js";
import type { TokenBindingRefusal } from "../src/core/token/binding.js";
import { rebindTokenRowsUnderCurrentKey } from "../src/core/token/rebind.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { testKeyRing } from "./totp-fixtures.js";

//one tampered row is refused and the pass goes on to rebind every other row of the table (S-KEY-5, S-INTEG-9)

const OBSERVED = { ipAddress: null, userAgent: null };
let migrated: MigratedSchema;
let schema: string;

beforeAll(async () => {
	migrated = await openMigratedSchema("integ_token_rebind_tampered");
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

describe.each(["infinity", "-infinity", "9999-12-31 00:00:00+00"])(
	"a session whose created_at a writer moved to %s",
	(moved) => {
		it("is refused by the rebinding pass, and the other session is rebound", async () => {
			await migrated.connection.query(`DELETE FROM ${schema}.session`, []);
			const ring = testKeyRing(2);
			const sessions = createSessionService({
				sealing: "migrating",
				driver: migrated.connection,
				keys: ring.providerAt(1, [1]),
				schema,
			});
			const userId = await createUser(migrated.connection, schema);
			await sessions.issue({ userId, factors: ["password"], observed: OBSERVED });
			await sessions.issue({ userId, factors: ["password"], observed: OBSERVED });
			await migrated.connection.query(
				`UPDATE ${schema}.session SET created_at = $2::timestamptz
				 WHERE id = (SELECT id FROM ${schema}.session WHERE user_id = $1 ORDER BY id LIMIT 1)`,
				[userId, moved],
			);
			const refusals: TokenBindingRefusal[] = [];

			const outcome = await rebindTokenRowsUnderCurrentKey({
				driver: migrated.connection,
				schema,
				keys: ring.providerAt(2, [1, 2]),
				sealing: "migrating",
				table: "session",
				batchSize: 10,
				reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
			});

			expect({ rebound: outcome.rebound, refused: outcome.refused, refusals }).toStrictEqual({
				rebound: 1,
				refused: 1,
				refusals: [
					{
						userId,
						occasion: "maintenance",
						reason: "token_binding_mismatch",
						verdict: "mismatch",
					},
				],
			});
		});

		it("leaves the owner's list readable, without the row", async () => {
			const keys = testKeyRing(1).providerAt(1, [1]);
			const sessions = createSessionService({
				sealing: "migrating",
				driver: migrated.connection,
				keys,
				schema,
			});
			const userId = await createUser(migrated.connection, schema);
			await sessions.issue({ userId, factors: ["password"], observed: OBSERVED });
			await migrated.connection.query(
				`UPDATE ${schema}.session SET created_at = $2::timestamptz WHERE user_id = $1`,
				[userId, moved],
			);
			const repository = createSessionRepository({
				driver: migrated.connection,
				schema,
				keys,
				sealing: "migrating",
			});

			await expect(repository.listSessionsOfUser({ userId })).resolves.toEqual([]);
		});
	},
);
