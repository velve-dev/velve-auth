import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionRepository } from "../src/core/db/repositories/session.js";
import { createSessionService } from "../src/core/session/service.js";
import { testKeyProvider } from "./auth-fixtures.js";
import {
	actorOfTestUser,
	createUser,
	dropSchema,
	type MigratedSchema,
	openMigratedSchema,
} from "./db-fixtures.js";

//a rebinding at resolve time compares the MAC, the key version and the owner it read and never overwrites a concurrent one (S-KEY-5)

const OBSERVED = { ipAddress: null, userAgent: null };
const keys = testKeyProvider();
let migrated: MigratedSchema;
let schema: string;

beforeAll(async () => {
	migrated = await openMigratedSchema("session_rebind_compare_and_set");
	schema = migrated.schema;
});
afterAll(async () => {
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

async function storedMac(userId: string) {
	const [row] = await migrated.connection.query<{
		id: string;
		token_mac: Buffer;
		token_mac_key_version: number;
	}>(`SELECT id, token_mac, token_mac_key_version FROM ${schema}.session WHERE user_id = $1`, [
		userId,
	]);
	if (row === undefined) throw new Error("no row");
	return row;
}

async function setup() {
	const userId = await createUser(migrated.connection, schema);
	const sessions = createSessionService({
		sealing: "migrating",
		driver: migrated.connection,
		keys,
		schema,
	});
	await sessions.issue({
		authorisedBy: "unsealed",
		userId,
		factors: ["password"],
		observed: OBSERVED,
	});
	const repository = createSessionRepository({
		driver: migrated.connection,
		schema,
		keys,
		sealing: "migrating",
	});
	return { userId, repository, before: await storedMac(userId) };
}

describe("rebindSessionTokenMac", () => {
	it("does not overwrite a MAC another rebinding wrote since the row was read", async () => {
		const { userId, repository, before } = await setup();
		const concurrent = randomBytes(32);
		await migrated.connection.query(`UPDATE ${schema}.session SET token_mac = $2 WHERE id = $1`, [
			before.id,
			concurrent,
		]);

		await repository.rebindSessionTokenMac({
			actor: actorOfTestUser(userId),
			sessionId: before.id,
			previous: { tokenMac: before.token_mac, tokenMacKeyVersion: before.token_mac_key_version },
			next: { tokenMac: randomBytes(32), tokenMacKeyVersion: 1 },
		});

		expect(Buffer.from((await storedMac(userId)).token_mac).equals(concurrent)).toBe(true);
	});

	it("does not overwrite a row another rebinding moved to another key version with the same MAC", async () => {
		const { userId, repository, before } = await setup();
		await migrated.connection.query(
			`UPDATE ${schema}.session SET token_mac_key_version = 2 WHERE id = $1`,
			[before.id],
		);

		await repository.rebindSessionTokenMac({
			actor: actorOfTestUser(userId),
			sessionId: before.id,
			previous: { tokenMac: before.token_mac, tokenMacKeyVersion: before.token_mac_key_version },
			next: { tokenMac: randomBytes(32), tokenMacKeyVersion: 3 },
		});

		expect((await storedMac(userId)).token_mac_key_version).toBe(2);
	});

	it("does not rebind a row for an actor that is not its owner", async () => {
		const { repository, before } = await setup();
		const other = await createUser(migrated.connection, schema);
		const next = randomBytes(32);

		await repository.rebindSessionTokenMac({
			actor: actorOfTestUser(other),
			sessionId: before.id,
			previous: { tokenMac: before.token_mac, tokenMacKeyVersion: before.token_mac_key_version },
			next: { tokenMac: next, tokenMacKeyVersion: 1 },
		});

		const [row] = await migrated.connection.query<{ token_mac: Buffer }>(
			`SELECT token_mac FROM ${schema}.session WHERE id = $1`,
			[before.id],
		);
		expect(Buffer.from(row?.token_mac ?? []).equals(Buffer.from(before.token_mac))).toBe(true);
	});
});
