import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import { createPendingAuthenticationService } from "../src/core/factor/pending/index.js";
import { createWebAuthnChallenges } from "../src/core/factor/webauthn/challenge.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { rootKeyProvider } from "../src/core/keys/root-key-provider.js";
import { createSessionService } from "../src/core/session/service.js";
import { createOneTimeTokens } from "../src/core/token/one-time-token.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { decodingJsonb } from "./jsonb-decoding-driver.js";

//a row whose stored key version names a key that cannot take an HMAC cannot be checked and is refused (S-INTEG-9)

const OBSERVED = { ipAddress: null, userAgent: null };
const inner = rootKeyProvider({
	currentVersion: 1,
	keysByVersion: { 1: Buffer.alloc(32, 5).toString("base64url") },
});
let aesKey: CryptoKey;
const keys: KeyProvider = {
	current: (purpose) => inner.current(purpose),
	byVersion: async (purpose, version) =>
		purpose === "token-mac" && version === 2 ? aesKey : inner.byVersion(purpose, version),
};

let migrated: MigratedSchema;
let schema: string;

beforeAll(async () => {
	aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
	migrated = await openMigratedSchema("integ_token_unusable_key");
	schema = migrated.schema;
});
afterAll(async () => {
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

async function moveToVersionTwo(table: string, userId: string): Promise<void> {
	await migrated.connection.query(
		`UPDATE ${schema}.${table} SET token_mac_key_version = 2 WHERE user_id = $1`,
		[userId],
	);
}

describe("an unusable key for the stored version refuses the row", () => {
	it("session resolve", async () => {
		const userId = await createUser(migrated.connection, schema);
		const sessions = createSessionService({
			sealing: "migrating",
			driver: migrated.connection,
			keys,
			schema,
		});
		const { token } = await sessions.issue({ userId, factors: ["password"], observed: OBSERVED });
		expect(await sessions.resolve(token)).not.toBeNull();
		await moveToVersionTwo("session", userId);
		expect(await sessions.resolve(token)).toBeNull();
	});

	it("session listing", async () => {
		const userId = await createUser(migrated.connection, schema);
		const sessions = createSessionService({
			sealing: "migrating",
			driver: migrated.connection,
			keys,
			schema,
		});
		await sessions.issue({ userId, factors: ["password"], observed: OBSERVED });
		await moveToVersionTwo("session", userId);
		const repository = (
			await import("../src/core/db/repositories/session.js")
		).createSessionRepository({
			driver: migrated.connection,
			schema,
			keys,
			sealing: "migrating",
		});
		expect(await repository.listSessionsOfUser({ userId })).toEqual([]);
	});

	it("pending authentication resolve", async () => {
		const userId = await createUser(migrated.connection, schema);
		const pending = createPendingAuthenticationService({
			driver: migrated.connection,
			keys,
			schema,
		});
		const { token } = await pending.begin({ userId, factorsCompleted: ["password"] });
		expect(await pending.resolve(token)).not.toBeNull();
		await moveToVersionTwo("pending_authentication", userId);
		expect(await pending.resolve(token)).toBeNull();
	});

	it("one-time token redeem", async () => {
		const userId = await createUser(migrated.connection, schema);
		const tokens = createOneTimeTokens(
			createOneTimeTokenRepository({ driver: decodingJsonb(migrated.connection), schema }),
			{ keys },
		);
		const { token } = await tokens.issue({ purpose: "magic_link", userId });
		await moveToVersionTwo("one_time_token", userId);
		expect(await tokens.redeem({ token, purpose: "magic_link" })).toBeNull();
	});

	it("webauthn challenge consume", async () => {
		const userId = await createUser(migrated.connection, schema);
		const challenges = createWebAuthnChallenges({ driver: migrated.connection, schema, keys });
		const { challengeToken } = await challenges.issue({ purpose: "register", userId });
		await moveToVersionTwo("webauthn_challenge", userId);
		expect(await challenges.consume({ challengeToken, purpose: "register", userId })).toBe(false);
	});
});
