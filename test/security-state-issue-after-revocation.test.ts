import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import { createTestClock, type TestClock } from "../src/testing/index.js";
import { type MountedAuth, mountAuth } from "./auth-fixtures.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { postTo } from "./flows-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

//a mass revocation must leave no session that the state it replaced authorised (E-3377)

let mounted: MountedAuth;
let clock: TestClock;

const OLD_PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "a-new-password-after-the-incident";

beforeAll(async () => {
	clock = createTestClock();
	mounted = await mountAuth("issue_after_revocation", {
		clock,
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
	});
});

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

function cookieIn(answer: Response, name: string): string | null {
	for (const header of answer.headers.getSetCookie()) {
		const pair = header.split(";")[0] ?? "";
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === name) {
			const value = pair.slice(separator + 1);
			return value === "" ? null : value;
		}
	}
	return null;
}

function withSession(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.session}=${token}` };
}

function withPending(token: string): Record<string, string> {
	return { Cookie: `${DEFAULT_COOKIE_NAMES.pending}=${token}` };
}

function codeNow(secretBase32: string): string {
	return totpCodeForStep(secretBytesOfBase32(secretBase32), timeStepAt(clock.now()));
}

let accounts = 0;

async function victimWithTotp(): Promise<{ email: string; session: string; secret: string }> {
	accounts += 1;
	const email = `victim${accounts}@example.com`;
	const signedUp = await mounted.handler(postTo("/sign-up", { email, password: OLD_PASSWORD }));
	const session = cookieIn(signedUp, DEFAULT_COOKIE_NAMES.session);
	if (session === null) {
		throw new Error("no session from sign-up");
	}
	const started = await mounted.handler(
		postTo("/factor/totp/enroll/start", {}, withSession(session)),
	);
	const { secretBase32 } = (await started.json()) as { secretBase32: string };
	const finished = await mounted.handler(
		postTo("/factor/totp/enroll/finish", { code: codeNow(secretBase32) }, withSession(session)),
	);
	expect(finished.status).toBe(204);
	clock.advanceBy(60_000);
	return { email, session, secret: secretBase32 };
}

async function pendingWithOldPassword(email: string): Promise<string> {
	const answer = await mounted.handler(
		postTo("/sign-in/password", { email, password: OLD_PASSWORD }),
	);
	const pending = cookieIn(answer, DEFAULT_COOKIE_NAMES.pending);
	if (pending === null) {
		throw new Error(`no pending authentication, status ${answer.status}`);
	}
	return pending;
}

async function completeWithTotp(pending: string, secret: string): Promise<string | null> {
	const verified = await mounted.handler(
		postTo("/factor/totp/verify", { code: codeNow(secret) }, withPending(pending)),
	);
	return cookieIn(verified, DEFAULT_COOKIE_NAMES.session);
}

async function resolves(session: string): Promise<boolean> {
	const answer = await mounted.handler(
		new Request("https://api.example.com/session", {
			method: "GET",
			headers: { Origin: "https://app.example.com", ...withSession(session) },
		}),
	);
	return answer.status === 200 && (await answer.json()) !== null;
}

async function completedAfter(revocation: "password_change" | "revoke_all"): Promise<{
	readonly issued: boolean;
	readonly resolves: boolean;
}> {
	const victim = await victimWithTotp();
	const pending = await pendingWithOldPassword(victim.email);
	const revoked =
		revocation === "password_change"
			? await mounted.handler(
					postTo(
						"/password/change",
						{ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
						withSession(victim.session),
					),
				)
			: await mounted.handler(postTo("/session/revoke-all", {}, withSession(victim.session)));
	expect(revoked.status).toBe(200);
	const attacker = await completeWithTotp(pending, victim.secret);
	return {
		issued: attacker !== null,
		resolves: attacker === null ? false : await resolves(attacker),
	};
}

describe("a pending authentication from before a mass revocation (S-FIX-6, section 3.18 point 3)", () => {
	it("yields no session after the password it was authorised by has been changed", async () => {
		expect(await completedAfter("password_change")).toStrictEqual({
			issued: false,
			resolves: false,
		});
	});

	it("yields no session after the user signed out everywhere", async () => {
		expect(await completedAfter("revoke_all")).toStrictEqual({ issued: false, resolves: false });
	});

	it("control: without a revocation the completion issues a session that resolves", async () => {
		const victim = await victimWithTotp();
		const pending = await pendingWithOldPassword(victim.email);
		const issued = await completeWithTotp(pending, victim.secret);

		expect(issued === null ? false : await resolves(issued)).toBe(true);
	});
});

describe("premise: the issue point 3 prescribed until now, after a check that preceded a password change", () => {
	let revoker: TestConnection;
	let signer: TestConnection;
	let schema: string;

	beforeAll(async () => {
		const migrated = await openMigratedSchema("issue_premise");
		revoker = migrated.connection;
		schema = migrated.schema;
		signer = await openTestConnection();
	});

	afterAll(async () => {
		await dropSchema(revoker, schema);
		await revoker.close();
		await signer.close();
	});

	it("inserts a session whose credential was checked against the replaced state, bound to the new epoch", async () => {
		const userId = await createUser(revoker, schema);
		await revoker.query(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version, session_epoch)
			 VALUES ($1, 1, decode(repeat('00', 32), 'hex'), 1, 1)`,
			[userId],
		);

		//the sign-in's one checked statement, after which the kdf runs outside any transaction
		const [checked] = await signer.query<{ version: string; epoch: string }>(
			`SELECT version::text AS version, session_epoch::text AS epoch
			 FROM ${schema}.security_state WHERE user_id = $1`,
			[userId],
		);
		expect(checked).toStrictEqual({ version: "1", epoch: "1" });

		//password.change commits while the kdf runs
		await revoker.query("BEGIN", []);
		await revoker.query(lockAccountRowStatement(schema), [userId]);
		await revoker.query(
			`UPDATE ${schema}.security_state SET version = 2, session_epoch = 777 WHERE user_id = $1`,
			[userId],
		);
		await revoker.query(`DELETE FROM ${schema}.session WHERE user_id = $1`, [userId]);
		await revoker.query("COMMIT", []);

		//the issue as point 3 prescribes it, the lock first and then the epoch read under it
		await signer.query("BEGIN", []);
		await signer.query(lockAccountRowStatement(schema), [userId]);
		const [underLock] = await signer.query<{ epoch: string }>(
			`SELECT session_epoch::text AS epoch FROM ${schema}.security_state WHERE user_id = $1`,
			[userId],
		);
		const inserted = await signer.query(
			`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at,
				token_mac, token_mac_key_version)
			 SELECT s.user_id, decode(md5(random()::text) || md5(random()::text), 'hex'),
				now() + interval '1 hour', now() + interval '1 day',
				decode(md5(random()::text) || md5(random()::text), 'hex'), 1
			 FROM ${schema}.security_state s WHERE s.user_id = $1 AND s.session_epoch = $2
			 RETURNING id`,
			[userId, Number(underLock?.epoch)],
		);
		await signer.query("COMMIT", []);

		const [current] = await signer.query<{ epoch: string }>(
			`SELECT session_epoch::text AS epoch FROM ${schema}.security_state WHERE user_id = $1`,
			[userId],
		);
		//the session binds the epoch it was inserted under, which is the current one, so it resolves
		expect({
			sessionsAfterTheChange: inserted.length,
			boundEpochIsCurrent: underLock?.epoch === current?.epoch,
		}).toStrictEqual({ sessionsAfterTheChange: 1, boundEpochIsCurrent: true });
	});

	it("control: an issue conditional on the version and epoch the check read inserts nothing", async () => {
		const userId = await createUser(revoker, schema);
		await revoker.query(
			`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version, session_epoch)
			 VALUES ($1, 2, decode(repeat('00', 32), 'hex'), 1, 777)`,
			[userId],
		);
		await signer.query("BEGIN", []);
		await signer.query(lockAccountRowStatement(schema), [userId]);
		const inserted = await signer.query(
			`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at,
				token_mac, token_mac_key_version)
			 SELECT s.user_id, decode(md5(random()::text) || md5(random()::text), 'hex'),
				now() + interval '1 hour', now() + interval '1 day',
				decode(md5(random()::text) || md5(random()::text), 'hex'), 1
			 FROM ${schema}.security_state s WHERE s.user_id = $1 AND s.session_epoch = $2 AND s.version = $3
			 RETURNING id`,
			[userId, 1, 1],
		);
		await signer.query("COMMIT", []);
		expect(inserted.length).toBe(0);
	});
});

describe("section 3.18 point 3 in the binding German specification", () => {
	const german = readFileSync(new URL("../VELVE-AUTH-ARCHITEKTUR.md", import.meta.url), "utf8");

	it("inserts a session only under the version and the epoch the authorising check read", () => {
		expect(german).toContain(
			"`INSERT … SELECT … FROM security_state WHERE user_id = $1 AND session_epoch = $2 AND version = $3`, mit Epoche und Version der erlaubenden Prüfung",
		);
	});

	it("stores and binds the epoch of the check that creates a pending authentication", () => {
		expect(german).toContain(
			"Ein Zwischenzustand speichert in `pending_authentication.session_epoch`",
		);
	});
});
