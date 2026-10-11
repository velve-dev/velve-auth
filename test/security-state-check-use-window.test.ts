import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import {
	FALLBACK_DATABASE_URL,
	openTestConnection,
	type TestConnection,
} from "./db-postgres-connection.js";

//a writer who holds the seal table can make the checked read differ from the read a factor is evaluated against, which the specification closes (E-3359)

let library: TestConnection;
let writer: TestConnection;
let schema: string;
const role = `check_window_writer_${randomBytes(4).toString("hex")}`;
const password = randomBytes(12).toString("hex");

beforeAll(async () => {
	const migrated = await openMigratedSchema("check_use_window");
	library = migrated.connection;
	schema = migrated.schema;
	await library.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`, []);
	await library.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`, []);
	await library.query(
		`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
		[],
	);
	const url = new URL(process.env.VELVE_TEST_DATABASE_URL ?? FALLBACK_DATABASE_URL);
	url.username = role;
	url.password = password;
	writer = await openTestConnection(url.toString());
});

afterAll(async () => {
	await writer.close();
	await dropSchema(library, schema);
	await library.query(`DROP ROLE IF EXISTS ${role}`, []);
	await library.close();
});

async function passkeyLookupThenOneStatementCheck() {
	const userId = await createUser(library, schema);
	const credentialId = randomBytes(16);
	const ownKey = randomBytes(64);
	const writersKey = randomBytes(64);
	await library.query(
		`INSERT INTO ${schema}.webauthn_credential
		 (user_id, credential_id, public_key, backup_eligible, backup_state, user_verified_at_registration)
		 VALUES ($1, $2, $3, false, false, true)`,
		[userId, credentialId, ownKey],
	);
	await library.query(
		`INSERT INTO ${schema}.security_state (user_id, version, digest, key_version)
		 VALUES ($1, 1, decode(repeat('00', 32), 'hex'), 1)`,
		[userId],
	);

	await writer.query(
		`UPDATE ${schema}.webauthn_credential SET public_key = $2 WHERE credential_id = $1`,
		[credentialId, writersKey],
	);
	const [lookedUp] = await library.query<{ public_key: Buffer }>(
		`SELECT public_key FROM ${schema}.webauthn_credential WHERE credential_id = $1`,
		[credentialId],
	);

	await writer.query("BEGIN", []);
	await writer.query(`LOCK TABLE ${schema}.security_state IN ACCESS EXCLUSIVE MODE`, []);
	const checkedRead = library.query<{ version: string; public_key: Buffer }>(
		`SELECT st.version::text AS version, w.public_key
		 FROM ${schema}.security_state st
		 JOIN ${schema}.webauthn_credential w ON w.user_id = st.user_id
		 WHERE st.user_id = $1`,
		[userId],
	);
	await new Promise((resolve) => setTimeout(resolve, 300));
	const [waiting] = await writer.query<{ waiting: number }>(
		`SELECT count(*)::int AS waiting FROM pg_locks
		 WHERE NOT granted AND relation = '${schema}.security_state'::regclass`,
		[],
	);
	await writer.query(
		`UPDATE ${schema}.webauthn_credential SET public_key = $2 WHERE credential_id = $1`,
		[credentialId, ownKey],
	);
	await writer.query("COMMIT", []);
	const checked = await checkedRead;

	return {
		checkWaitedOnTheWriter: waiting?.waiting === 1,
		lookupSawTheWritersKey: Buffer.from(lookedUp?.public_key ?? []).equals(writersKey),
		checkSawOnlyTheOwnKey:
			checked.length === 1 && Buffer.from(checked[0]?.public_key ?? []).equals(ownKey),
	};
}

describe("premise: a writer with INSERT, UPDATE and DELETE only, between lookup and check", () => {
	it("holds the one-statement check until it has restored the row the lookup read", async () => {
		expect(await passkeyLookupThenOneStatementCheck()).toStrictEqual({
			checkWaitedOnTheWriter: true,
			lookupSawTheWritersKey: true,
			checkSawOnlyTheOwnKey: true,
		});
	});
});

async function recoveryCodeCopiedBetweenReadAndConsumption() {
	const victim = await createUser(library, schema);
	const attacker = await createUser(library, schema);
	const victimsCode = randomBytes(32);
	const attackersCode = randomBytes(32);
	await library.query(
		`INSERT INTO ${schema}.recovery_code (user_id, code_hmac, key_version) VALUES ($1, $2, 1), ($3, $4, 1)`,
		[victim, victimsCode, attacker, attackersCode],
	);
	await library.query("BEGIN ISOLATION LEVEL READ COMMITTED", []);
	try {
		await library.query(
			`SELECT 1 FROM ${schema}.user WHERE id = $1 FOR NO KEY UPDATE /* locks: ${schema}.user */`,
			[victim],
		);
		const read = await library.query<{ code_hmac: Buffer }>(
			`SELECT code_hmac FROM ${schema}.recovery_code WHERE user_id = $1`,
			[victim],
		);
		await writer.query("SET lock_timeout = '2s'", []);
		await writer.query(
			`INSERT INTO ${schema}.recovery_code (user_id, code_hmac, key_version) VALUES ($1, $2, 1)`,
			[victim, attackersCode],
		);
		const consumed = await library.query(
			`DELETE FROM ${schema}.recovery_code WHERE user_id = $1 AND code_hmac = $2 RETURNING key_version`,
			[victim, attackersCode],
		);
		const after = await library.query<{ code_hmac: Buffer }>(
			`SELECT code_hmac FROM ${schema}.recovery_code WHERE user_id = $1`,
			[victim],
		);
		const sameSet = (rows: { code_hmac: Buffer }[]) =>
			rows
				.map((row) => Buffer.from(row.code_hmac).toString("hex"))
				.sort()
				.join(",");
		return {
			readHeldTheAttackersCode: read.some((row) =>
				Buffer.from(row.code_hmac).equals(attackersCode),
			),
			consumptionAcceptedIt: consumed.length,
			sealFromReadAndChangeMatchesTheRows: sameSet(read) === sameSet(after),
		};
	} finally {
		await library.query("ROLLBACK", []);
	}
}

describe("premise: a recovery code copied past the account lock between the read and its consumption", () => {
	it("is consumed, and a seal computed from the read and the change still matches the rows", async () => {
		expect(await recoveryCodeCopiedBetweenReadAndConsumption()).toStrictEqual({
			readHeldTheAttackersCode: false,
			consumptionAcceptedIt: 1,
			sealFromReadAndChangeMatchesTheRows: true,
		});
	});
});

const german = readFileSync(new URL("../VELVE-AUTH-ARCHITEKTUR.md", import.meta.url), "utf8");

function paragraphStartingWith(prefix: string): string {
	return german.split("\n").find((line) => line.startsWith(prefix)) ?? "";
}

describe("3.18 Prüfen and the fourth INTEG requirement against that window", () => {
	it("require the factor a check evaluates to be the one its verified read returned", () => {
		const checking = paragraphStartingWith("*Prüfen.*");
		const requirement = paragraphStartingWith(`- **${["S", "INTEG", "4"].join("-")}:**`);
		const binds =
			/(aus (genau )?diesem Lesen|aus derselben Anweisung|aus der geprüften Anweisung)[^.]*(Faktor|Passkey|öffentlich|Identität|PHC|Kennwort)|(Faktor|Passkey|öffentlich|Identität|PHC|Kennwort)[^.]*(aus (genau )?diesem Lesen|aus derselben Anweisung|aus der geprüften Anweisung)/;
		expect({ checking: binds.test(checking), requirement: binds.test(requirement) }).toStrictEqual({
			checking: true,
			requirement: true,
		});
	});
});
