import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeBase64Url } from "../src/core/keys/base64url.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import type { SecurityStateAlarm } from "../src/core/security-state/alarm.js";
import { createVelveAuth, type VelveAuth, type VelvePlugin } from "../src/index.js";
import { configFor, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { drawTestPassword } from "./password-fixtures.js";
import { type MemoryAnchor, memoryAnchor } from "./security-state-administration-fixtures.js";
import { testKeyProvider } from "./totp-fixtures.js";

//a played-back state is caught only with an anchor, and the anchor learns only verified seals (T-INTEG-6, S-INTEG-6)

const PASSWORD = drawTestPassword();
const keys: KeyProvider = testKeyProvider();

let connection: TestConnection;
let schema: string;
let alarms: SecurityStateAlarm[] = [];

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("integ_anchor_rollback"));
}, 60_000);

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function mount(anchor: MemoryAnchor | null): VelveAuth<"email"> {
	const plugins: VelvePlugin[] =
		anchor === null ? [] : [{ id: "anchor", securityStateAnchor: anchor.anchor }];
	return createVelveAuth(
		configFor({
			database: connection,
			schema,
			keys,
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

interface SavedState {
	readonly recoveryCodes: string;
	readonly seal: string;
}

//a writer saves every row a change touches together with the seal row (T-INTEG-6)
async function saveState(userId: string): Promise<SavedState> {
	const suffix = randomBytes(4).toString("hex");
	const saved = { recoveryCodes: `saved_codes_${suffix}`, seal: `saved_seal_${suffix}` };
	await connection.query(
		`CREATE TABLE ${schema}.${saved.recoveryCodes} AS SELECT * FROM ${schema}.recovery_code WHERE user_id = $1`,
		[userId],
	);
	await connection.query(
		`CREATE TABLE ${schema}.${saved.seal} AS SELECT * FROM ${schema}.security_state WHERE user_id = $1`,
		[userId],
	);
	return saved;
}

async function playBack(userId: string, saved: SavedState): Promise<void> {
	await connection.query(`DELETE FROM ${schema}.recovery_code WHERE user_id = $1`, [userId]);
	await connection.query(
		`INSERT INTO ${schema}.recovery_code SELECT * FROM ${schema}.${saved.recoveryCodes}`,
		[],
	);
	await connection.query(`DELETE FROM ${schema}.security_state WHERE user_id = $1`, [userId]);
	await connection.query(
		`INSERT INTO ${schema}.security_state SELECT * FROM ${schema}.${saved.seal}`,
		[],
	);
}

async function delivered(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 20));
}

async function signInStatus(auth: VelveAuth<"email">, account: Account): Promise<string> {
	try {
		return (
			await auth.signIn.password({ email: account.email, password: PASSWORD, origin: TEST_ORIGIN })
		).status;
	} catch (error) {
		return (error as { code?: string }).code ?? "thrown";
	}
}

function reasonsFor(userId: string): readonly string[] {
	return alarms.filter((alarm) => alarm.userId === userId).map((alarm) => alarm.reason);
}

async function storedSealOf(userId: string): Promise<{ version: number; digest: string }> {
	const [row] = await connection.query<{ version: string; digest: Uint8Array }>(
		`SELECT version::text AS version, digest FROM ${schema}.security_state WHERE user_id = $1`,
		[userId],
	);
	return {
		version: Number(row?.version),
		digest: encodeBase64Url(new Uint8Array(row?.digest ?? [])),
	};
}

describe("T-INTEG-6: a state played back to a saved one", () => {
	it("is accepted without an anchor, which is the named limit", async () => {
		alarms = [];
		const auth = mount(null);
		const account = await signedUp(auth);
		const saved = await saveState(account.userId);
		await auth.factor.recovery.generate({
			origin: TEST_ORIGIN,
			sessionToken: account.sessionToken,
		});
		await playBack(account.userId, saved);

		expect(await signInStatus(auth, account)).toBe("signed_in");
		expect(reasonsFor(account.userId)).toStrictEqual([]);
	});

	it("is refused with version_below_anchor with an anchor", async () => {
		alarms = [];
		const anchor = memoryAnchor();
		const auth = mount(anchor);
		const account = await signedUp(auth);
		await delivered();
		const saved = await saveState(account.userId);
		await auth.factor.recovery.generate({
			origin: TEST_ORIGIN,
			sessionToken: account.sessionToken,
		});
		await delivered();
		await playBack(account.userId, saved);

		expect(await signInStatus(auth, account)).toBe("invalid_credentials");
		await delivered();
		expect(reasonsFor(account.userId)).toStrictEqual(["version_below_anchor"]);
	});

	it("turns a play-back inside the anchor window into a second digest and then anchor_mismatch", async () => {
		alarms = [];
		const anchor = memoryAnchor();
		const auth = mount(anchor);
		const account = await signedUp(auth);
		await delivered();
		const saved = await saveState(account.userId);
		anchor.beforeNextAnswer(account.userId, async () => {
			await auth.factor.recovery.generate({
				origin: TEST_ORIGIN,
				sessionToken: account.sessionToken,
			});
			await delivered();
			await playBack(account.userId, saved);
		});

		await auth.user.disable({ userId: account.userId, reason: "a change inside the window" });
		await delivered();

		expect(anchor.conflicts, "recordSeal reports a second digest for one version").toBe(1);
		expect(await signInStatus(auth, account)).toBe("invalid_credentials");
		await delivered();
		expect(reasonsFor(account.userId)).toStrictEqual(["anchor_mismatch"]);
	});

	it("learns every one of five seals with its version and digest", async () => {
		alarms = [];
		const anchor = memoryAnchor();
		const auth = mount(anchor);
		const account = await signedUp(auth);
		await delivered();
		const learned: boolean[] = [];
		for (let change = 0; change < 5; change += 1) {
			await auth.factor.recovery.generate({
				origin: TEST_ORIGIN,
				sessionToken: account.sessionToken,
			});
			await delivered();
			const stored = await storedSealOf(account.userId);
			learned.push(
				anchor.recorded.some(
					(event) =>
						event.userId === account.userId &&
						event.version === stored.version &&
						event.digest === stored.digest,
				),
			);
		}

		expect(learned).toStrictEqual([true, true, true, true, true]);
	});

	it("never hands the anchor a seal the check did not verify", async () => {
		alarms = [];
		const anchor = memoryAnchor();
		const auth = mount(anchor);
		const account = await signedUp(auth);
		await delivered();
		const raised = 1_000;
		await connection.query(
			`UPDATE ${schema}.security_state SET version = $2, digest = $3 WHERE user_id = $1`,
			[account.userId, raised, randomBytes(32)],
		);

		expect(await signInStatus(auth, account)).toBe("invalid_credentials");
		await delivered();
		expect(anchor.recorded.filter((event) => event.version === raised)).toStrictEqual([]);
		expect(reasonsFor(account.userId)).toStrictEqual(["seal_mismatch"]);
	});
});
