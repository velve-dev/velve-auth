import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import {
	createSessionService,
	type IssuedSession,
	type SessionService,
} from "../src/core/session/service.js";
import {
	actorOfTestUser,
	createUser,
	dropSchema,
	type MigratedSchema,
	openMigratedSchema,
} from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { aFreshEpochOtherThan } from "./session-fixtures.js";
import { testKeyRing } from "./totp-fixtures.js";

// Section 3.18 point 3: issuing a session takes the account lock before it reads the epoch, on
// every path that inserts a session row, not only on the plain issue. A holder of the lock raises
// the epoch; each path must wait for the holder and bind the epoch it leaves (E-3141).

const NO_REQUEST = { ipAddress: null, userAgent: null };
const HOLD_MS = 400;

let migrated: MigratedSchema;
let schema: string;
let holder: TestConnection;
let sessions: SessionService;

beforeAll(async () => {
	migrated = await openMigratedSchema("review_issue_paths");
	schema = migrated.schema;
	holder = await openTestConnection();
	sessions = createSessionService({
		sealing: "migrating",
		driver: migrated.connection,
		keys: testKeyRing(1).providerAt(1),
		schema,
	});
});

afterAll(async () => {
	await holder.close();
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

async function sealedAccount(): Promise<string> {
	const userId = await createUser(migrated.connection, schema);
	await migrated.connection.query(
		`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
		 VALUES ($1, 1, $2, 1)`,
		[userId, randomBytes(32)],
	);
	return userId;
}

//the first session of a two-step path is issued before the lock is held, so only the step under test waits
type Path = (userId: string) => Promise<() => Promise<IssuedSession>>;

const PATHS: readonly [string, Path][] = [
	[
		"issue",
		async (userId) => () =>
			sessions.issue({
				authorisedBy: "read_under_lock",
				userId,
				factors: ["password"],
				observed: NO_REQUEST,
			}),
	],
	[
		"issueReplacingPresented",
		async (userId) => () =>
			sessions.issueReplacingPresented({
				authorisedBy: "read_under_lock",
				completes: "password_sign_in",
				presentedToken: null,
				userId,
				factors: ["password"],
				observed: NO_REQUEST,
			}),
	],
	[
		"reissue",
		async (userId) => {
			const first = await sessions.issue({
				authorisedBy: "read_under_lock",
				userId,
				factors: ["password"],
				observed: NO_REQUEST,
			});
			return () =>
				sessions.reissue({
					authorisedBy: "read_under_lock",
					completes: "totp_second_factor",
					previousToken: first.token,
					userId,
					factors: ["password"],
					observed: NO_REQUEST,
				});
		},
	],
	[
		"reissueAfterCredentialChange",
		async (userId) => {
			const first = await sessions.issue({
				authorisedBy: "read_under_lock",
				userId,
				factors: ["password"],
				observed: NO_REQUEST,
			});
			const resolved = await sessions.resolve(first.token);
			if (resolved === null) {
				throw new Error("the first session did not resolve");
			}
			return () =>
				sessions.reissueAfterCredentialChange({
					authorisedBy: "read_under_lock",
					completes: "password_change",
					resolved,
					factors: ["password"],
					observed: NO_REQUEST,
				});
		},
	],
	[
		"reissueSessionOfUser",
		async (userId) => {
			const first = await sessions.issue({
				authorisedBy: "read_under_lock",
				userId,
				factors: ["password"],
				observed: NO_REQUEST,
			});
			return () =>
				sessions.reissueSessionOfUser({
					authorisedBy: "read_under_lock",
					completes: "oauth_link",
					actor: actorOfTestUser(userId),
					previousSessionId: first.session.id,
					factors: ["password"],
					observed: NO_REQUEST,
				});
		},
	],
];

describe("every path that inserts a session waits for the account lock and binds the epoch it leaves", () => {
	it.each(PATHS)("%s", async (_name, path) => {
		const userId = await sealedAccount();
		const run = await path(userId);
		await holder.query("BEGIN", []);
		await holder.query(lockAccountRowStatement(schema), [userId]);
		await holder.query(
			`UPDATE ${schema}.security_state SET session_epoch = $2 WHERE user_id = $1`,
			[userId, aFreshEpochOtherThan(1)],
		);

		const running = run();
		const finishedBeforeCommit = await Promise.race([
			running.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), HOLD_MS)),
		]);
		await holder.query("COMMIT", []);
		const issued = await running;

		expect(finishedBeforeCommit).toBe(false);
		expect((await sessions.resolve(issued.token))?.userId).toBe(userId);
	});
});
