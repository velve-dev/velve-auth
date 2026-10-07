import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionRepository } from "../src/core/db/repositories/session.js";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import { createPendingAuthenticationService } from "../src/core/factor/pending/index.js";
import { hashPendingToken } from "../src/core/factor/pending/token.js";
import { createSessionService } from "../src/core/session/service.js";
import { sessionTokenHash } from "../src/core/session/token.js";
import { createOneTimeTokens } from "../src/core/token/one-time-token.js";
import { hashSecretToken, toSecretToken } from "../src/core/token/secret-token.js";
import {
	actorOfTestUser,
	createUser,
	dropSchema,
	type MigratedSchema,
	openMigratedSchema,
} from "./db-fixtures.js";
import { aFreshEpochOtherThan } from "./session-fixtures.js";
import { testKeyRing } from "./totp-fixtures.js";

// S-INTEG-9: the whole 32-byte MAC is compared. A row whose MAC differs in a late byte only, and
// a session row written back under an epoch the account has left, are refused and not listed.

const NO_REQUEST = { ipAddress: null, userAgent: null };
const LATE_BYTES = [16, 24, 31];

let migrated: MigratedSchema;
let schema: string;
const keys = testKeyRing(1).providerAt(1);

beforeAll(async () => {
	migrated = await openMigratedSchema("review_mac_tail");
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

function flipByte(table: string, hash: Uint8Array, index: number): Promise<unknown> {
	return migrated.connection.query(
		`UPDATE ${schema}.${table}
		 SET token_mac = set_byte(token_mac, ${index}, get_byte(token_mac, ${index}) # 1)
		 WHERE token_sha256 = $1`,
		[hash],
	);
}

describe("a MAC that differs from the genuine one in a late byte only", () => {
	it.each(LATE_BYTES)("is refused on a session when byte %i is flipped", async (index) => {
		const sessions = createSessionService({
			sealing: "migrating",
			driver: migrated.connection,
			keys,
			schema,
		});
		const userId = await createUser(migrated.connection, schema);
		const issued = await sessions.issue({ userId, factors: ["password"], observed: NO_REQUEST });
		expect((await sessions.resolve(issued.token))?.userId).toBe(userId);

		await flipByte("session", sessionTokenHash(issued.token), index);

		expect(await sessions.resolve(issued.token)).toBeNull();
	});

	it.each(LATE_BYTES)(
		"is refused on a pending authentication when byte %i is flipped",
		async (index) => {
			const pending = createPendingAuthenticationService({
				driver: migrated.connection,
				keys,
				schema,
			});
			const userId = await createUser(migrated.connection, schema);
			const { token } = await pending.begin({ userId, factorsCompleted: ["password"] });
			expect((await pending.resolve(token))?.userId).toBe(userId);

			await flipByte("pending_authentication", hashPendingToken(token), index);

			expect(await pending.resolve(token)).toBeNull();
		},
	);

	it.each(LATE_BYTES)("is refused on a one-time token when byte %i is flipped", async (index) => {
		const tokens = createOneTimeTokens(
			createOneTimeTokenRepository({ driver: migrated.connection, schema }),
			{ keys },
		);
		const userId = await createUser(migrated.connection, schema);
		const { token } = await tokens.issue({ purpose: "magic_link", userId });

		await flipByte("one_time_token", hashSecretToken(toSecretToken(token)), index);

		expect(await tokens.redeem({ token: toSecretToken(token), purpose: "magic_link" })).toBeNull();
	});
});

describe("the session list of an account whose epoch is above 1", () => {
	it("lists the session bound to the current epoch and not one written back under an older one", async () => {
		const sessions = createSessionService({
			sealing: "migrating",
			driver: migrated.connection,
			keys,
			schema,
		});
		const repository = createSessionRepository({
			driver: migrated.connection,
			schema,
			keys,
			sealing: "migrating",
		});
		const userId = await createUser(migrated.connection, schema);
		await migrated.connection.query(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
			 VALUES ($1, 1, $2, 1)`,
			[userId, randomBytes(32)],
		);
		const old = await sessions.issue({ userId, factors: ["password"], observed: NO_REQUEST });
		await migrated.connection.query(
			`UPDATE ${schema}.security_state SET session_epoch = $2 WHERE user_id = $1`,
			[userId, aFreshEpochOtherThan(1)],
		);
		const current = await sessions.issue({ userId, factors: ["password"], observed: NO_REQUEST });

		const listed = (await repository.listSessionsOfUser({ userId })).map((session) => session.id);

		expect(listed).toStrictEqual([current.session.id]);
		expect(listed).not.toContain(old.session.id);
	});
});

describe('the session list of an account without a seal row in "required"', () => {
	it("lists nothing and announces nothing, however the rows came to be", async () => {
		const migrating = createSessionService({
			sealing: "migrating",
			driver: migrated.connection,
			keys,
			schema,
		});
		const required = createSessionRepository({
			driver: migrated.connection,
			schema,
			keys,
			sealing: "required",
		});
		const userId = await createUser(migrated.connection, schema);
		await migrating.issue({ userId, factors: ["password"], observed: NO_REQUEST });

		expect(await required.listSessionsOfUser({ userId })).toStrictEqual([]);
		expect(
			await required.listEverySessionIdOwnedBy({ actor: actorOfTestUser(userId) }),
		).toStrictEqual([]);
	});
});
