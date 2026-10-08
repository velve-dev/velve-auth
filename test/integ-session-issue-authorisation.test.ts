import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toVisibleFailure } from "../src/core/http/error-map.js";
import { createSessionService } from "../src/core/session/service.js";
import type { TokenBindingRefusal } from "../src/core/token/binding.js";
import { testKeyProvider } from "./auth-fixtures.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { aFreshEpochOtherThan } from "./session-fixtures.js";

//a session issue inserts only while the seal row holds the version and epoch its authorising check read (E-3485)

const NO_REQUEST = { ipAddress: null, userAgent: null };
let migrated: MigratedSchema;
let schema: string;
let refusals: TokenBindingRefusal[];

beforeAll(async () => {
	migrated = await openMigratedSchema("integ_issue_authorisation");
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

async function sealedAt(version: number): Promise<{ userId: string; epoch: number }> {
	const userId = await createUser(migrated.connection, schema);
	const epoch = aFreshEpochOtherThan(1);
	await migrated.connection.query(
		`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version, session_epoch)
		 VALUES ($1, $2, $3, 1, $4)`,
		[userId, version, randomBytes(32), epoch],
	);
	return { userId, epoch };
}

function sessionsWith(sealVerifies?: boolean) {
	refusals = [];
	return createSessionService({
		sealing: "migrating",
		driver: migrated.connection,
		keys: testKeyProvider(),
		schema,
		reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
		...(sealVerifies === undefined
			? {}
			: { sealVerifiesAfterMissedIssue: async () => sealVerifies }),
	});
}

async function outcomeOf(work: () => Promise<unknown>): Promise<string> {
	return work().then(
		() => "issued",
		(failure: unknown) => toVisibleFailure(failure).error.code,
	);
}

async function sessionsOf(userId: string): Promise<number> {
	const [row] = await migrated.connection.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM ${schema}.session WHERE user_id = $1`,
		[userId],
	);
	return row?.n ?? -1;
}

describe("an issue authorised by a check of the seal row", () => {
	it("inserts while the row holds the version and epoch the check read", async () => {
		const { userId, epoch } = await sealedAt(4);
		const sessions = sessionsWith();

		const outcome = await outcomeOf(() =>
			sessions.issueReplacingPresented({
				completes: "password_sign_in",
				authorisedBy: { version: 4, sessionEpoch: epoch },
				presentedToken: null,
				userId,
				factors: ["password"],
				observed: NO_REQUEST,
			}),
		);

		expect({ outcome, sessions: await sessionsOf(userId), refusals }).toStrictEqual({
			outcome: "issued",
			sessions: 1,
			refusals: [],
		});
	});

	it("inserts nothing after a reseal raised the version, and alarms where nothing verifies the seal", async () => {
		const { userId, epoch } = await sealedAt(5);
		const sessions = sessionsWith();

		const outcome = await outcomeOf(() =>
			sessions.issueReplacingPresented({
				completes: "password_sign_in",
				authorisedBy: { version: 4, sessionEpoch: epoch },
				presentedToken: null,
				userId,
				factors: ["password"],
				observed: NO_REQUEST,
			}),
		);

		expect({ outcome, sessions: await sessionsOf(userId), refusals }).toStrictEqual({
			outcome: "invalid_credentials",
			sessions: 0,
			refusals: [{ userId, occasion: "sign_in", reason: "seal_mismatch", verdict: "mismatch" }],
		});
	});

	it("answers the same without an alarm where the seal verifies under the lock", async () => {
		const { userId, epoch } = await sealedAt(5);
		const sessions = sessionsWith(true);

		const outcome = await outcomeOf(() =>
			sessions.issueReplacingPresented({
				completes: "password_sign_in",
				authorisedBy: { version: 4, sessionEpoch: epoch },
				presentedToken: null,
				userId,
				factors: ["password"],
				observed: NO_REQUEST,
			}),
		);

		expect({ outcome, sessions: await sessionsOf(userId), refusals }).toStrictEqual({
			outcome: "invalid_credentials",
			sessions: 0,
			refusals: [],
		});
	});

	it("inserts nothing for a completion whose pending epoch a revocation replaced", async () => {
		const { userId, epoch } = await sealedAt(2);
		const sessions = sessionsWith(false);

		const outcome = await outcomeOf(() =>
			sessions.issueReplacingPresented({
				completes: "totp_second_factor",
				authorisedBy: { version: 2, sessionEpoch: aFreshEpochOtherThan(epoch) },
				presentedToken: null,
				userId,
				factors: ["password", "totp"],
				observed: NO_REQUEST,
			}),
		);

		expect({ outcome, sessions: await sessionsOf(userId) }).toStrictEqual({
			outcome: "invalid_factor_code",
			sessions: 0,
		});
	});

	it("inserts nothing where the check read no seal row and one exists now", async () => {
		const { userId } = await sealedAt(1);
		const sessions = sessionsWith();

		const outcome = await outcomeOf(() =>
			sessions.issueReplacingPresented({
				completes: "magic_link",
				authorisedBy: "unsealed",
				presentedToken: null,
				userId,
				factors: [],
				observed: NO_REQUEST,
			}),
		);

		expect({
			outcome,
			sessions: await sessionsOf(userId),
			refusals: refusals.length,
		}).toStrictEqual({
			outcome: "invalid_token",
			sessions: 0,
			refusals: 1,
		});
	});

	it("issues for an unsealed account whose check read no seal row, in migrating", async () => {
		const userId = await createUser(migrated.connection, schema);

		const outcome = await outcomeOf(() =>
			sessionsWith().issueReplacingPresented({
				completes: "totp_second_factor",
				authorisedBy: "unsealed",
				presentedToken: null,
				userId,
				factors: ["password", "totp"],
				observed: NO_REQUEST,
			}),
		);

		expect(outcome).toBe("issued");
	});
});
