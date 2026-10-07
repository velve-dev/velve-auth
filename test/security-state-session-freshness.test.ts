import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionService, type SessionService } from "../src/core/session/service.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";

// Section 3.18 point 3 binds session.created_at into the session MAC, because freshness is
// measured from it (src/core/session/freshness.ts) and a writer holding a stale session token who
// moves it to now would pass every freshness gate (E-3313). The MAC is the token branch's; until it
// binds created_at the case below is expected to fail, and that branch turns it into a plain it and
// deletes the control. The control holds today's behaviour, so the placeholder fails because the
// renewed session is fresh again and not because its setup throws.

let migrated: MigratedSchema;
let service: SessionService;

beforeAll(async () => {
	migrated = await openMigratedSchema("session_freshness");
	service = createSessionService({ driver: migrated.connection, schema: migrated.schema });
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
	it.fails("does not make the stale session fresh", async () => {
		const renewed = await staleSessionRenewedBySql();
		await expect(service.list({ resolved: renewed ?? never() })).rejects.toMatchObject({
			code: "freshness_required",
		});
	});

	it("control: today the renewed session resolves and passes the freshness gate", async () => {
		const renewed = await staleSessionRenewedBySql();
		await expect(service.list({ resolved: renewed ?? never() })).resolves.toBeDefined();
	});
});

function never(): never {
	throw new Error("the session under test did not resolve");
}
