import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { ConcealedError, toVisibleFailure } from "../src/core/http/error-map.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createSessionService, type SessionIssuePath } from "../src/core/session/service.js";
import type { TokenBindingRefusal } from "../src/core/token/binding.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, requestTo, testKeyProvider } from "./auth-fixtures.js";
import {
	actorOfTestUser,
	createUser,
	dropSchema,
	type MigratedSchema,
	openMigratedSchema,
} from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

//a session issue that writes no row answers as the ordinary failure of the path it completes (E-3275)

const PASSWORD = "correct-horse-battery-staple";
let migrated: MigratedSchema;
let writer: TestConnection;
let armedFor: string | null = null;

//the seal row moves past the check that authorised the issue, as a writer or a racing change of a component would move it
async function movingTheSealOf(userId: string): Promise<void> {
	armedFor = null;
	await writer.query(
		`INSERT INTO ${migrated.schema}.security_state (user_id, version, digest, key_version)
		 VALUES ($1, 1, $2, 1)
		 ON CONFLICT (user_id) DO UPDATE SET version = ${migrated.schema}.security_state.version + 1,
		   components_version = ${migrated.schema}.security_state.version + 1, digest = EXCLUDED.digest`,
		[userId, randomBytes(32)],
	);
}

function writingAfterTheEpochRead(inner: Driver): Driver {
	return {
		query: async <T>(sql: string, params: unknown[]) => {
			//a sealed issue reads no epoch of its own and the seal moves at its insert (E-3165)
			if (armedFor !== null && /^\s*INSERT INTO \S+\.session\b/.test(sql)) {
				await movingTheSealOf(armedFor);
			}
			const rows = await inner.query<T>(sql, params);
			if (armedFor !== null && /^\s*SELECT \(SELECT session_epoch::text/.test(sql)) {
				await movingTheSealOf(armedFor);
			}
			return rows;
		},
		transaction: (work) => inner.transaction((tx) => work(writingAfterTheEpochRead(tx))),
	};
}

beforeAll(async () => {
	migrated = await openMigratedSchema("integ_session_issue_miss");
	writer = await openTestConnection();
});

afterAll(async () => {
	await writer.close();
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("a password sign-in whose session issue writes nothing (S-INTEG-9, E-3275)", () => {
	it("answers exactly as a wrong password does", async () => {
		const auth = createVelveAuth(
			configFor({
				database: writingAfterTheEpochRead(migrated.connection),
				schema: migrated.schema,
			}),
		);
		const handler = toWebHandler(auth);
		const signUp = await handler(
			requestTo("/sign-up", { body: { email: "m@example.com", password: PASSWORD } }),
		);
		const userId = ((await signUp.json()) as { user: { id: string } }).user.id;

		const wrong = await handler(
			requestTo("/sign-in/password", {
				body: { email: "m@example.com", password: "not-the-password-at-all" },
			}),
		);
		armedFor = userId;
		const missed = await handler(
			requestTo("/sign-in/password", { body: { email: "m@example.com", password: PASSWORD } }),
		);

		expect({ status: missed.status, body: await missed.json() }).toStrictEqual({
			status: wrong.status,
			body: await wrong.json(),
		});
	});
});

const ORDINARY_FAILURE: readonly [SessionIssuePath, "sign_in" | "change", string][] = [
	["password_sign_in", "sign_in", "invalid_credentials"],
	["passkey_sign_in", "sign_in", "webauthn_credential_rejected"],
	["totp_second_factor", "sign_in", "invalid_factor_code"],
	["passkey_second_factor", "sign_in", "webauthn_credential_rejected"],
	["recovery_second_factor", "sign_in", "invalid_recovery_code"],
	["magic_link", "sign_in", "invalid_token"],
	["oauth_sign_in", "sign_in", "oauth_flow_invalid"],
	["sign_up", "change", "invalid_input"],
	["password_set", "change", "factor_already_enrolled"],
	["password_change", "change", "invalid_credentials"],
	["password_reset", "change", "invalid_token"],
	["oauth_link", "change", "oauth_flow_invalid"],
];

async function failureOf(work: () => Promise<unknown>): Promise<unknown> {
	return work().then(
		() => "no failure",
		(failure: unknown) => failure,
	);
}

describe("every path a session issue completes (S-INTEG-9, E-3275)", () => {
	it.each(ORDINARY_FAILURE)(
		"answers a missed issue completing %s with occasion %s as %s",
		async (completes, occasion, visible) => {
			const userId = await createUser(migrated.connection, migrated.schema);
			const refusals: TokenBindingRefusal[] = [];
			const sessions = createSessionService({
				sealing: "migrating",
				driver: writingAfterTheEpochRead(migrated.connection),
				keys: testKeyProvider(),
				schema: migrated.schema,
				reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
			});
			const first = await sessions.issue({
				authorisedBy: "unsealed",
				userId,
				factors: ["password"],
				observed: { ipAddress: null, userAgent: null },
			});
			armedFor = userId;

			const failure = await failureOf(() =>
				completes === "oauth_link"
					? sessions.reissueSessionOfUser({
							authorisedBy: "unsealed",
							completes,
							actor: actorOfTestUser(userId),
							previousSessionId: first.session.id,
							factors: ["oauth"],
							observed: { ipAddress: null, userAgent: null },
						})
					: sessions.issueReplacingPresented({
							authorisedBy: "unsealed",
							completes,
							presentedToken: null,
							userId,
							factors: ["password"],
							observed: { ipAddress: null, userAgent: null },
						}),
			);

			expect({
				concealed: failure instanceof ConcealedError,
				visible: toVisibleFailure(failure).error.code,
				refusals,
			}).toStrictEqual({
				concealed: true,
				visible,
				refusals: [{ userId, occasion, reason: "seal_mismatch", verdict: "mismatch" }],
			});
		},
	);

	it.each(ORDINARY_FAILURE)(
		'answers an issue completing %s for an account without an epoch in "required" as %s, with no report',
		async (completes, _occasion, visible) => {
			const userId = await createUser(migrated.connection, migrated.schema);
			const refusals: TokenBindingRefusal[] = [];
			const sessions = createSessionService({
				sealing: "required",
				driver: migrated.connection,
				keys: testKeyProvider(),
				schema: migrated.schema,
				reportTokenBindingRefusal: (refusal) => refusals.push(refusal),
			});

			const failure = await failureOf(() =>
				sessions.issueReplacingPresented({
					authorisedBy: "unsealed",
					completes,
					presentedToken: null,
					userId,
					factors: ["password"],
					observed: { ipAddress: null, userAgent: null },
				}),
			);

			expect({ visible: toVisibleFailure(failure).error.code, refusals }).toStrictEqual({
				visible,
				refusals: [],
			});
		},
	);
});
