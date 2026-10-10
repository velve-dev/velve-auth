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

// Section 3.18 point 3: issuing a session takes the account lock before it inserts, on every path
// that inserts a session row, not only on the plain issue. A holder of the lock raises the epoch;
// each path waits for the holder and, as its check read the epoch the holder replaced, ends
// without a session (E-3141, E-3377, E-3403).

const NO_REQUEST = { ipAddress: null, userAgent: null };
const CHECKED = { version: 1, sessionEpoch: 1 } as const;
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
				authorisedBy: CHECKED,
				userId,
				factors: ["password"],
				observed: NO_REQUEST,
			}),
	],
	[
		"issueReplacingPresented",
		async (userId) => () =>
			sessions.issueReplacingPresented({
				authorisedBy: CHECKED,
				completes: "password_sign_in",
				presentedToken: null,
				userId,
				factors: ["password"],
				observed: NO_REQUEST,
			}),
	],
	[
		"reissueSessionOfUser",
		async (userId) => {
			const first = await sessions.issue({
				authorisedBy: CHECKED,
				userId,
				factors: ["password"],
				observed: NO_REQUEST,
			});
			return () =>
				sessions.reissueSessionOfUser({
					authorisedBy: CHECKED,
					completes: "oauth_link",
					actor: actorOfTestUser(userId),
					previousSessionId: first.session.id,
					factors: ["password"],
					observed: NO_REQUEST,
				});
		},
	],
];

describe("every path that inserts a session waits for the account lock and inserts nothing under the epoch it leaves", () => {
	it.each(PATHS)("%s", async (_name, path) => {
		const userId = await sealedAccount();
		const run = await path(userId);
		await holder.query("BEGIN", []);
		await holder.query(lockAccountRowStatement(schema), [userId]);
		await holder.query(
			`UPDATE ${schema}.security_state SET session_epoch = $2 WHERE user_id = $1`,
			[userId, aFreshEpochOtherThan(1)],
		);

		const running = run().then(
			() => "issued",
			() => "refused",
		);
		const finishedBeforeCommit = await Promise.race([
			running.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), HOLD_MS)),
		]);
		await holder.query("COMMIT", []);

		expect(finishedBeforeCommit).toBe(false);
		expect(await running).toBe("refused");
	});
});
