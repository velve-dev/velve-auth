import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import {
	createPendingAuthenticationService,
	hashPendingToken,
} from "../src/core/factor/pending/index.js";
import { encodeBase64Url } from "../src/core/keys/base64url.js";
import { rootKeyProvider } from "../src/core/keys/index.js";
import { resolvePasswordConfig } from "../src/core/password/config.js";
import { createPasswordCredentialRepository } from "../src/core/password/credential.js";
import { createKdfSemaphore } from "../src/core/password/semaphore.js";
import { createDummyCredential, setPassword } from "../src/core/password/verify.js";
import { createOneTimeTokens } from "../src/core/token/one-time-token.js";
import { ONE_TIME_TOKEN_PURPOSES } from "../src/core/token/purpose.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

let connection: TestConnection;
let schema: string;
let dump: string;
let plaintexts: { readonly name: string; readonly value: string }[];
let userEmail: string;
let howTheDumpWasTaken: "pg_dump" | "every column as text";

const TEST_PASSWORD = "a password only this test knows 8f2c";

async function createEveryArtefactThisBranchCanCreate(userId: string): Promise<void> {
	const keys = rootKeyProvider({
		currentVersion: 1,
		keysByVersion: { 1: encodeBase64Url(randomBytes(32)) },
	});
	const config = resolvePasswordConfig({ concurrentHashLimit: 1 });

	const credentials = createPasswordCredentialRepository({ driver: connection, keys, schema });
	await setPassword(
		{ userId, plaintext: TEST_PASSWORD },
		{
			config,
			semaphore: createKdfSemaphore({ limit: 1 }),
			keys,
			credentials,
			dummy: await createDummyCredential(keys, config),
		},
	);
	plaintexts.push({ name: "password", value: TEST_PASSWORD });

	const stored = await credentials.findByUserId(userId);
	expect(stored).not.toBeNull();

	const pending = createPendingAuthenticationService({ driver: connection, schema });
	const issued = await pending.begin({
		userId,
		factorsCompleted: ["password"],
		availableFactors: [],
	});
	plaintexts.push({ name: "pending token", value: issued.token });

	const tokens = createOneTimeTokens(createOneTimeTokenRepository({ driver: connection, schema }));
	for (const purpose of ONE_TIME_TOKEN_PURPOSES) {
		const oneTime = await tokens.issue({ purpose, userId });
		plaintexts.push({ name: `one-time token (${purpose})`, value: oneTime.token });
	}

	const sessionToken = encodeBase64Url(randomBytes(32));
	await connection.query(
		`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at)
		 VALUES ($1, sha256($2::bytea), now() + interval '7 days', now() + interval '30 days')`,
		[userId, Buffer.from(sessionToken, "utf8")],
	);
	plaintexts.push({ name: "session token", value: sessionToken });
}

/** The instrument S-REST-1 names, where the binary is on PATH; the same bytes otherwise. */
function takeDump(): { text: string; how: typeof howTheDumpWasTaken } {
	const url =
		process.env.VELVE_TEST_DATABASE_URL ?? "postgres://velve:velve@localhost:5432/velve_test";
	try {
		return {
			text: execFileSync("pg_dump", ["--schema", schema, "--no-owner", url], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}),
			how: "pg_dump",
		};
	} catch {
		return { text: "", how: "every column as text" };
	}
}

async function everyColumnAsText(): Promise<string> {
	const tables = await connection.query<{ table_name: string }>(
		`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
		[schema],
	);
	const parts: string[] = [];
	for (const { table_name } of tables) {
		const rows = await connection.query<{ rendered: string }>(
			`SELECT t::text AS rendered FROM ${schema}.${table_name} t`,
			[],
		);
		parts.push(...rows.map((row) => row.rendered));
	}
	return parts.join("\n");
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("atrest");
	connection = migrated.connection;
	schema = migrated.schema;
	plaintexts = [];

	const userId = await createUser(connection, schema);
	const [row] = await connection.query<{ email: string }>(
		`SELECT email FROM ${schema}.user WHERE id = $1`,
		[userId],
	);
	userEmail = row?.email ?? "";

	await createEveryArtefactThisBranchCanCreate(userId);

	const taken = takeDump();
	howTheDumpWasTaken = taken.how;
	dump = taken.how === "pg_dump" ? taken.text : await everyColumnAsText();
}, 60_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function encodingsOf(value: string): readonly string[] {
	return [
		value,
		Buffer.from(value, "utf8").toString("base64"),
		Buffer.from(value, "utf8").toString("hex"),
	];
}

describe("what a dump of the schema holds (S-REST-1, T-REST-1)", () => {
	/**
	 * The requirement counts 24 values in three encodings. Eight of the twenty-four can be created
	 * on this branch; the other sixteen belong to modules other wave-3 features build — the TOTP
	 * secret, the ten recovery codes, the WebAuthn challenge, the OAuth `state`, the PKCE verifier
	 * and the two foreign provider tokens. The count below is therefore stated, not implied.
	 */
	it("was read at all, and the search over it can find something", () => {
		expect(dump.length).toBeGreaterThan(1000);
		expect(dump).toContain(userEmail);
		expect(userEmail.length).toBeGreaterThan(0);
		expect(["pg_dump", "every column as text"]).toContain(howTheDumpWasTaken);
	});

	it("holds every artefact this branch can create, so the search is not searching an empty schema", async () => {
		const [rows] = await connection.query<{ present: number }>(
			`SELECT (SELECT count(*) FROM ${schema}.session)
			 + (SELECT count(*) FROM ${schema}.one_time_token)
			 + (SELECT count(*) FROM ${schema}.pending_authentication)
			 + (SELECT count(*) FROM ${schema}.password_credential) AS present`,
			[],
		);

		expect(plaintexts).toHaveLength(7);
		expect(Number(rows?.present ?? 0)).toBe(7);
	});

	it("contains none of them, in any of the three encodings: 21 searches, 0 hits", () => {
		const hits = plaintexts.flatMap((secret) =>
			encodingsOf(secret.value)
				.filter((encoded) => dump.includes(encoded))
				.map((encoded) => `${secret.name} as ${encoded.slice(0, 12)}…`),
		);

		expect(plaintexts.length * 3).toBe(21);
		expect(hits).toStrictEqual([]);
	});

	// S-REST-2: what the dump does hold in their place is the hash, and it is the right hash.
	it("holds the hash of the pending token where the token would have been", async () => {
		const token = plaintexts.find((secret) => secret.name === "pending token");
		const [row] = await connection.query<{ present: number }>(
			`SELECT count(*)::int AS present FROM ${schema}.pending_authentication WHERE token_sha256 = $1`,
			[hashPendingToken((token?.value ?? "") as never)],
		);

		expect(row?.present).toBe(1);
	});
});

describe("a planted secret is found, so a clean dump means something", () => {
	it("finds a value that really is in the dump", async () => {
		const planted = randomUUID();
		await connection.query(`INSERT INTO ${schema}.user (email) VALUES ($1)`, [
			`${planted}@example.com`,
		]);
		const taken = takeDump();
		const again = taken.how === "pg_dump" ? taken.text : await everyColumnAsText();

		expect(again).toContain(planted);
	});
});
