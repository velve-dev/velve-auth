import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionRepository } from "../src/core/db/repositories/session.js";
import { createPendingAuthenticationService } from "../src/core/factor/pending/index.js";
import { createSessionService } from "../src/core/session/service.js";
import type { TokenBindingRefusal } from "../src/core/token/binding.js";
import { mountAuth, requestTo, testKeyProvider } from "./auth-fixtures.js";
import {
	actorOfTestUser,
	createUser,
	dropSchema,
	type MigratedSchema,
	openMigratedSchema,
} from "./db-fixtures.js";

//a column a writer moved outside what the library writes leaves a refused row and never an exception (S-INTEG-9)

const OBSERVED = { ipAddress: null, userAgent: null };
const keys = testKeyProvider();
let migrated: MigratedSchema;
let schema: string;
let refusals: TokenBindingRefusal[];

beforeAll(async () => {
	migrated = await openMigratedSchema("integ_token_tampered");
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

function reporting() {
	refusals = [];
	return {
		sealing: "migrating" as const,
		driver: migrated.connection,
		keys,
		schema,
		reportTokenBindingRefusal: (refusal: TokenBindingRefusal) => refusals.push(refusal),
	};
}

async function twoSessionsWithOneMoved(column: string, moved: string): Promise<string> {
	const userId = await createUser(migrated.connection, schema);
	const sessions = createSessionService(reporting());
	await sessions.issue({
		authorisedBy: "unsealed",
		userId,
		factors: ["password"],
		observed: OBSERVED,
	});
	await sessions.issue({
		authorisedBy: "unsealed",
		userId,
		factors: ["password"],
		observed: OBSERVED,
	});
	await migrated.connection.query(
		`UPDATE ${schema}.session SET ${column} = $2::timestamptz
		 WHERE id = (SELECT id FROM ${schema}.session WHERE user_id = $1 ORDER BY id LIMIT 1)`,
		[userId, moved],
	);
	return userId;
}

describe.each([
	["created_at", "9999-12-31 00:00:00+00"],
	["created_at", "294000-01-01 00:00:00+00"],
	["created_at", "infinity"],
	["created_at", "-infinity"],
	["idle_expires_at", "infinity"],
	["absolute_expires_at", "infinity"],
	["last_used_at", "-infinity"],
])("a session whose %s a writer moved to %s", (column, moved) => {
	it("resolves as no session, with one report", async () => {
		const userId = await createUser(migrated.connection, schema);
		const sessions = createSessionService(reporting());
		const { token } = await sessions.issue({
			authorisedBy: "unsealed",
			userId,
			factors: ["password"],
			observed: OBSERVED,
		});
		await migrated.connection.query(
			`UPDATE ${schema}.session SET ${column} = $2::timestamptz WHERE user_id = $1`,
			[userId, moved],
		);

		await expect(sessions.resolve(token)).resolves.toBeNull();
		expect(refusals).toStrictEqual([
			{
				userId,
				occasion: "session_resolve",
				reason: "token_binding_mismatch",
				verdict: "mismatch",
			},
		]);
	});

	it("is left out of the owner's list, which still shows the other session", async () => {
		const userId = await twoSessionsWithOneMoved(column, moved);
		const repository = createSessionRepository(reporting());

		await expect(
			repository.listSessionsOwnedBy({ actor: actorOfTestUser(userId), currentSessionId: "x" }),
		).resolves.toHaveLength(1);
		await expect(repository.listSessionsOfUser({ userId })).resolves.toHaveLength(1);
	});

	it("goes with a revocation of every session, which counts the rows whose MAC holds", async () => {
		const userId = await twoSessionsWithOneMoved(column, moved);
		const repository = createSessionRepository(reporting());
		const counted = await repository.deleteEverySessionOwnedBy({ actor: actorOfTestUser(userId) });
		const [left] = await migrated.connection.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM ${schema}.session WHERE user_id = $1`,
			[userId],
		);

		expect({ counted, left: left?.n }).toStrictEqual({
			counted: column === "created_at" ? 1 : 2,
			left: 0,
		});
	});
});

describe("a pending authentication whose deadline a writer moved to infinity", () => {
	it("resolves as no pending authentication, with one report", async () => {
		const userId = await createUser(migrated.connection, schema);
		const pending = createPendingAuthenticationService(reporting());
		const { token } = await pending.begin({ userId, factorsCompleted: ["password"] });
		await migrated.connection.query(
			`UPDATE ${schema}.pending_authentication SET expires_at = 'infinity' WHERE user_id = $1`,
			[userId],
		);

		await expect(pending.resolve(token)).resolves.toBeNull();
		expect(refusals).toStrictEqual([
			{ userId, occasion: "factor_check", reason: "token_binding_mismatch", verdict: "mismatch" },
		]);
	});
});

describe("a planted row whose creation time lies past what is bound", () => {
	it("does not stop the owner's password change", async () => {
		const mounted = await mountAuth("integtamperedchange", {
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		});
		try {
			const PASSWORD = "correct-horse-battery-staple";
			const signedUp = await mounted.handler(
				requestTo("/sign-up", { body: { email: "planted@example.com", password: PASSWORD } }),
			);
			const userId = ((await signedUp.json()) as { user: { id: string } }).user.id;
			const cookie = /__Host-velve_session=[^;]*/.exec(
				signedUp.headers.get("Set-Cookie") ?? "",
			)?.[0];
			await mounted.connection.query(
				`INSERT INTO ${mounted.schema}.session
				   (user_id, token_sha256, idle_expires_at, absolute_expires_at, factors, token_mac,
				    token_mac_key_version, created_at)
				 VALUES ($1, $2, now() + interval '1 day', now() + interval '2 days', '{password}', $3, 1,
				    '9999-12-31 00:00:00+00')`,
				[userId, createHash("sha256").update(randomBytes(8)).digest(), randomBytes(32)],
			);

			const answer = await mounted.handler(
				requestTo("/password/change", {
					body: { currentPassword: PASSWORD, newPassword: "a-different-password-entirely" },
					...(cookie === undefined ? {} : { cookie }),
				}),
			);

			expect(answer.status).toBe(200);
		} finally {
			await dropSchema(mounted.connection, mounted.schema);
			await mounted.connection.close();
		}
	});
});
