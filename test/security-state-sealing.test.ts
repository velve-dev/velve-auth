import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { encodeBase64Url } from "../src/core/keys/base64url.js";
import { rootKeyProvider } from "../src/core/keys/index.js";
import type { SecurityStateAlarmRaised } from "../src/core/security-state/alarm.js";
import {
	consultAnchors,
	type SecurityStateAnchorPort,
	type SecurityStateFloor,
	type SecurityStateSealedEvent,
} from "../src/core/security-state/anchor.js";
import {
	checkSecurityState,
	readSecurityState,
	type SealingMode,
	type SecurityStateRead,
	sealedComponentsOf,
} from "../src/core/security-state/read.js";
import {
	drawSessionEpochOtherThan,
	runSealingTransaction,
	type SealingChange,
	SealingRefusedError,
	sealAccount,
	sealCreatedAccount,
	sealUnderAccountLock,
} from "../src/core/security-state/sealing.js";
import { createUser, dropSchema, openMigratedSchema, readUserOwnedTables } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { generateRootKey } from "./keys-fixtures.js";
import { accountLockAudit, HeldDriver } from "./lock-order-fixtures.js";
import { insertPasskey, seedAccount } from "./security-state-fixtures.js";

//the sealing core of T-INTEG-3 against the database, one account per case (E-3156)

let connection: TestConnection;
let writer: TestConnection;
let schema: string;
const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
let raised: SecurityStateAlarmRaised[];
const alarms = { raise: (alarm: SecurityStateAlarmRaised) => raised.push(alarm) };

beforeAll(async () => {
	const migrated = await openMigratedSchema("seal_sealing");
	connection = migrated.connection;
	schema = migrated.schema;
	writer = await openTestConnection();
});

afterAll(async () => {
	await writer.close();
	await dropSchema(connection, schema);
	await connection.close();
});

beforeEach(() => {
	raised = [];
});

function services(
	options: {
		readonly driver?: Driver;
		readonly sealing?: SealingMode;
		readonly anchors?: readonly SecurityStateAnchorPort[];
		readonly convertUnsealed?: (tx: Driver, read: SecurityStateRead) => Promise<SecurityStateRead>;
	} = {},
) {
	return {
		driver: options.driver ?? connection,
		schema,
		keys,
		sealing: options.sealing ?? "migrating",
		anchors: options.anchors ?? [],
		alarms,
		...(options.convertUnsealed === undefined ? {} : { convertUnsealed: options.convertUnsealed }),
	};
}

async function readOf(userId: string): Promise<SecurityStateRead> {
	const read = await readSecurityState(connection, schema, userId);
	if (read === null) {
		throw new Error("the account vanished");
	}
	return read;
}

async function verdictOf(userId: string) {
	return (await checkSecurityState(keys, await readOf(userId), "required")).verdict;
}

const unchanged: SealingChange<null> = {
	epoch: "keep",
	write: async () => null,
	after: (read) => sealedComponentsOf(read),
};

function passkeyRegistration(
	credentialId = randomBytes(32),
	publicKey = randomBytes(77),
): SealingChange<null> {
	return {
		epoch: "keep",
		write: async (tx, read) => {
			await tx.query(
				`INSERT INTO ${schema}.webauthn_credential
  (user_id, credential_id, public_key, backup_eligible, backup_state, user_verified_at_registration)
VALUES ($1, $2, $3, false, false, true)`,
				[read.userId, credentialId, publicKey],
			);
			return null;
		},
		after: (read) => {
			const components = sealedComponentsOf(read);
			return { ...components, passkeys: [...components.passkeys, { credentialId, publicKey }] };
		},
	};
}

describe("a change seals from its one verified read (S-INTEG-3)", () => {
	it("writes the first seal of an unsealed account in migrating mode at version 1 and epoch 1", async () => {
		const userId = await seedAccount(connection, schema, { password: true, passkeys: 1 });

		const outcome = await sealAccount(services(), userId, unchanged);

		expect(outcome.kind).toBe("sealed");
		const read = await readOf(userId);
		expect(read.seal?.version).toBe(1);
		expect(read.seal?.sessionEpoch).toBe(1);
		expect(await verdictOf(userId)).toBe("valid");
	});

	it("raises the version by one and keeps the epoch, and the new seal covers the change", async () => {
		const userId = await seedAccount(connection, schema, { password: true, passkeys: 1 });
		await sealAccount(services(), userId, unchanged);

		const outcome = await sealAccount(services(), userId, passkeyRegistration());

		expect(outcome.kind === "sealed" && outcome.sealed.version).toBe(2);
		const read = await readOf(userId);
		expect(read.passkeys).toHaveLength(2);
		expect(read.seal?.version).toBe(2);
		expect(read.seal?.sessionEpoch).toBe(1);
		expect(await verdictOf(userId)).toBe("valid");
	});

	it("draws a new random epoch for a change that raises it, the first seal included", async () => {
		const userId = await seedAccount(connection, schema, { password: true });
		const raising = { ...unchanged, epoch: "raise" as const };

		await sealAccount(services(), userId, raising);
		const first = (await readOf(userId)).seal?.sessionEpoch;
		await sealAccount(services(), userId, raising);
		const second = (await readOf(userId)).seal?.sessionEpoch;

		expect(first).not.toBe(1);
		expect(second).not.toBe(first);
		expect(Number.isSafeInteger(second)).toBe(true);
		expect(await verdictOf(userId)).toBe("valid");
	});

	it("seals an account created in the same transaction without locking it", async () => {
		const sealed = await connection.transaction(async (tx) => {
			const userId = await createUser(tx, schema);
			return sealCreatedAccount(tx, userId, { schema, keys });
		});

		expect(sealed.version).toBe(1);
		expect(await verdictOf(sealed.userId)).toBe("valid");
	});

	it("hands an unsealed account to the conversion first and seals what the conversion returned", async () => {
		const userId = await seedAccount(connection, schema, { password: true });
		const converted = randomBytes(96);
		const seen: string[] = [];

		await sealAccount(
			services({
				convertUnsealed: async (tx, read) => {
					seen.push(read.userId);
					await tx.query(`UPDATE ${schema}.password_credential SET phc = $2 WHERE user_id = $1`, [
						read.userId,
						converted,
					]);
					return read.password === null
						? read
						: { ...read, password: { ...read.password, phc: converted } };
				},
			}),
			userId,
			unchanged,
		);
		await sealAccount(
			services({ convertUnsealed: async () => Promise.reject(new Error("sealed")) }),
			userId,
			unchanged,
		);

		expect(seen).toEqual([userId]);
		expect(await verdictOf(userId)).toBe("valid");
	});
});

describe("the account lock of a sealing change", () => {
	it("is declared before the recovery codes and the seal row a regeneration orders", async () => {
		const userId = await seedAccount(connection, schema, { password: true, passkeys: 1 });
		await sealAccount(services(), userId, unchanged);
		const held = new HeldDriver(connection);
		const owned = new Set(
			(await readUserOwnedTables(connection, schema)).map((table) => table.table),
		);

		const replacement = randomBytes(32);
		const outcome = await sealAccount(services({ driver: held }), userId, {
			epoch: "keep",
			write: async (tx, read) => {
				await tx.query(`DELETE FROM ${schema}.recovery_code WHERE user_id = $1`, [read.userId]);
				await tx.query(
					`INSERT INTO ${schema}.recovery_code (user_id, code_hmac, key_version) VALUES ($1, $2, 1)`,
					[read.userId, replacement],
				);
				return null;
			},
			after: (read) => ({
				...sealedComponentsOf(read),
				recoveryCodes: [{ keyVersion: 1, codeHmac: replacement }],
			}),
		});

		expect(outcome.kind).toBe("sealed");
		const { late, considered } = accountLockAudit(held.transactions, schema, owned);
		expect(late, late.join("\n")).toEqual([]);
		expect(considered).toBe(1);
	});
});

describe("a change refuses a broken state and writes nothing", () => {
	async function sealedAccount(): Promise<string> {
		const userId = await seedAccount(connection, schema, { password: true, passkeys: 1 });
		await sealAccount(services(), userId, unchanged);
		return userId;
	}

	it("refuses an account whose seal no longer matches, with the alarm of the change", async () => {
		const userId = await sealedAccount();
		await insertPasskey(connection, schema, userId);
		let wrote = false;

		const outcome = await sealAccount(services(), userId, {
			...unchanged,
			write: async () => {
				wrote = true;
				return null;
			},
		});

		expect(outcome).toEqual({ kind: "refused", reason: "seal_mismatch" });
		expect(wrote).toBe(false);
		expect((await readOf(userId)).seal?.version).toBe(1);
		expect(raised).toEqual([{ userId, occasion: "change", reason: "seal_mismatch" }]);
	});

	it("refuses an account without a seal row in required mode", async () => {
		const userId = await seedAccount(connection, schema, { password: true });

		const outcome = await sealAccount(services({ sealing: "required" }), userId, unchanged);

		expect(outcome).toEqual({ kind: "refused", reason: "seal_missing" });
		expect((await readOf(userId)).seal).toBeNull();
		expect(raised).toEqual([{ userId, occasion: "change", reason: "seal_missing" }]);
	});

	it("refuses a seal at the largest version without changing a row", async () => {
		const userId = await sealedAccount();
		await connection.query(
			`UPDATE ${schema}.security_state SET version = 9007199254740991 WHERE user_id = $1`,
			[userId],
		);

		const outcome = await sealAccount(services(), userId, unchanged);

		expect(outcome.kind).toBe("refused");
		expect((await readOf(userId)).seal?.version).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("refuses and rolls the change back when a writer rewrote the seal row after the read", async () => {
		const userId = await sealedAccount();

		const outcome = await sealAccount(services(), userId, {
			...passkeyRegistration(),
			write: async (tx, read, next) => {
				await passkeyRegistration().write(tx, read, next);
				await writer.query(
					`UPDATE ${schema}.security_state SET sealed_at = sealed_at, session_epoch = session_epoch + 1 WHERE user_id = $1`,
					[userId],
				);
				return null;
			},
		});

		expect(outcome).toEqual({ kind: "refused", reason: "seal_mismatch" });
		expect((await readOf(userId)).passkeys).toHaveLength(1);
	});

	it("keeps a passkey a writer commits during the change out of the new seal, and the next check refuses", async () => {
		const userId = await sealedAccount();

		const outcome = await sealAccount(services(), userId, {
			...unchanged,
			write: async () => {
				await insertPasskey(writer, schema, userId);
				return null;
			},
		});

		expect(outcome.kind).toBe("sealed");
		expect((await readOf(userId)).passkeys).toHaveLength(2);
		expect(await verdictOf(userId)).toBe("seal_mismatch");
	});

	it("refuses a change that reads the state a second time, and rolls it back", async () => {
		const userId = await sealedAccount();

		const attempt = sealAccount(services(), userId, {
			...passkeyRegistration(),
			write: async (tx, read, next) => {
				await passkeyRegistration().write(tx, read, next);
				await readSecurityState(tx, schema, userId);
				return null;
			},
		});

		await expect(attempt).rejects.toThrow("read the security state a second time");
		expect((await readOf(userId)).passkeys).toHaveLength(1);
		expect((await readOf(userId)).seal?.version).toBe(1);
	});
});

describe("the anchor around a change", () => {
	function anchorWith(
		floor: () => unknown,
		recorded: SecurityStateSealedEvent[] = [],
		failRecord = false,
	): SecurityStateAnchorPort {
		return {
			minimumVersion: async () => floor() as SecurityStateFloor | null,
			recordSeal: async (event) => {
				if (failRecord) {
					throw new Error("store down");
				}
				recorded.push(event);
			},
		};
	}

	it("keeps the verified seal when a change leaves every component and the epoch as they were", async () => {
		const userId = await seedAccount(connection, schema, { password: true });
		await sealAccount(services(), userId, unchanged);
		const before = await readOf(userId);

		const outcome = await sealAccount(services(), userId, unchanged);
		const after = await readOf(userId);

		expect(outcome.kind).toBe("sealed");
		expect(after.seal?.version).toBe(before.seal?.version);
		expect(Buffer.from(after.seal?.digest ?? [])).toEqual(Buffer.from(before.seal?.digest ?? [1]));
	});

	it("records every new seal with the anchor after commit", async () => {
		const userId = await seedAccount(connection, schema, { password: true });
		const recorded: SecurityStateSealedEvent[] = [];
		const anchor = anchorWith(() => null, recorded);

		for (let change = 0; change < 5; change += 1) {
			await sealAccount(services({ anchors: [anchor] }), userId, passkeyRegistration());
		}
		await new Promise((resolve) => setTimeout(resolve, 0));

		const read = await readOf(userId);
		expect(recorded.map((event) => event.version)).toEqual([1, 2, 3, 4, 5]);
		expect(recorded[4]?.digest).toBe(encodeBase64Url(read.seal?.digest ?? new Uint8Array()));
	});

	it("refuses a change below the anchor's floor and one the anchor cannot answer for", async () => {
		const below = await seedAccount(connection, schema, { password: true });
		await sealAccount(services(), below, unchanged);
		const unavailable = await seedAccount(connection, schema, { password: true });
		await sealAccount(services(), unavailable, unchanged);

		const refusedBelow = await sealAccount(
			services({
				anchors: [anchorWith(() => ({ version: 2, digest: encodeBase64Url(new Uint8Array(32)) }))],
			}),
			below,
			unchanged,
		);
		const refusedUnavailable = await sealAccount(
			services({ anchors: [anchorWith(() => ({ version: Number.NaN }))] }),
			unavailable,
			unchanged,
		);

		expect(refusedBelow).toEqual({ kind: "refused", reason: "version_below_anchor" });
		expect(refusedUnavailable).toEqual({ kind: "refused", reason: "anchor_unavailable" });
		expect(raised).toEqual([
			{ userId: below, occasion: "change", reason: "version_below_anchor" },
			{ userId: unavailable, occasion: "change", reason: "anchor_unavailable" },
		]);
	});

	it("keeps the committed change when recordSeal fails, and raises anchor_unavailable", async () => {
		const userId = await seedAccount(connection, schema, { password: true });

		const outcome = await sealAccount(
			services({ anchors: [anchorWith(() => null, [], true)] }),
			userId,
			unchanged,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(outcome.kind).toBe("sealed");
		expect((await readOf(userId)).seal?.version).toBe(1);
		expect(raised).toEqual([{ userId, occasion: "change", reason: "anchor_unavailable" }]);
	});
});

describe("a first seal that collides with a seal row inserted past the library", () => {
	function failingFirstInserts(times: number): { driver: Driver; inserts: () => number } {
		let failures = 0;
		let inserts = 0;
		const wrap = (driver: Driver): Driver => ({
			async query<T>(sql: string, params: unknown[]): Promise<T[]> {
				if (sql.startsWith(`INSERT INTO ${schema}.security_state`)) {
					inserts += 1;
					if (failures < times) {
						failures += 1;
						await driver.query("SELECT 1", []);
						throw Object.assign(new Error("duplicate key value"), { sqlState: "23505" });
					}
				}
				return driver.query<T>(sql, params);
			},
			transaction: (work) => driver.transaction((tx) => work(wrap(tx))),
		});
		return { driver: wrap(connection), inserts: () => inserts };
	}

	it("succeeds on the third attempt after two violations", async () => {
		const userId = await seedAccount(connection, schema, { password: true });
		const failing = failingFirstInserts(2);

		const outcome = await sealAccount(services({ driver: failing.driver }), userId, unchanged);

		expect(outcome.kind).toBe("sealed");
		expect(failing.inserts()).toBe(3);
		expect(await verdictOf(userId)).toBe("valid");
	});

	it("refuses after the third violation without writing a seal", async () => {
		const userId = await seedAccount(connection, schema, { password: true });
		const failing = failingFirstInserts(3);

		const outcome = await sealAccount(services({ driver: failing.driver }), userId, unchanged);

		expect(outcome).toEqual({ kind: "refused", reason: "seal_mismatch" });
		expect(failing.inserts()).toBe(3);
		expect((await readOf(userId)).seal).toBeNull();
	});

	it("runs a sealing transaction at read committed and passes other failures through untouched", async () => {
		const isolation = await runSealingTransaction(connection, async (tx) => {
			const [row] = await tx.query<{ isolation: string }>(
				"SELECT current_setting('transaction_isolation') AS isolation",
				[],
			);
			return row?.isolation;
		});
		const failure = new Error("not a conflict");

		expect(isolation).toBe("read committed");
		await expect(
			runSealingTransaction(connection, async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		await expect(
			runSealingTransaction(connection, async () => {
				throw new SealingRefusedError("seal_missing");
			}),
		).rejects.toBeInstanceOf(SealingRefusedError);
	});
});

describe("a change that learns its account by consuming a row", () => {
	function recording(driver: Driver, statements: string[]): Driver {
		return {
			query<T>(sql: string, params: unknown[]): Promise<T[]> {
				statements.push(sql);
				return driver.query<T>(sql, params);
			},
			transaction: (work) => driver.transaction((tx) => work(recording(tx, statements))),
		};
	}

	async function consumeThenSeal(userId: string, statements: string[]) {
		return runSealingTransaction(recording(connection, statements), async (tx) => {
			const [consumed] = await tx.query<{ owner: string }>(
				`DELETE FROM ${schema}.test_consumable WHERE owner = $1 RETURNING owner::text AS owner`,
				[userId],
			);
			if (consumed === undefined) {
				throw new Error("nothing to consume");
			}
			const reading = await consultAnchors([], consumed.owner);
			return sealUnderAccountLock(
				tx,
				consumed.owner,
				{ schema, keys, sealing: "migrating" },
				reading,
				passkeyRegistration(),
			);
		});
	}

	beforeAll(async () => {
		await connection.query(`CREATE TABLE ${schema}.test_consumable (owner uuid NOT NULL)`, []);
	});

	it("consumes first, locks after, and seals the change", async () => {
		const userId = await seedAccount(connection, schema, { password: true });
		await connection.query(`INSERT INTO ${schema}.test_consumable (owner) VALUES ($1)`, [userId]);
		const statements: string[] = [];

		const sealed = await consumeThenSeal(userId, statements);

		const consumption = statements.findIndex((sql) =>
			sql.startsWith(`DELETE FROM ${schema}.test_consumable`),
		);
		const lock = statements.findIndex((sql) => sql.includes("FOR NO KEY UPDATE"));
		expect(statements[0]).toBe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
		expect(consumption).toBe(1);
		expect(lock).toBeGreaterThan(consumption);
		expect(sealed.version).toBe(1);
		expect(await verdictOf(userId)).toBe("valid");
	});

	it("gives the consumed row back when the state is broken", async () => {
		const userId = await seedAccount(connection, schema, { password: true });
		await sealAccount(services(), userId, unchanged);
		await insertPasskey(connection, schema, userId);
		await connection.query(`INSERT INTO ${schema}.test_consumable (owner) VALUES ($1)`, [userId]);

		await expect(consumeThenSeal(userId, [])).rejects.toBeInstanceOf(SealingRefusedError);

		const [left] = await connection.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM ${schema}.test_consumable WHERE owner = $1`,
			[userId],
		);
		expect(left?.count).toBe("1");
	});
});

describe("drawing a session epoch", () => {
	it("draws exact integers from 1, never the current one", () => {
		for (let draw = 0; draw < 1000; draw += 1) {
			const epoch = drawSessionEpochOtherThan(1);
			expect(Number.isSafeInteger(epoch) && epoch >= 1 && epoch !== 1).toBe(true);
		}
	});
});
