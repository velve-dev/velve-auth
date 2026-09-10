import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KeyProvider, rootKeyProvider } from "../src/core/keys/index.js";
import { resolvePasswordConfig } from "../src/core/password/config.js";
import {
	createPasswordCredentialRepository,
	openPhc,
	type PasswordCredentialRepository,
	type PasswordCredentialRow,
} from "../src/core/password/credential.js";
import { parsePhc } from "../src/core/password/phc.js";
import { createKdfSemaphore } from "../src/core/password/semaphore.js";
import { checkPassword, createDummyCredential, setPassword } from "../src/core/password/verify.js";
import { dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { generateRootKey } from "./keys-fixtures.js";
import { drawTestPassword, type StoredHashes, storedHashesFor } from "./password-fixtures.js";

const PASSWORD = drawTestPassword();
const WRONG_PASSWORD = drawTestPassword();
const CHEAP_ARGON2ID = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

let migrated: MigratedSchema;
let keys: KeyProvider;
let credentials: PasswordCredentialRepository;
let stored: StoredHashes;

interface RawRow {
	readonly phc: Uint8Array<ArrayBuffer>;
	readonly key_version: number;
	readonly scheme: string;
}

async function createUser(local: string): Promise<string> {
	const [row] = await migrated.connection.query<{ id: string }>(
		`INSERT INTO ${migrated.schema}.user (email) VALUES ($1) RETURNING id`,
		[`${local}@example.test`],
	);
	if (row === undefined) {
		throw new Error("the fixture user was not created");
	}
	return row.id;
}

async function readRaw(userId: string): Promise<RawRow> {
	const [row] = await migrated.connection.query<RawRow>(
		`SELECT phc, key_version, scheme FROM ${migrated.schema}.password_credential WHERE user_id = $1`,
		[userId],
	);
	if (row === undefined) {
		throw new Error("the credential row was not written");
	}
	return row;
}

beforeAll(async () => {
	migrated = await openMigratedSchema("password_storage");
	keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
	credentials = createPasswordCredentialRepository({
		driver: migrated.connection,
		keys,
		schema: migrated.schema,
	});
	stored = await storedHashesFor(PASSWORD);
}, 180_000);

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("L-2 / S-REST-5 — the PHC string is stored encrypted", () => {
	it("writes ciphertext for every one of the eleven prefixes and reads back the prefix", async () => {
		let index = 0;
		for (const [prefix, phc] of stored.byPrefix) {
			const userId = await createUser(`prefix${index}`);
			index += 1;

			const scheme = prefix.startsWith("$2") ? "bcrypt" : prefix.slice(1, -1);
			await credentials.write({
				userId,
				phc,
				scheme: scheme as PasswordCredentialRow["scheme"],
				setBySessionId: null,
			});

			const raw = await readRaw(userId);
			expect(raw.scheme, prefix).toBe(scheme);
			expect(raw.key_version, prefix).toBe(1);

			// The column holds nonce, ciphertext and tag and no header, so its first byte is a random
			// nonce byte: asserting that it is not `$` passes 255 runs in 256 and says nothing. What
			// the requirement means is that the bytes are not a PHC string, and that is decidable.
			expect(raw.phc.length, prefix).toBe(12 + Buffer.byteLength(phc, "utf8") + 16);
			expect(parsePhc(new TextDecoder().decode(raw.phc)), prefix).toBeNull();
			expect(Buffer.from(raw.phc).includes(Buffer.from(phc, "utf8")), prefix).toBe(false);

			const opened = await openPhc(keys, {
				userId,
				phc: raw.phc,
				keyVersion: raw.key_version,
				scheme: raw.scheme as PasswordCredentialRow["scheme"],
			});
			expect(opened, prefix).toBe(phc);
			expect(opened.startsWith(prefix), prefix).toBe(true);
		}
	}, 180_000);

	it("leaves no column of the schema carrying the PHC string in any of three encodings", async () => {
		const userId = await createUser("dump");
		await credentials.write({
			userId,
			phc: stored.byScheme.argon2id,
			scheme: "argon2id",
			setBySessionId: null,
		});

		const columns = await migrated.connection.query<{ table_name: string; column_name: string }>(
			`SELECT table_name, column_name FROM information_schema.columns
			 WHERE table_schema = $1 AND data_type IN ('text', 'character varying', 'bytea')`,
			[migrated.schema],
		);

		const needles = [
			stored.byScheme.argon2id,
			Buffer.from(stored.byScheme.argon2id, "utf8").toString("base64"),
			Buffer.from(stored.byScheme.argon2id, "utf8").toString("hex"),
			PASSWORD,
		];

		let searches = 0;
		for (const column of columns) {
			for (const needle of needles) {
				const [found] = await migrated.connection.query<{ hits: string }>(
					`SELECT count(*)::text AS hits FROM ${migrated.schema}.${column.table_name}
					 WHERE position($1 in encode(${column.column_name}::text::bytea, 'escape')) > 0`,
					[needle],
				);
				searches += 1;
				expect(
					Number(found?.hits ?? 0),
					`${column.table_name}.${column.column_name} for ${needle.slice(0, 24)}`,
				).toBe(0);
			}
		}

		expect(searches).toBeGreaterThan(0);

		// The sweep has to be able to tell "found nothing" from "matched no rows": a planted copy
		// of the same string in a text column of the same schema must be found.
		await migrated.connection.query(
			`UPDATE ${migrated.schema}.user SET imported_from = $1 WHERE id = $2`,
			[stored.byScheme.argon2id, userId],
		);
		const [planted] = await migrated.connection.query<{ hits: string }>(
			`SELECT count(*)::text AS hits FROM ${migrated.schema}.user
			 WHERE position($1 in encode(imported_from::text::bytea, 'escape')) > 0`,
			[stored.byScheme.argon2id],
		);
		expect(Number(planted?.hits ?? 0)).toBe(1);

		await migrated.connection.query(
			`UPDATE ${migrated.schema}.user SET imported_from = NULL WHERE id = $1`,
			[userId],
		);
	}, 180_000);

	it("refuses the ciphertext under a different root key rather than answering wrongly", async () => {
		const userId = await createUser("wrongkey");
		await credentials.write({
			userId,
			phc: stored.byScheme.argon2id,
			scheme: "argon2id",
			setBySessionId: null,
		});
		const raw = await readRaw(userId);

		const otherKeys = rootKeyProvider({
			currentVersion: 1,
			keysByVersion: { 1: generateRootKey() },
		});

		await expect(
			openPhc(otherKeys, {
				userId,
				phc: raw.phc,
				keyVersion: raw.key_version,
				scheme: "argon2id",
			}),
		).rejects.toMatchObject({ name: "KeyError" });
	}, 180_000);

	it("keeps the scheme readable without a key at all", async () => {
		const [row] = await migrated.connection.query<{ scheme: string; count: string }>(
			`SELECT scheme, count(*)::text AS count FROM ${migrated.schema}.password_credential
			 GROUP BY scheme ORDER BY count(*) DESC LIMIT 1`,
			[],
		);

		expect(row?.scheme).toBeTypeOf("string");
		expect(Number(row?.count)).toBeGreaterThan(0);
	});

	it("records the key version the row was written under", async () => {
		const userId = await createUser("version");
		const rotated = rootKeyProvider({
			currentVersion: 7,
			keysByVersion: { 1: generateRootKey(), 7: generateRootKey() },
		});
		const rotatedCredentials = createPasswordCredentialRepository({
			driver: migrated.connection,
			keys: rotated,
			schema: migrated.schema,
		});

		await rotatedCredentials.write({
			userId,
			phc: stored.byScheme.argon2id,
			scheme: "argon2id",
			setBySessionId: null,
		});
		const raw = await readRaw(userId);

		expect(raw.key_version).toBe(7);
		expect(
			await openPhc(rotated, {
				userId,
				phc: raw.phc,
				keyVersion: raw.key_version,
				scheme: "argon2id",
			}),
		).toBe(stored.byScheme.argon2id);
	}, 180_000);
});

describe("3.3 step 6 — the silent rehash is a compare and swap (S-RACE-6)", () => {
	it("replaces a legacy credential after a correct sign-in and only then", async () => {
		const userId = await createUser("rehash");
		await credentials.write({
			userId,
			phc: stored.byScheme.bcrypt,
			scheme: "bcrypt",
			setBySessionId: null,
		});

		const config = resolvePasswordConfig({ argon2id: CHEAP_ARGON2ID });
		const environment = {
			config,
			keys,
			credentials,
			semaphore: createKdfSemaphore({ limit: config.concurrentHashLimit }),
			dummy: await createDummyCredential(keys, config),
		};

		const wrong = await checkPassword({ userId, plaintext: WRONG_PASSWORD }, environment);
		expect(wrong.outcome).toBe("refused");
		expect((await readRaw(userId)).scheme).toBe("bcrypt");

		const right = await checkPassword({ userId, plaintext: PASSWORD }, environment);
		if (right.outcome !== "verified" || right.rehash === undefined) {
			throw new Error("a bcrypt credential must ask to be rehashed");
		}
		expect((await readRaw(userId)).scheme).toBe("bcrypt");

		expect(await right.rehash()).toBe(true);
		const after = await readRaw(userId);
		expect(after.scheme).toBe("argon2id");
		expect(
			await openPhc(keys, {
				userId,
				phc: after.phc,
				keyVersion: after.key_version,
				scheme: "argon2id",
			}),
		).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);

		expect(await right.rehash()).toBe(false);
	}, 180_000);

	it("loses to a password the user changed while it was running", async () => {
		const userId = await createUser("race");
		await credentials.write({
			userId,
			phc: stored.byScheme.bcrypt,
			scheme: "bcrypt",
			setBySessionId: null,
		});

		const config = resolvePasswordConfig({ argon2id: CHEAP_ARGON2ID });
		const environment = {
			config,
			keys,
			credentials,
			semaphore: createKdfSemaphore({ limit: config.concurrentHashLimit }),
			dummy: await createDummyCredential(keys, config),
		};

		const check = await checkPassword({ userId, plaintext: PASSWORD }, environment);
		if (check.outcome !== "verified" || check.rehash === undefined) {
			throw new Error("a bcrypt credential must ask to be rehashed");
		}

		await setPassword({ userId, plaintext: WRONG_PASSWORD, setBySessionId: null }, environment);
		const chosen = await readRaw(userId);

		expect(await check.rehash()).toBe(false);
		expect(Buffer.from((await readRaw(userId)).phc)).toEqual(Buffer.from(chosen.phc));
		expect((await checkPassword({ userId, plaintext: WRONG_PASSWORD }, environment)).outcome).toBe(
			"verified",
		);
	}, 180_000);

	it("lets exactly one of eight concurrent rehashes win", async () => {
		const userId = await createUser("concurrent");
		await credentials.write({
			userId,
			phc: stored.byScheme.bcrypt,
			scheme: "bcrypt",
			setBySessionId: null,
		});
		const before = await readRaw(userId);

		const settled = await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				credentials.replaceIfUnchanged({
					userId,
					previous: before.phc,
					phc: `$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$AAcOFRwjKjE4P0ZNVFtiaXB3foWMk5qhqK+2vcTL0t${index}`,
					scheme: "argon2id",
				}),
			),
		);

		expect(settled.filter(Boolean)).toHaveLength(1);
	}, 180_000);
});
