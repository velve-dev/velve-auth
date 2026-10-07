import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockAccountRowStatement } from "../src/core/db/lock.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";

//a legitimate rebind of the kept session is not held off by the account lock and makes the keeping swap miss, which a re-read tells apart (E-3362)

let keeping: TestConnection;
let resolving: TestConnection;
let schema: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("kept_session_rebind");
	keeping = migrated.connection;
	schema = migrated.schema;
	resolving = await openTestConnection();
	await keeping.query(`ALTER TABLE ${schema}.session ADD COLUMN token_mac bytea`, []);
	await resolving.query("SET lock_timeout = '2s'", []);
});

afterAll(async () => {
	await dropSchema(keeping, schema);
	await keeping.close();
	await resolving.close();
});

async function keptSwapAgainstAConcurrentResolutionRebind() {
	const userId = await createUser(keeping, schema);
	const oldMac = randomBytes(32);
	const [row] = await keeping.query<{ id: string }>(
		`INSERT INTO ${schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at, token_mac)
		 VALUES ($1, $2, now() + interval '1 hour', now() + interval '1 day', $3) RETURNING id`,
		[userId, randomBytes(32), oldMac],
	);
	await keeping.query("BEGIN ISOLATION LEVEL READ COMMITTED", []);
	try {
		await keeping.query(lockAccountRowStatement(schema), [userId]);
		const [checked] = await keeping.query<{ token_mac: Buffer }>(
			`SELECT token_mac FROM ${schema}.session WHERE id = $1`,
			[row?.id],
		);
		const rebound = await resolving.query(
			`UPDATE ${schema}.session SET token_mac = $3 WHERE id = $1 AND token_mac = $2 RETURNING id`,
			[row?.id, oldMac, randomBytes(32)],
		);
		const swapped = await keeping.query(
			`UPDATE ${schema}.session SET token_mac = $3 WHERE id = $1 AND token_mac = $2 RETURNING id`,
			[row?.id, checked?.token_mac, randomBytes(32)],
		);
		return { resolutionRebound: rebound.length, keepingSwapHit: swapped.length };
	} finally {
		await keeping.query("ROLLBACK", []);
	}
}

describe("premise: revokeAllOther's swap on the kept session against a resolution's rebind", () => {
	it("misses, because the rebind takes no account lock and commits while the lock is held", async () => {
		expect(await keptSwapAgainstAConcurrentResolutionRebind()).toStrictEqual({
			resolutionRebound: 1,
			keepingSwapHit: 0,
		});
	});
});

const german = readFileSync(new URL("../VELVE-AUTH-ARCHITEKTUR.md", import.meta.url), "utf8");

describe("3.18 Versiegeln on a kept session whose swap misses", () => {
	it("does not call a legitimate rebind of the kept session an alarm", () => {
		const sealing = german.split("\n").find((line) => line.startsWith("*Versiegeln.*")) ?? "";
		const start = sealing.indexOf("Eine behaltene Sitzung");
		const kept = sealing.slice(start, sealing.indexOf("Sonst höbe", start));
		const alarmsEveryMiss = /oder trifft der Tausch keine Zeile[^.]*Alarm/.test(kept);
		const exemptsARebind = /(neu gebunden|Neubinden|Neubindung)[^.]*ohne Alarm/.test(kept);
		expect({ alarmsEveryMiss, exemptsARebind }).toStrictEqual({
			alarmsEveryMiss: false,
			exemptsARebind: true,
		});
	});
});
