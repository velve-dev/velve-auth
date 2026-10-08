import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confirmAddress } from "../src/core/flows/confirmation.js";
import type { PluginRuntime } from "../src/core/plugin/registry.js";
import { createSessionService } from "../src/core/session/service.js";
import { testKeyProvider } from "./auth-fixtures.js";
import {
	actorOfTestUser,
	createUser,
	dropSchema,
	type MigratedSchema,
	openMigratedSchema,
} from "./db-fixtures.js";
import { resealDirectly, testSecurityState } from "./security-state-fixtures.js";

//a confirming session keeps a password only on the account it belongs to (S-LINK-4)

const NO_REQUEST = { ipAddress: null, userAgent: null };
const NO_PLUGINS = { listensTo: () => false } as unknown as PluginRuntime;
let migrated: MigratedSchema;

beforeAll(async () => {
	migrated = await openMigratedSchema("flows_confirming_session");
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

async function firstConfirmationDeletesThePassword(
	confirmedBySessionOf: "the account" | "another",
) {
	const { connection, schema } = migrated;
	const keys = testKeyProvider();
	const sessions = createSessionService({
		sealing: "migrating",
		driver: connection,
		keys: testKeyProvider(),
		schema,
	});
	const userId = await createUser(connection, schema);
	const issued = await sessions.issue({
		authorisedBy: "read_under_lock",
		userId,
		factors: ["password"],
		observed: NO_REQUEST,
	});
	await connection.query(
		`INSERT INTO ${schema}.password_credential (user_id, phc, key_version, scheme, set_by_session_id)
		 VALUES ($1, $2, 1, 'argon2id', $3)`,
		[userId, randomBytes(48), issued.session.id],
	);
	await resealDirectly(connection, schema, keys, userId);
	const other = await createUser(connection, schema);

	const outcome = await connection.transaction((transaction) =>
		confirmAddress({
			transaction,
			schema,
			pluginRuntime: NO_PLUGINS,
			sessions,
			actor: actorOfTestUser(userId),
			securityState: testSecurityState(connection, schema, keys),
			confirmingSession: {
				sessionId: issued.session.id,
				userId: confirmedBySessionOf === "the account" ? userId : other,
			},
			newEmail: null,
		}),
	);
	return outcome.passwordCredentialDeleted;
}

describe("the first confirmation of an address and the session it is confirmed in", () => {
	it("keeps the password set in the confirming session of the same account", async () => {
		expect(await firstConfirmationDeletesThePassword("the account")).toBe(false);
	});

	it("deletes it when the session that names that id belongs to another account", async () => {
		expect(await firstConfirmationDeletesThePassword("another")).toBe(true);
	});
});
