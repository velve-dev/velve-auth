import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KeyProvider } from "../src/core/keys/provider.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { checkSecurityState, readSecurityState } from "../src/core/security-state/read.js";
import { createVelveAuth, type VelveAuth, type VelvePlugin } from "../src/index.js";
import { configFor, createLogSink, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { drawTestPassword } from "./password-fixtures.js";
import { memoryAnchor } from "./security-state-administration-fixtures.js";
import { insertPasskey } from "./security-state-fixtures.js";
import { testKeyProvider } from "./totp-fixtures.js";

//only the administrator reseal seals a broken state, and it signs every session out (T-INTEG-7, S-INTEG-7)

const PASSWORD = drawTestPassword();
const keys: KeyProvider = testKeyProvider();
const LARGEST_VERSION = Number.MAX_SAFE_INTEGER;

let connection: TestConnection;
let schema: string;
let alarms: SecurityStateAlarm[] = [];
const log = createLogSink();

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("integ_reseal"));
}, 60_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function mount(plugins: readonly VelvePlugin[] = []): VelveAuth<"email"> {
	return createVelveAuth(
		configFor({
			database: connection,
			schema,
			keys,
			log: log.write,
			plugins,
			securityState: { sealing: "required", alarm: (alarm) => alarms.push(alarm) },
			rateLimit: {
				perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
				perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
			},
		}),
	);
}

interface Account {
	readonly userId: string;
	readonly email: string;
	readonly sessionToken: string;
}

async function signedUp(auth: VelveAuth<"email">): Promise<Account> {
	const email = `${randomBytes(6).toString("hex")}@example.com`;
	const result = await auth.signUp.withPassword({ email, password: PASSWORD, origin: TEST_ORIGIN });
	return { userId: result.user.id, email, sessionToken: result.sessionToken };
}

async function signedIn(auth: VelveAuth<"email">, account: Account): Promise<string> {
	const result = await auth.signIn.password({
		email: account.email,
		password: PASSWORD,
		origin: TEST_ORIGIN,
	});
	if (result.status !== "signed_in") {
		throw new Error(`the sign-in answered ${result.status}`);
	}
	return result.sessionToken;
}

async function verdictOf(userId: string): Promise<string> {
	const read = await readSecurityState(connection, schema, userId);
	if (read === null) {
		throw new Error("the account is gone");
	}
	return (await checkSecurityState(keys, read, "required")).verdict;
}

async function sealOf(userId: string): Promise<{ version: number; epoch: number } | null> {
	const [row] = await connection.query<{ version: string; epoch: string }>(
		`SELECT version::text AS version, session_epoch::text AS epoch FROM ${schema}.security_state WHERE user_id = $1`,
		[userId],
	);
	return row === undefined ? null : { version: Number(row.version), epoch: Number(row.epoch) };
}

async function saveSessionRow(sessionToken: string, auth: VelveAuth<"email">): Promise<string> {
	const resolved = await auth.session.resolve({ origin: TEST_ORIGIN, sessionToken });
	const saved = `saved_${randomBytes(4).toString("hex")}`;
	await connection.query(
		`CREATE TABLE ${schema}.${saved} AS SELECT * FROM ${schema}.session WHERE user_id = $1`,
		[resolved?.user.id],
	);
	return saved;
}

async function restoreSessionRows(saved: string): Promise<void> {
	await connection.query(
		`INSERT INTO ${schema}.session SELECT * FROM ${schema}.${saved} ON CONFLICT DO NOTHING`,
		[],
	);
}

async function delivered(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("T-INTEG-7: the administrator reseal", () => {
	it("is the only thing that seals a broken state, names what it ratified and signs every session out", async () => {
		alarms = [];
		const auth = mount();
		const account = await signedUp(auth);
		const earlyEpoch = (await sealOf(account.userId))?.epoch ?? 0;
		const savedEarly = await saveSessionRow(account.sessionToken, auth);
		await auth.session.revokeAll({ origin: TEST_ORIGIN, sessionToken: account.sessionToken });
		const current = await signedIn(auth, account);
		await insertPasskey(connection, schema, account.userId);

		const stillBroken: string[] = [];
		for (let attempt = 0; attempt < 10; attempt += 1) {
			await expect(
				auth.signIn.password({ email: account.email, password: PASSWORD, origin: TEST_ORIGIN }),
			).rejects.toMatchObject({ code: "invalid_credentials" });
			stillBroken.push(await verdictOf(account.userId));
		}
		await expect(
			auth.user.disable({ userId: account.userId, reason: "a legitimate change" }),
		).rejects.toBeDefined();
		stillBroken.push(await verdictOf(account.userId));
		const run = await auth.maintenance.sealSecurityState();
		stillBroken.push(await verdictOf(account.userId));
		await delivered();

		expect(stillBroken).toStrictEqual(Array(12).fill("seal_mismatch"));
		expect(run).toMatchObject({ refused: 1, sealed: 0, rekeyed: 0 });
		expect(alarms.filter((alarm) => alarm.occasion === "change")).toHaveLength(1);

		const withoutReason = auth.maintenance.resealSecurityState({
			userId: account.userId,
		} as unknown as { userId: string; reason: string });
		const withEmptyReason = auth.maintenance.resealSecurityState({
			userId: account.userId,
			reason: " ",
		});
		await expect(withoutReason).rejects.toMatchObject({ code: "security_state_reason_missing" });
		await expect(withEmptyReason).rejects.toMatchObject({ code: "security_state_reason_missing" });

		const before = await sealOf(account.userId);
		await connection.query(
			`UPDATE ${schema}.security_state SET session_epoch = $2 WHERE user_id = $1`,
			[account.userId, earlyEpoch],
		);
		await restoreSessionRows(savedEarly);
		const [stored] = await connection.query<{ disabled: boolean; set_by: string | null }>(
			`SELECT u.disabled_at IS NOT NULL AS disabled, p.set_by_session_id::text AS set_by
			 FROM ${schema}.user u JOIN ${schema}.password_credential p ON p.user_id = u.id WHERE u.id = $1`,
			[account.userId],
		);
		const [inserted] = await connection.query<{ credential_id: string }>(
			`SELECT encode(credential_id, 'base64') AS credential_id FROM ${schema}.webauthn_credential WHERE user_id = $1`,
			[account.userId],
		);

		const ratified = await auth.maintenance.resealSecurityState({
			userId: account.userId,
			reason: "incident 42: passkey inserted by a compromised tool",
		});

		const insertedBase64Url = (inserted?.credential_id ?? "")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		expect(ratified.passkeyCredentialIds).toStrictEqual([insertedBase64Url]);
		expect({
			disabled: ratified.disabled,
			passwordSetBySession: ratified.passwordSetBySession,
		}).toStrictEqual({ disabled: stored?.disabled, passwordSetBySession: stored?.set_by ?? null });
		expect(ratified).toMatchObject({
			email: account.email,
			emailVerified: false,
			password: true,
			passwordResetRequired: false,
			totp: "none",
			identities: [],
			recoveryCodeCount: 0,
		});
		const after = await sealOf(account.userId);
		expect(after?.version).toBe(ratified.version);
		expect(ratified.version).toBeGreaterThan(before?.version ?? 0);
		expect(after?.epoch).toBe(ratified.sessionEpoch);
		expect(after?.epoch).not.toBe(earlyEpoch);
		expect(after?.epoch).not.toBe(before?.epoch);
		const replayed = await connection.query<{ token_sha256: Uint8Array }>(
			`SELECT token_sha256 FROM ${schema}.${savedEarly}`,
			[],
		);
		expect(replayed).toHaveLength(1);
		expect(
			await auth.session.resolve({ origin: TEST_ORIGIN, sessionToken: account.sessionToken }),
			"the session row replayed from the lowered epoch",
		).toBeNull();
		expect(await auth.session.resolve({ origin: TEST_ORIGIN, sessionToken: current })).toBeNull();
		//the ratified passkey is a second factor, so the sign-in that is no longer refused asks for it
		const signIn = await auth.signIn.password({
			email: account.email,
			password: PASSWORD,
			origin: TEST_ORIGIN,
		});
		expect(signIn.status).toBe("second_factor_required");
		expect(log.lines).toContainEqual({
			level: "warn",
			message: "an administrator resealed an account's security state",
			fields: {
				userId: account.userId,
				reason: "incident 42: passkey inserted by a compromised tool",
				version: ratified.version,
			},
		});
	});

	it("refuses at the largest version without changing a row", async () => {
		alarms = [];
		const auth = mount();
		const account = await signedUp(auth);
		await connection.query(`UPDATE ${schema}.security_state SET version = $2 WHERE user_id = $1`, [
			account.userId,
			LARGEST_VERSION,
		]);
		const snapshot = async () =>
			connection.query(`SELECT xmin::text, * FROM ${schema}.security_state WHERE user_id = $1`, [
				account.userId,
			]);
		const before = await snapshot();

		await expect(
			auth.maintenance.resealSecurityState({ userId: account.userId, reason: "recover" }),
		).rejects.toMatchObject({ code: "security_state_version_exhausted" });
		expect(await snapshot()).toStrictEqual(before);
	});

	for (const withAnchor of [false, true]) {
		it(`refuses a saved session after a lowered version and epoch are resealed ${withAnchor ? "with" : "without"} an anchor`, async () => {
			alarms = [];
			const anchor = memoryAnchor();
			const auth = mount(withAnchor ? [{ id: "anchor", securityStateAnchor: anchor.anchor }] : []);
			const account = await signedUp(auth);
			const saved = await saveSessionRow(account.sessionToken, auth);
			const early = await sealOf(account.userId);
			await auth.session.revokeAll({ origin: TEST_ORIGIN, sessionToken: account.sessionToken });
			await connection.query(
				`UPDATE ${schema}.security_state SET version = $2, session_epoch = $3 WHERE user_id = $1`,
				[account.userId, early?.version, early?.epoch],
			);
			await restoreSessionRows(saved);
			const floor = Math.max(0, ...anchor.recorded.map((event) => event.version));

			const ratified = await auth.maintenance.resealSecurityState({
				userId: account.userId,
				reason: "rollback found",
			});

			expect(ratified.sessionEpoch).not.toBe(early?.epoch);
			expect(
				await auth.session.resolve({ origin: TEST_ORIGIN, sessionToken: account.sessionToken }),
			).toBeNull();
			if (withAnchor) {
				expect(floor).toBeGreaterThan(early?.version ?? 0);
				expect(ratified.version).toBe(floor + 1);
				expect(anchor.recorded.at(-1)).toMatchObject({
					userId: account.userId,
					version: floor + 1,
				});
			}
		});
	}
});
