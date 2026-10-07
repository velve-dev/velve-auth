import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionService, type SessionService } from "../src/core/session/service.js";
import { testKeyProvider } from "./auth-fixtures.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { rebindSessionsOf } from "./session-fixtures.js";

const KEYS = testKeyProvider();

//a stale session whose created_at a writer renews must be refused as no session (E-3313)

let migrated: MigratedSchema;
let service: SessionService;

beforeAll(async () => {
	migrated = await openMigratedSchema("session_freshness");
	service = createSessionService({
		driver: migrated.connection,
		schema: migrated.schema,
		keys: KEYS,
		sealing: "migrating",
	});
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

async function staleSessionRenewedBySql() {
	const userId = await createUser(migrated.connection, migrated.schema);
	const issued = await service.issue({
		userId,
		factors: ["password"],
		observed: { ipAddress: null, userAgent: null },
	});
	await migrated.connection.query(
		`UPDATE ${migrated.schema}.session SET created_at = created_at - interval '16 minutes' WHERE id = $1`,
		[issued.session.id],
	);
	await rebindSessionsOf(migrated.connection, migrated.schema, KEYS, {
		sessionId: issued.session.id,
	});
	const stale = await service.resolve(issued.token);
	await expect(service.list({ resolved: stale ?? never() })).rejects.toMatchObject({
		code: "freshness_required",
	});
	await migrated.connection.query(
		`UPDATE ${migrated.schema}.session SET created_at = now() WHERE id = $1`,
		[issued.session.id],
	);
	return service.resolve(issued.token);
}

describe("a writer who renews the created_at of a stale session (section 3.18 point 3)", () => {
	it("does not make the stale session fresh, because the renewed row resolves to nothing", async () => {
		expect(await staleSessionRenewedBySql()).toBeNull();
	});
});

function never(): never {
	throw new Error("the session under test did not resolve");
}
