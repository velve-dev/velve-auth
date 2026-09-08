import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import { VelveError } from "../src/core/http/error-map.js";
import {
	countSignInMethods,
	removeSignInMethod,
	type SignInMethodRemoval,
	totalSignInMethods,
} from "../src/core/identity/sign-in-methods.js";
import { actorOfTestUser } from "./db-fixtures.js";
import {
	openTestConnection,
	PostgresServerError,
	type TestConnection,
} from "./db-postgres-connection.js";

const schema = `velve_identity_race_${randomBytes(4).toString("hex")}`;
const ROUNDS = 8;
const NO_SUCH_USER = "00000000-0000-4000-8000-000000000000";

let connection: TestConnection;

beforeAll(async () => {
	connection = await openTestConnection();
	await runMigrations({ driver: connection, schema, migrations: coreMigrations("email") });
});

afterAll(async () => {
	await connection.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
	await connection.close();
});

async function createUser(driver: Driver = connection): Promise<string> {
	const [row] = await driver.query<{ readonly id: string }>(
		`INSERT INTO ${schema}.user (email) VALUES ($1) RETURNING id`,
		[`${randomBytes(8).toString("hex")}@example.test`],
	);
	if (row === undefined) {
		throw new Error("the user was not created");
	}
	return row.id;
}

async function givePassword(userId: string): Promise<void> {
	await connection.query(
		`INSERT INTO ${schema}.password_credential (user_id, phc, scheme) VALUES ($1, $2, $3)`,
		[userId, randomBytes(32), "argon2id"],
	);
}

async function linkIdentity(userId: string): Promise<string> {
	const [row] = await connection.query<{ readonly id: string }>(
		`INSERT INTO ${schema}.identity (user_id, provider, subject) VALUES ($1, $2, $3) RETURNING id`,
		[userId, "github", randomBytes(8).toString("hex")],
	);
	if (row === undefined) {
		throw new Error("the identity was not created");
	}
	return row.id;
}

async function addWebauthnCredential(userId: string): Promise<string> {
	const [row] = await connection.query<{ readonly id: string }>(
		`INSERT INTO ${schema}.webauthn_credential
		   (user_id, credential_id, public_key, backup_eligible, backup_state,
		    user_verified_at_registration)
		 VALUES ($1, $2, $3, false, false, true) RETURNING id`,
		[userId, randomBytes(16), randomBytes(64)],
	);
	if (row === undefined) {
		throw new Error("the credential was not created");
	}
	return row.id;
}

function deletionFor(removal: SignInMethodRemoval): { sql: string; params: readonly unknown[] } {
	switch (removal.method) {
		case "password":
			return { sql: `DELETE FROM ${schema}.password_credential WHERE user_id = $1`, params: [] };
		case "webauthn_credential":
			return {
				sql: `DELETE FROM ${schema}.webauthn_credential WHERE user_id = $1 AND id = $2`,
				params: [removal.credentialId],
			};
		case "linked_identity":
			return {
				sql: `DELETE FROM ${schema}.identity WHERE user_id = $1 AND id = $2`,
				params: [removal.identityId],
			};
	}
}

async function removeInTransaction(
	driver: TestConnection,
	userId: string,
	removal: SignInMethodRemoval,
	pause: () => Promise<void>,
): Promise<string> {
	try {
		await driver.query("BEGIN", []);
		await removeSignInMethod({
			driver,
			schema,
			actor: actorOfTestUser(userId),
			removing: removal,
		});
		await pause();
		const deletion = deletionFor(removal);
		await driver.query(deletion.sql, [userId, ...deletion.params]);
		await driver.query("COMMIT", []);
		return "removed";
	} catch (cause) {
		await driver.query("ROLLBACK", []).catch(() => undefined);
		if (cause instanceof VelveError) {
			return cause.code;
		}
		return cause instanceof Error ? `unexpected: ${cause.message}` : "unexpected";
	}
}

async function removeWithoutTransaction(
	driver: TestConnection,
	userId: string,
	removal: SignInMethodRemoval,
	pause: () => Promise<void>,
): Promise<string> {
	try {
		await removeSignInMethod({
			driver,
			schema,
			actor: actorOfTestUser(userId),
			removing: removal,
		});
		await pause();
		const deletion = deletionFor(removal);
		await driver.query(deletion.sql, [userId, ...deletion.params]);
		return "removed";
	} catch (cause) {
		return cause instanceof VelveError ? cause.code : "unexpected";
	}
}

function remainingMethods(userId: string): Promise<number> {
	return countSignInMethods({
		driver: connection,
		schema,
		actor: actorOfTestUser(userId),
	}).then(totalSignInMethods);
}

function released(): { pause: () => Promise<void>; release: () => void } {
	let release = (): void => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { pause: () => gate, release };
}

describe("two removals of the last two ways in (L-13)", () => {
	it("lets exactly one of them through in every round", async () => {
		const first = await openTestConnection();
		const second = await openTestConnection();
		const results: string[][] = [];
		const survivors: number[] = [];
		try {
			for (let round = 0; round < ROUNDS; round += 1) {
				const userId = await createUser();
				await givePassword(userId);
				const identityId = await linkIdentity(userId);
				const gate = released();
				const running = Promise.all([
					removeInTransaction(first, userId, { method: "password" }, gate.pause),
					removeInTransaction(
						second,
						userId,
						{ method: "linked_identity", identityId },
						gate.pause,
					),
				]);
				setTimeout(gate.release, 40);
				results.push((await running).sort());
				survivors.push(await remainingMethods(userId));
			}
		} finally {
			await first.close();
			await second.close();
		}
		expect(results).toEqual(results.map(() => ["last_sign_in_method", "removed"].sort()));
		expect(survivors).toEqual(survivors.map(() => 1));
	});

	it("holds when the two removals are a credential and an identity", async () => {
		const first = await openTestConnection();
		const second = await openTestConnection();
		const survivors: number[] = [];
		const results: string[][] = [];
		try {
			for (let round = 0; round < ROUNDS; round += 1) {
				const userId = await createUser();
				const credentialId = await addWebauthnCredential(userId);
				const identityId = await linkIdentity(userId);
				const gate = released();
				const running = Promise.all([
					removeInTransaction(
						first,
						userId,
						{ method: "webauthn_credential", credentialId },
						gate.pause,
					),
					removeInTransaction(
						second,
						userId,
						{ method: "linked_identity", identityId },
						gate.pause,
					),
				]);
				setTimeout(gate.release, 40);
				results.push((await running).sort());
				survivors.push(await remainingMethods(userId));
			}
		} finally {
			await first.close();
			await second.close();
		}
		expect(results).toEqual(results.map(() => ["last_sign_in_method", "removed"].sort()));
		expect(survivors).toEqual(survivors.map(() => 1));
	});

	it("would let both through on the count alone, which is what makes the rounds above evidence", async () => {
		const first = await openTestConnection();
		const second = await openTestConnection();
		try {
			const userId = await createUser();
			await givePassword(userId);
			const identityId = await linkIdentity(userId);
			const gate = released();
			const countingOnly = async (
				driver: TestConnection,
				removal: SignInMethodRemoval,
			): Promise<string> => {
				await driver.query("BEGIN", []);
				const remaining = await countSignInMethods({
					driver,
					schema,
					actor: actorOfTestUser(userId),
					excluding: removal,
				});
				if (totalSignInMethods(remaining) === 0) {
					await driver.query("ROLLBACK", []);
					return "last_sign_in_method";
				}
				await gate.pause();
				const deletion = deletionFor(removal);
				await driver.query(deletion.sql, [userId, ...deletion.params]);
				await driver.query("COMMIT", []);
				return "removed";
			};
			const running = Promise.all([
				countingOnly(first, { method: "password" }),
				countingOnly(second, { method: "linked_identity", identityId }),
			]);
			setTimeout(gate.release, 40);
			expect((await running).sort()).toEqual(["removed", "removed"]);
			expect(await remainingMethods(userId)).toBe(0);
		} finally {
			await first.close();
			await second.close();
		}
	});

	/**
	 * `removeSignInMethod` takes a `Driver`, and a caller who hands it
	 * a plain driver gets no lock and no complaint. L-13 is then violated with no error anywhere.
	 */
	it("lets exactly one of them through even when the caller opened no transaction", async () => {
		const first = await openTestConnection();
		const second = await openTestConnection();
		try {
			const userId = await createUser();
			await givePassword(userId);
			const identityId = await linkIdentity(userId);
			const gate = released();
			const running = Promise.all([
				removeWithoutTransaction(first, userId, { method: "password" }, gate.pause),
				removeWithoutTransaction(
					second,
					userId,
					{ method: "linked_identity", identityId },
					gate.pause,
				),
			]);
			setTimeout(gate.release, 40);
			const outcomes = (await running).sort();
			expect(outcomes).toEqual(["last_sign_in_method", "removed"].sort());
			expect(await remainingMethods(userId)).toBe(1);
		} finally {
			await first.close();
			await second.close();
		}
	});
});

describe("the count as a hand-off to a caller who has not read it", () => {
	it("counts only the rows of the account it was asked about", async () => {
		const mine = await createUser();
		const theirs = await createUser();
		await givePassword(mine);
		await givePassword(theirs);
		await addWebauthnCredential(theirs);
		await linkIdentity(theirs);
		expect(
			await countSignInMethods({
				driver: connection,
				schema,
				actor: actorOfTestUser(mine),
			}),
		).toEqual({ password: 1, webauthnCredentials: 0, linkedIdentities: 0 });
	});

	it("answers zero for an account that does not exist and refuses the removal", async () => {
		const actor = actorOfTestUser(NO_SUCH_USER);
		expect(await countSignInMethods({ driver: connection, schema, actor })).toEqual({
			password: 0,
			webauthnCredentials: 0,
			linkedIdentities: 0,
		});
		const refusal = await connection
			.transaction((transaction) =>
				removeSignInMethod({
					driver: transaction,
					schema,
					actor,
					removing: { method: "password" },
				}),
			)
			.then(
				() => "allowed",
				(cause: unknown) => (cause instanceof VelveError ? cause.code : "unexpected"),
			);
		expect(refusal).toBe("last_sign_in_method");
	});

	it("leaves the count alone for a row that is already gone or belongs to somebody else", async () => {
		const mine = await createUser();
		await givePassword(mine);
		const theirs = await createUser();
		const theirCredential = await addWebauthnCredential(theirs);
		const actor = actorOfTestUser(mine);
		expect(
			await countSignInMethods({
				driver: connection,
				schema,
				actor,
				excluding: { method: "webauthn_credential", credentialId: theirCredential },
			}),
		).toEqual({ password: 1, webauthnCredentials: 0, linkedIdentities: 0 });
		expect(
			await countSignInMethods({
				driver: connection,
				schema,
				actor,
				excluding: { method: "linked_identity", identityId: NO_SUCH_USER },
			}),
		).toEqual({ password: 1, webauthnCredentials: 0, linkedIdentities: 0 });
		expect(
			await countSignInMethods({
				driver: connection,
				schema,
				actor,
				excluding: { method: "password" },
			}),
		).toEqual({ password: 0, webauthnCredentials: 0, linkedIdentities: 0 });
	});

	it("lets the driver refuse an identifier that is not a uuid rather than counting nothing", async () => {
		const actor = actorOfTestUser("not-a-uuid");
		const failure = await countSignInMethods({ driver: connection, schema, actor }).then(
			() => "counted",
			(cause: unknown) => {
				if (cause instanceof VelveError) {
					return cause.code;
				}
				return cause instanceof PostgresServerError ? `postgres ${cause.sqlState}` : "unexpected";
			},
		);
		expect(failure).toBe("postgres 22P02");
	});
});

function removalOn(driver: Driver, userId: string, removing: SignInMethodRemoval): Promise<string> {
	return removeSignInMethod({
		driver,
		schema,
		actor: actorOfTestUser(userId),
		removing,
	}).then(
		() => "removed",
		(cause: unknown) => (cause instanceof VelveError ? cause.code : "unexpected"),
	);
}

/** A driver whose `transaction` opens none, which is what an HTTP-only Postgres endpoint offers. */
function withoutRealTransactions(driver: TestConnection): Driver {
	const fake: Driver = {
		query<T>(sql: string, params: unknown[]): Promise<T[]> {
			return driver.query<T>(sql, params);
		},
		transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
			return fn(fake);
		},
	};
	return fake;
}

describe("the removal called every way a caller can call it", () => {
	it("commits the removal when the caller opened no transaction", async () => {
		const userId = await createUser();
		await givePassword(userId);
		const identityId = await linkIdentity(userId);
		expect(await removalOn(connection, userId, { method: "linked_identity", identityId })).toBe(
			"removed",
		);
		expect(await remainingMethods(userId)).toBe(1);
	});

	it("rolls the removal back with a transaction the caller rolls back", async () => {
		const driver = await openTestConnection();
		try {
			const userId = await createUser();
			await givePassword(userId);
			const identityId = await linkIdentity(userId);
			await driver.query("BEGIN", []);
			expect(await removalOn(driver, userId, { method: "linked_identity", identityId })).toBe(
				"removed",
			);
			await driver.query("ROLLBACK", []);
			expect(await remainingMethods(userId)).toBe(2);
		} finally {
			await driver.close();
		}
	});

	/**
	 * Excluding by identifier rather than subtracting one means a stale identifier does not make
	 * the count too low and refuse a removal that was allowed (E-199). The caller cannot tell that
	 * nothing was deleted, because the call returns nothing either way.
	 */
	it("neither refuses nor deletes for an identifier that is already gone", async () => {
		const userId = await createUser();
		await givePassword(userId);
		const identityId = await linkIdentity(userId);
		expect(await removalOn(connection, userId, { method: "linked_identity", identityId })).toBe(
			"removed",
		);
		expect(await removalOn(connection, userId, { method: "linked_identity", identityId })).toBe(
			"removed",
		);
		expect(await remainingMethods(userId)).toBe(1);
		expect(await removalOn(connection, userId, { method: "password" })).toBe("last_sign_in_method");
		expect(await remainingMethods(userId)).toBe(1);
	});

	it("never removes a row that belongs to another account", async () => {
		const mine = await createUser();
		await givePassword(mine);
		await linkIdentity(mine);
		const theirs = await createUser();
		await givePassword(theirs);
		const theirCredential = await addWebauthnCredential(theirs);
		expect(
			await removalOn(connection, mine, {
				method: "webauthn_credential",
				credentialId: theirCredential,
			}),
		).toBe("removed");
		expect(await remainingMethods(theirs)).toBe(2);
		expect(await remainingMethods(mine)).toBe(2);
	});

	it("refuses for an account that does not exist and removes nothing anywhere", async () => {
		const bystander = await createUser();
		await givePassword(bystander);
		expect(await removalOn(connection, NO_SUCH_USER, { method: "password" })).toBe(
			"last_sign_in_method",
		);
		expect(await remainingMethods(bystander)).toBe(1);
	});

	it("fails closed rather than unlocked when the driver cannot open a transaction", async () => {
		const driver = await openTestConnection();
		try {
			const userId = await createUser();
			await givePassword(userId);
			const identityId = await linkIdentity(userId);
			expect(
				await removalOn(withoutRealTransactions(driver), userId, {
					method: "linked_identity",
					identityId,
				}),
			).toBe("internal_error");
			expect(await remainingMethods(userId)).toBe(2);
		} finally {
			await driver.close();
		}
	});

	it("lets exactly one through when one caller holds a transaction and the other does not", async () => {
		const inside = await openTestConnection();
		const outside = await openTestConnection();
		try {
			const userId = await createUser();
			await givePassword(userId);
			const identityId = await linkIdentity(userId);
			const held = async (): Promise<string> => {
				await inside.query("BEGIN", []);
				const outcome = await removalOn(inside, userId, { method: "password" });
				await inside.query(outcome === "removed" ? "COMMIT" : "ROLLBACK", []);
				return outcome;
			};
			const outcomes = (
				await Promise.all([
					held(),
					removalOn(outside, userId, { method: "linked_identity", identityId }),
				])
			).sort();
			expect(outcomes).toEqual(["last_sign_in_method", "removed"].sort());
			expect(await remainingMethods(userId)).toBe(1);
		} finally {
			await inside.close();
			await outside.close();
		}
	});
});
