import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KeyProvider, rootKeyProvider } from "../src/core/keys/index.js";
import {
	createPasswordCredentialRepository,
	openPhc,
	type PasswordCredentialRepository,
} from "../src/core/password/credential.js";
import {
	actorOfTestUser,
	createUser,
	dropSchema,
	type MigratedSchema,
	openMigratedSchema,
} from "./db-fixtures.js";
import { generateRootKey } from "./keys-fixtures.js";
import { drawTestPassword, type StoredHashes, storedHashesFor } from "./password-fixtures.js";

let migrated: MigratedSchema;
let keys: KeyProvider;
let credentials: PasswordCredentialRepository;
let stored: StoredHashes;

beforeAll(async () => {
	migrated = await openMigratedSchema("owner_created_write");
	keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
	credentials = createPasswordCredentialRepository({
		driver: migrated.connection,
		keys,
		schema: migrated.schema,
	});
	stored = await storedHashesFor(drawTestPassword());
}, 180_000);

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("a write without a proof reaches only an account no other caller owns yet (S-OWNER-1, E-2428)", () => {
	it("leaves the stored password of an account that already has one untouched", async () => {
		const userId = await createUser(migrated.connection, migrated.schema);
		await credentials.write({
			actor: actorOfTestUser(userId),
			phc: stored.byScheme.argon2id,
			scheme: "argon2id",
			setBySessionId: null,
		});

		const overwrite = credentials.writeForCreatedAccount({
			userId,
			phc: stored.byScheme.scrypt,
			scheme: "scrypt",
			setBySessionId: null,
		});
		await overwrite.catch(() => undefined);

		const row = await credentials.findOwnedBy({ actor: actorOfTestUser(userId) });
		expect(row?.scheme).toBe("argon2id");
		expect(row === null ? null : await openPhc(keys, row)).toBe(stored.byScheme.argon2id);
		await expect(overwrite).rejects.toThrow();
	});
});
