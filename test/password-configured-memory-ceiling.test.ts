import { argon2idAsync } from "@noble/hashes/argon2.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { encodeStandardBase64 } from "../src/core/password/base64.js";
import { resolvePasswordConfig } from "../src/core/password/config.js";
import {
	createPasswordCredentialRepository,
	openPhc,
	sealPhc,
} from "../src/core/password/credential.js";
import { CredentialWriteError, PasswordConfigurationError } from "../src/core/password/errors.js";
import {
	MAXIMUM_CONFIGURABLE_MEMORY_KIB,
	MAXIMUM_STORED_MEMORY_KIB,
} from "../src/core/password/limits.js";
import { integerParameter, parsePhc } from "../src/core/password/phc.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, testKeyProvider } from "./auth-fixtures.js";
import { actorOfTestUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { drawTestPassword } from "./password-fixtures.js";
import { resealDirectly } from "./security-state-fixtures.js";

/**
 * A configured Argon2id memory above the import ceiling raises the ceiling verification applies,
 * so the library verifies every hash it writes, and a stored credential above the raised ceiling
 * is still refused, at sign-in and when it is written (E-2614).
 */

type Opened = Awaited<ReturnType<typeof openMigratedSchema>>;

const PASSWORD = drawTestPassword();
const ABOVE_THE_IMPORT_CEILING = MAXIMUM_STORED_MEMORY_KIB + 1;
const TWICE_THE_IMPORT_CEILING = MAXIMUM_STORED_MEMORY_KIB * 2;

const opened: Opened[] = [];

afterAll(async () => {
	for (const { connection, schema } of opened) {
		await dropSchema(connection, schema);
		await connection.close();
	}
});

async function argon2idPhc(memoryKiB: number): Promise<string> {
	const salt = new Uint8Array(16).fill(5);
	const hash = await argon2idAsync(new TextEncoder().encode(PASSWORD), salt, {
		m: memoryKiB,
		t: 1,
		p: 1,
		dkLen: 32,
		version: 0x13,
	});
	return `$argon2id$v=19$m=${memoryKiB},t=1,p=1$${encodeStandardBase64(salt)}$${encodeStandardBase64(hash)}`;
}

describe.each([ABOVE_THE_IMPORT_CEILING, TWICE_THE_IMPORT_CEILING])(
	"argon2id.memoryKiB configured at %i KiB",
	(memoryKiB) => {
		const keys = testKeyProvider();
		let migrated: Opened;
		let handler: (request: Request) => Promise<Response>;

		beforeAll(async () => {
			migrated = await openMigratedSchema("memceiling");
			opened.push(migrated);
			handler = toWebHandler(
				createVelveAuth(
					configFor({
						database: migrated.connection,
						schema: migrated.schema,
						keys,
						password: { argon2id: { memoryKiB, iterations: 2, parallelism: 1 } },
					}),
				),
			);
		}, 60_000);

		async function seedSealed(email: string, phc: string): Promise<void> {
			const [row] = await migrated.connection.query<{ id: string }>(
				`INSERT INTO ${migrated.schema}.user (email) VALUES ($1) RETURNING id`,
				[email],
			);
			const userId = (row as { id: string }).id;
			const sealed = await sealPhc(keys, userId, phc);
			await migrated.connection.query(
				`INSERT INTO ${migrated.schema}.password_credential (user_id, phc, key_version, scheme)
			 VALUES ($1, $2, $3, 'argon2id')`,
				[userId, sealed.ciphertext, sealed.keyVersion],
			);
			await resealDirectly(migrated.connection, migrated.schema, keys, userId);
		}

		it("verifies a password the library set at the configured memory", async () => {
			const signedUp = await handler(
				postTo("/sign-up", { email: `own${memoryKiB}@ceiling.example`, password: PASSWORD }),
			);
			expect(signedUp.status).toBe(200);

			const signedIn = await handler(
				postTo("/sign-in/password", {
					email: `own${memoryKiB}@ceiling.example`,
					password: PASSWORD,
				}),
			);
			expect(signedIn.status).toBe(200);
		}, 60_000);

		it("verifies a stored credential at exactly the configured memory", async () => {
			await seedSealed(`at${memoryKiB}@ceiling.example`, await argon2idPhc(memoryKiB));

			const answer = await handler(
				postTo("/sign-in/password", {
					email: `at${memoryKiB}@ceiling.example`,
					password: PASSWORD,
				}),
			);
			expect(answer.status).toBe(200);
		}, 60_000);

		it("verifies a stored credential above the configured memory and within the start bound", async () => {
			await seedSealed(`above${memoryKiB}@ceiling.example`, await argon2idPhc(memoryKiB + 1));

			const answer = await handler(
				postTo("/sign-in/password", {
					email: `above${memoryKiB}@ceiling.example`,
					password: PASSWORD,
				}),
			);
			expect(answer.status).toBe(200);
		}, 60_000);

		it("refuses a stored credential above the start bound", async () => {
			const filler = encodeStandardBase64(new Uint8Array(32).fill(3));
			await seedSealed(
				`beyond${memoryKiB}@ceiling.example`,
				`$argon2id$v=19$m=${MAXIMUM_CONFIGURABLE_MEMORY_KIB + 1},t=2,p=1$${filler}$${filler}`,
			);

			const answer = await handler(
				postTo("/sign-in/password", {
					email: `beyond${memoryKiB}@ceiling.example`,
					password: PASSWORD,
				}),
			);
			expect(answer.status).toBe(401);
		}, 60_000);

		it("refuses to write a credential above the raised ceiling and writes one at it", async () => {
			const credentials = createPasswordCredentialRepository({
				driver: migrated.connection,
				keys,
				schema: migrated.schema,
				memoryCeilingKiB: memoryKiB,
			});
			const [row] = await migrated.connection.query<{ id: string }>(
				`INSERT INTO ${migrated.schema}.user (email) VALUES ($1) RETURNING id`,
				[`write${memoryKiB}@ceiling.example`],
			);
			const actor = actorOfTestUser((row as { id: string }).id);
			const filler = encodeStandardBase64(new Uint8Array(32).fill(3));

			await expect(
				credentials.write({
					actor,
					phc: `$argon2id$v=19$m=${memoryKiB + 1},t=2,p=1$${filler}$${filler}`,
					scheme: "argon2id",
					setBySessionId: null,
				}),
			).rejects.toStrictEqual(new CredentialWriteError("credential_not_verifiable"));
			await credentials.write({
				actor,
				phc: `$argon2id$v=19$m=${memoryKiB},t=2,p=1$${filler}$${filler}`,
				scheme: "argon2id",
				setBySessionId: null,
			});
		}, 60_000);
	},
);

describe("the import ceiling under the default parameters", () => {
	it("refuses to write a credential above it through any repository method", async () => {
		const migrated = await openMigratedSchema("memceilingdefault");
		opened.push(migrated);
		const keys = testKeyProvider();
		const credentials = createPasswordCredentialRepository({
			driver: migrated.connection,
			keys,
			schema: migrated.schema,
			memoryCeilingKiB: MAXIMUM_STORED_MEMORY_KIB,
		});
		const [row] = await migrated.connection.query<{ id: string }>(
			`INSERT INTO ${migrated.schema}.user (email) VALUES ($1) RETURNING id`,
			["default@ceiling.example"],
		);
		const userId = (row as { id: string }).id;
		const filler = encodeStandardBase64(new Uint8Array(32).fill(3));
		const above = `$argon2id$v=19$m=${ABOVE_THE_IMPORT_CEILING},t=2,p=1$${filler}$${filler}`;
		const refused = new CredentialWriteError("credential_not_verifiable");

		await expect(
			credentials.write({
				actor: actorOfTestUser(userId),
				phc: above,
				scheme: "argon2id",
				setBySessionId: null,
			}),
		).rejects.toStrictEqual(refused);
		await expect(
			credentials.writeForCreatedAccount({
				userId,
				phc: above,
				scheme: "argon2id",
				setBySessionId: null,
			}),
		).rejects.toStrictEqual(refused);
		await expect(
			credentials.write({
				actor: actorOfTestUser(userId),
				phc: "$2b$15$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234",
				scheme: "bcrypt",
				setBySessionId: null,
			}),
		).rejects.toStrictEqual(refused);
		await expect(
			credentials.replaceIfUnchanged({
				userId,
				previous: new Uint8Array(1),
				phc: above,
				scheme: "argon2id",
			}),
		).rejects.toStrictEqual(refused);
	}, 60_000);
});

describe("a credential the derivation itself refuses (E-2617)", () => {
	const filler = encodeStandardBase64(new Uint8Array(32).fill(3));
	it.each([
		["a bcrypt string of the wrong length", "$2b$10$tooshorttobeahash", "bcrypt"],
		[
			"an Argon2id salt below eight bytes",
			`$argon2id$v=19$m=19456,t=2,p=1$${encodeStandardBase64(new Uint8Array(4).fill(3))}$${filler}`,
			"argon2id",
		],
		[
			"an Argon2id memory below eight times p",
			`$argon2id$v=19$m=1,t=2,p=1$${filler}$${filler}`,
			"argon2id",
		],
		[
			"an Argon2id version that is neither 0x10 nor 0x13",
			`$argon2id$v=17$m=19456,t=2,p=1$${filler}$${filler}`,
			"argon2id",
		],
	] as const)(
		"is not stored: %s",
		async (_, phc, scheme) => {
			const migrated = await openMigratedSchema("memceilingmalformed");
			opened.push(migrated);
			const credentials = createPasswordCredentialRepository({
				driver: migrated.connection,
				keys: testKeyProvider(),
				schema: migrated.schema,
				memoryCeilingKiB: MAXIMUM_STORED_MEMORY_KIB,
			});
			const [row] = await migrated.connection.query<{ id: string }>(
				`INSERT INTO ${migrated.schema}.user (email) VALUES ($1) RETURNING id`,
				["malformed@ceiling.example"],
			);

			await expect(
				credentials.write({
					actor: actorOfTestUser((row as { id: string }).id),
					phc,
					scheme,
					setBySessionId: null,
				}),
			).rejects.toStrictEqual(new CredentialWriteError("credential_not_verifiable"));
		},
		60_000,
	);
});

describe("a configuration whose own hashes the stored ceilings refuse", () => {
	it.each([
		["iterations above the stored ceiling", { memoryKiB: 19456, iterations: 65, parallelism: 1 }],
		["parallelism above the stored ceiling", { memoryKiB: 19456, iterations: 2, parallelism: 65 }],
	])(
		"is refused at start or verifies what it writes: %s",
		async (_, argon2id) => {
			const migrated = await openMigratedSchema("memceilingconfig");
			opened.push(migrated);
			let handler: (request: Request) => Promise<Response>;
			try {
				handler = toWebHandler(
					createVelveAuth(
						configFor({
							database: migrated.connection,
							schema: migrated.schema,
							keys: testKeyProvider(),
							password: { argon2id },
						}),
					),
				);
			} catch (error) {
				expect(error).toBeInstanceOf(PasswordConfigurationError);
				return;
			}

			const signedUp = await handler(
				postTo("/sign-up", { email: "configured@ceiling.example", password: PASSWORD }),
			);
			expect(signedUp.status, "a password set under this configuration is stored").toBe(200);
			const signedIn = await handler(
				postTo("/sign-in/password", { email: "configured@ceiling.example", password: PASSWORD }),
			);
			expect(signedIn.status, "and verifies").toBe(200);
		},
		120_000,
	);
});

describe("the upper bounds a configuration is held to at start", () => {
	it.each([
		["argon2id_memory_above_ceiling", { memoryKiB: 1_048_577, iterations: 2, parallelism: 1 }],
		["argon2id_iterations_above_ceiling", { memoryKiB: 19456, iterations: 65, parallelism: 1 }],
		["argon2id_parallelism_above_ceiling", { memoryKiB: 19456, iterations: 2, parallelism: 65 }],
	] as const)("refuses %s", (code, argon2id) => {
		expect(() => resolvePasswordConfig({ argon2id })).toThrow(new PasswordConfigurationError(code));
	});

	it("accepts each bound itself", () => {
		expect(
			resolvePasswordConfig({
				argon2id: { memoryKiB: 1_048_576, iterations: 64, parallelism: 64 },
			}).argon2id,
		).toStrictEqual({ memoryKiB: 1_048_576, iterations: 64, parallelism: 64 });
	});
});

describe("lowering argon2id.memoryKiB after hashes were written above the new value", () => {
	it("locks nobody out and rewrites the hash at the lowered memory at the first sign-in", async () => {
		const migrated = await openMigratedSchema("memceilinglowered");
		opened.push(migrated);
		const keys = testKeyProvider();
		const mountAt = (memoryKiB: number) =>
			toWebHandler(
				createVelveAuth(
					configFor({
						database: migrated.connection,
						schema: migrated.schema,
						keys,
						password: { argon2id: { memoryKiB, iterations: 2, parallelism: 1 } },
					}),
				),
			);
		const email = "lowered@ceiling.example";
		const storedMemoryKiB = async (): Promise<number | null> => {
			const [row] = await migrated.connection.query<{
				user_id: string;
				phc: Uint8Array<ArrayBuffer>;
				key_version: number;
			}>(
				`SELECT credential.user_id, credential.phc, credential.key_version
				 FROM ${migrated.schema}.password_credential credential
				 JOIN ${migrated.schema}.user account ON account.id = credential.user_id
				 WHERE account.email = $1`,
				[email],
			);
			const sealed = row as { user_id: string; phc: Uint8Array<ArrayBuffer>; key_version: number };
			const phc = parsePhc(
				await openPhc(keys, {
					userId: sealed.user_id,
					phc: sealed.phc,
					keyVersion: sealed.key_version,
					scheme: "argon2id",
					unbound: "refused",
				}),
			);
			return phc === null ? null : integerParameter(phc, "m");
		};

		const atTheHigherMemory = mountAt(TWICE_THE_IMPORT_CEILING);
		expect(
			(await atTheHigherMemory(postTo("/sign-up", { email, password: PASSWORD }))).status,
		).toBe(200);
		expect(await storedMemoryKiB()).toBe(TWICE_THE_IMPORT_CEILING);

		const atTheLoweredMemory = mountAt(19456);
		expect(
			(await atTheLoweredMemory(postTo("/sign-in/password", { email, password: PASSWORD }))).status,
		).toBe(200);
		const deadline = Date.now() + 30_000;
		while ((await storedMemoryKiB()) !== 19456 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(await storedMemoryKiB()).toBe(19456);
		expect(
			(await atTheLoweredMemory(postTo("/sign-in/password", { email, password: PASSWORD }))).status,
		).toBe(200);
	}, 120_000);
});
