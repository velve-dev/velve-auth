import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPasswordProvenance } from "../src/core/flows/credential.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

//the l-12 provenance compares session ids, which the session mac therefore binds (E-3360)

let connection: TestConnection;
let schema: string;

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("session_id_bound"));
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

async function sessionOf(userId: string): Promise<string> {
	const [row] = await connection.query<{ id: string }>(
		`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at)
		 VALUES ($1, $2, now() + interval '1 hour', now() + interval '1 day') RETURNING id`,
		[userId, randomBytes(32)],
	);
	return String(row?.id);
}

async function firstConfirmationKeepsThePassword(writerRenamesTheSession: boolean) {
	const preCreated = await createUser(connection, schema);
	const attackersSignUpSession = await sessionOf(preCreated);
	await connection.query(
		`INSERT INTO ${schema}.password_credential (user_id, phc, key_version, scheme, set_by_session_id)
		 VALUES ($1, $2, 1, 'argon2id', $3)`,
		[preCreated, randomBytes(48), attackersSignUpSession],
	);
	const victimsOtherAccount = await createUser(connection, schema);
	let victimsSession = await sessionOf(victimsOtherAccount);

	if (writerRenamesTheSession) {
		await connection.query(`UPDATE ${schema}.session SET id = $2 WHERE id = $1`, [
			attackersSignUpSession,
			randomUUID(),
		]);
		const [renamed] = await connection.query<{ id: string }>(
			`UPDATE ${schema}.session SET id = $2 WHERE id = $1 RETURNING id`,
			[victimsSession, attackersSignUpSession],
		);
		victimsSession = String(renamed?.id);
	}

	const deleted = await createPasswordProvenance({
		driver: connection,
		schema,
	}).deleteUnlessSetInSession({ actor: actorOfTestUser(preCreated), sessionId: victimsSession });
	return { passwordDeleted: deleted };
}

describe("premise: L-12 against a writer who renames the confirming caller's session", () => {
	it("control: the victim's own session at the first confirmation removes the attacker's password", async () => {
		expect(await firstConfirmationKeepsThePassword(false)).toStrictEqual({ passwordDeleted: true });
	});

	it("a writer who gives that session row the id set_by_session_id names keeps the password", async () => {
		expect(await firstConfirmationKeepsThePassword(true)).toStrictEqual({ passwordDeleted: false });
	});
});

const german = readFileSync(new URL("../VELVE-AUTH-ARCHITEKTUR.md", import.meta.url), "utf8");

describe("3.18 point 3 and the ninth INTEG requirement against a renamed session row", () => {
	it("bind the session id under the token mac or name it among the unbound columns", () => {
		const requirement =
			german
				.split("\n")
				.find((line) => line.startsWith(`- **${["S", "INTEG", "9"].join("-")}:**`)) ?? "";
		const point3 = german.split("\n").find((line) => line.startsWith("**3. Geschlüsselte")) ?? "";
		const limits = german.split("\n").find((line) => line.startsWith("**Die Grenzen.**")) ?? "";
		const namesTheId = /`session\.id`|Sitzungs-ID|ID der Sitzung/;
		expect(namesTheId.test(requirement) || namesTheId.test(point3) || namesTheId.test(limits)).toBe(
			true,
		);
	});
});
