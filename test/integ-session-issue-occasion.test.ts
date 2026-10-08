import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { createSessionService } from "../src/core/session/service.js";
import type { TokenBindingRefusal } from "../src/core/token/binding.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { aFreshEpochOtherThan } from "./session-fixtures.js";
import { testKeyRing } from "./totp-fixtures.js";

//a missed session issue reports the change it completes as its occasion (S-INTEG-9)

const NO_REQUEST = { ipAddress: null, userAgent: null };

let migrated: MigratedSchema;
let schema: string;
let writer: TestConnection;
let refusals: TokenBindingRefusal[];

beforeAll(async () => {
	migrated = await openMigratedSchema("integ_session_issue_occasion");
	schema = migrated.schema;
	writer = await openTestConnection();
});

afterAll(async () => {
	await writer.close();
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

function writingAfterTheEpochRead(inner: Driver, write: () => Promise<unknown>): Driver {
	return {
		query: async <T>(sql: string, params: unknown[]) => {
			const rows = await inner.query<T>(sql, params);
			if (/^\s*SELECT \(SELECT session_epoch::text/.test(sql)) {
				await write();
			}
			return rows;
		},
		transaction: (work) => inner.transaction((tx) => work(writingAfterTheEpochRead(tx, write))),
	};
}

describe("a missed session issue that completes a change", () => {
	it("raises seal_mismatch with the occasion change, not sign_in", async () => {
		const userId = await createUser(migrated.connection, schema);
		await migrated.connection.query(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
			 VALUES ($1, 1, $2, 1)`,
			[userId, randomBytes(32)],
		);
		const keys = testKeyRing(1).providerAt(1);
		refusals = [];
		const plain = createSessionService({
			sealing: "migrating",
			driver: migrated.connection,
			keys,
			schema,
		});
		const issued = await plain.issue({ userId, factors: ["password"], observed: NO_REQUEST });
		const resolved = await plain.resolve(issued.token);
		if (resolved === null) {
			throw new Error("the fresh session did not resolve");
		}
		let armed = true;
		const racing = createSessionService({
			sealing: "migrating",
			driver: writingAfterTheEpochRead(migrated.connection, async () => {
				if (armed) {
					armed = false;
					await writer.query(
						`UPDATE ${schema}.security_state SET session_epoch = $2 WHERE user_id = $1`,
						[userId, aFreshEpochOtherThan(1)],
					);
				}
			}),
			keys,
			schema,
			reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
		});

		await racing
			.reissueAfterCredentialChange({ resolved, factors: ["password"], observed: NO_REQUEST })
			.catch(() => null);

		expect(refusals).toStrictEqual([
			{ userId, occasion: "change", reason: "seal_mismatch", verdict: "mismatch" },
		]);
	});
});
