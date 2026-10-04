import { argon2idAsync } from "@noble/hashes/argon2.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { encodeStandardBase64 } from "../src/core/password/base64.js";
import { sealPhc } from "../src/core/password/credential.js";
import { MAXIMUM_STORED_MEMORY_KIB } from "../src/core/password/limits.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { drawTestPassword } from "./password-fixtures.js";

/**
 * A configured Argon2id memory above the import ceiling raises the ceiling verification applies,
 * so the library verifies every hash it writes, and a stored credential above the raised ceiling
 * is still refused at sign-in (E-2614).
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
			const sealed = await sealPhc(keys, phc);
			const [row] = await migrated.connection.query<{ id: string }>(
				`INSERT INTO ${migrated.schema}.user (email) VALUES ($1) RETURNING id`,
				[email],
			);
			await migrated.connection.query(
				`INSERT INTO ${migrated.schema}.password_credential (user_id, phc, key_version, scheme)
			 VALUES ($1, $2, $3, 'argon2id')`,
				[(row as { id: string }).id, sealed.ciphertext, sealed.keyVersion],
			);
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

		it("refuses a stored credential one KiB above the configured memory", async () => {
			await seedSealed(`above${memoryKiB}@ceiling.example`, await argon2idPhc(memoryKiB + 1));

			const answer = await handler(
				postTo("/sign-in/password", {
					email: `above${memoryKiB}@ceiling.example`,
					password: PASSWORD,
				}),
			);
			expect(answer.status).toBe(401);
		}, 60_000);
	},
);
