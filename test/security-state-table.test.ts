import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

//the seal version and epoch stay within what a javascript number holds exactly (E-3092)

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("seal_version");
	connection = migrated.connection;
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

describe("velve.security_state.version and the number the interface carries (migration 3)", () => {
	it("refuses a version above Number.MAX_SAFE_INTEGER", async () => {
		const userId = await createUser(connection, schema);

		const stored = await connection
			.query(
				`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
VALUES ($1, $2::bigint, decode(repeat('00', 32), 'hex'), 1)`,
				[userId, "9223372036854775807"],
			)
			.then(() => "stored")
			.catch(() => "refused");

		expect(stored).toBe("refused");
	});

	it("keeps Number.MAX_SAFE_INTEGER itself, the last version a number holds", async () => {
		const userId = await createUser(connection, schema);

		const [row] = await connection.query<{ version: string }>(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
VALUES ($1, $2::bigint, decode(repeat('00', 32), 'hex'), 1) RETURNING version::text AS version`,
			[userId, String(Number.MAX_SAFE_INTEGER)],
		);

		expect(row?.version).toBe(String(Number.MAX_SAFE_INTEGER));
	});

	it("refuses a version of zero", async () => {
		const userId = await createUser(connection, schema);

		const stored = await connection
			.query(
				`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
VALUES ($1, 0, decode(repeat('00', 32), 'hex'), 1)`,
				[userId],
			)
			.then(() => "stored")
			.catch(() => "refused");

		expect(stored).toBe("refused");
	});
});

describe("velve.security_state.session_epoch (section 3.18, migration 3)", () => {
	async function storedWithEpoch(epoch: string): Promise<string> {
		const userId = await createUser(connection, schema);
		return connection
			.query(
				`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version, session_epoch)
VALUES ($1, 1, decode(repeat('00', 32), 'hex'), 1, $2::bigint)`,
				[userId, epoch],
			)
			.then(() => "stored")
			.catch(() => "refused");
	}

	it("starts every account at epoch 1", async () => {
		const userId = await createUser(connection, schema);

		const [row] = await connection.query<{ session_epoch: string }>(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
VALUES ($1, 1, decode(repeat('00', 32), 'hex'), 1) RETURNING session_epoch::text AS session_epoch`,
			[userId],
		);

		expect(row?.session_epoch).toBe("1");
	});

	it("refuses an epoch of zero and one above Number.MAX_SAFE_INTEGER", async () => {
		expect(await storedWithEpoch("0")).toBe("refused");
		expect(await storedWithEpoch("9007199254740992")).toBe("refused");
		expect(await storedWithEpoch(String(Number.MAX_SAFE_INTEGER))).toBe("stored");
	});
});
