import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actorOfResolvedSession } from "../src/core/db/actor.js";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import { VelveError } from "../src/core/http/error-map.js";
import {
	countSignInMethods,
	removeSignInMethod,
	type SignInMethodCount,
	type SignInMethodQuery,
	type SignInMethodRemoval,
	type SignInMethodRemovalRequest,
	totalSignInMethods,
} from "../src/core/identity/sign-in-methods.js";
import {
	openTestConnection,
	PostgresServerError,
	type TestConnection,
} from "./db-postgres-connection.js";

const schema = `velve_identity_methods_${randomBytes(4).toString("hex")}`;
const LOCK_NOT_AVAILABLE = "55P03";
let connection: TestConnection;

beforeAll(async () => {
	connection = await openTestConnection();
	await runMigrations({ driver: connection, schema, migrations: coreMigrations("email") });
});

afterAll(async () => {
	await connection.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
	await connection.close();
});

async function createUser(): Promise<string> {
	const [row] = await connection.query<{ readonly id: string }>(
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

function countFor(userId: string, excluding?: SignInMethodRemoval): Promise<SignInMethodCount> {
	const query: SignInMethodQuery =
		excluding === undefined
			? { driver: connection, schema, actor: actorOfResolvedSession({ userId }) }
			: { driver: connection, schema, actor: actorOfResolvedSession({ userId }), excluding };
	return countSignInMethods(query);
}

async function removalOf(userId: string, removing: SignInMethodRemoval): Promise<string | null> {
	try {
		await connection.transaction((transaction) => {
			const check: SignInMethodRemovalRequest = {
				driver: transaction,
				schema,
				actor: actorOfResolvedSession({ userId }),
				removing,
			};
			return removeSignInMethod(check);
		});
		return null;
	} catch (cause) {
		return cause instanceof VelveError ? cause.code : "unexpected";
	}
}

describe("counting the ways in which an account can sign in", () => {
	it("counts a password, every credential and every identity, and nothing else", async () => {
		const userId = await createUser();
		await givePassword(userId);
		await addWebauthnCredential(userId);
		await addWebauthnCredential(userId);
		await linkIdentity(userId);
		const count = await countFor(userId);
		expect(count).toEqual({ password: 1, webauthnCredentials: 2, linkedIdentities: 1 });
		expect(totalSignInMethods(count)).toBe(4);
	});

	it("counts nothing for an account that has nothing", async () => {
		const userId = await createUser();
		expect(totalSignInMethods(await countFor(userId))).toBe(0);
	});

	it("leaves out the row the caller is about to remove", async () => {
		const userId = await createUser();
		const credentialId = await addWebauthnCredential(userId);
		const identityId = await linkIdentity(userId);
		expect(await countFor(userId, { method: "webauthn_credential", credentialId })).toEqual({
			password: 0,
			webauthnCredentials: 0,
			linkedIdentities: 1,
		});
		expect(await countFor(userId, { method: "linked_identity", identityId })).toEqual({
			password: 0,
			webauthnCredentials: 1,
			linkedIdentities: 0,
		});
	});
});

describe("the last sign-in method (L-13)", () => {
	it("refuses to remove the only password", async () => {
		const userId = await createUser();
		await givePassword(userId);
		expect(await removalOf(userId, { method: "password" })).toBe("last_sign_in_method");
	});

	it("refuses to remove the only credential", async () => {
		const userId = await createUser();
		const credentialId = await addWebauthnCredential(userId);
		expect(await removalOf(userId, { method: "webauthn_credential", credentialId })).toBe(
			"last_sign_in_method",
		);
	});

	it("refuses to remove the only identity", async () => {
		const userId = await createUser();
		const identityId = await linkIdentity(userId);
		expect(await removalOf(userId, { method: "linked_identity", identityId })).toBe(
			"last_sign_in_method",
		);
	});

	it("removes the method while any other way in remains, and then refuses the last", async () => {
		const userId = await createUser();
		await givePassword(userId);
		const identityId = await linkIdentity(userId);
		expect(await removalOf(userId, { method: "linked_identity", identityId })).toBeNull();
		expect(await countFor(userId)).toEqual({
			password: 1,
			webauthnCredentials: 0,
			linkedIdentities: 0,
		});
		expect(await removalOf(userId, { method: "password" })).toBe("last_sign_in_method");
	});

	it("leaves the row in place when it refuses", async () => {
		const userId = await createUser();
		await givePassword(userId);
		expect(await removalOf(userId, { method: "password" })).toBe("last_sign_in_method");
		expect(totalSignInMethods(await countFor(userId))).toBe(1);
	});

	it("does not let a confirmed address or a recovery code stand in for a way in", async () => {
		const userId = await createUser();
		await connection.query(`UPDATE ${schema}.user SET email_verified_at = now() WHERE id = $1`, [
			userId,
		]);
		await connection.query(
			`INSERT INTO ${schema}.recovery_code (user_id, code_hmac, key_version) VALUES ($1, $2, 1)`,
			[userId, randomBytes(32)],
		);
		await givePassword(userId);
		expect(await removalOf(userId, { method: "password" })).toBe("last_sign_in_method");
	});

	it("holds the account against a second removal until the first has committed", async () => {
		const userId = await createUser();
		await givePassword(userId);
		await linkIdentity(userId);
		const other = await openTestConnection();
		try {
			await connection.query("BEGIN", []);
			await removeSignInMethod({
				driver: connection,
				schema,
				actor: actorOfResolvedSession({ userId }),
				removing: { method: "password" },
			});
			const contended = await other
				.query(`SELECT id FROM ${schema}.user WHERE id = $1 FOR UPDATE NOWAIT`, [userId])
				.then(
					() => null,
					(refusal: unknown) => refusal,
				);
			await connection.query("ROLLBACK", []);
			expect(contended).toBeInstanceOf(PostgresServerError);
			expect((contended as PostgresServerError).sqlState).toBe(LOCK_NOT_AVAILABLE);
		} finally {
			await other.close();
		}
	});
});
