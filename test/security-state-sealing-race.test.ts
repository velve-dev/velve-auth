import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rootKeyProvider } from "../src/core/keys/index.js";
import {
	checkSecurityState,
	readSecurityState,
	sealedComponentsOf,
} from "../src/core/security-state/read.js";
import { type SealingChange, sealAccount } from "../src/core/security-state/sealing.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { generateRootKey } from "./keys-fixtures.js";
import { seedAccount } from "./security-state-fixtures.js";

//two changes of one account at once leave a valid seal and checks beside them refuse nothing, as T-INTEG-3 asks (E-3156)

const PAIRS = 50;
const CHECKS_PER_PAIR = 20;

let setup: TestConnection;
let first: TestConnection;
let second: TestConnection;
let checker: TestConnection;
let schema: string;
const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });

beforeAll(async () => {
	const migrated = await openMigratedSchema("seal_race");
	setup = migrated.connection;
	schema = migrated.schema;
	[first, second, checker] = await Promise.all([
		openTestConnection(),
		openTestConnection(),
		openTestConnection(),
	]);
});

afterAll(async () => {
	await Promise.all([first.close(), second.close(), checker.close()]);
	await dropSchema(setup, schema);
	await setup.close();
});

function services(driver: TestConnection) {
	return {
		driver,
		schema,
		keys,
		sealing: "migrating" as const,
		anchors: [],
		alarms: { raise: () => undefined },
	};
}

function passkeyRegistration(): SealingChange<null> {
	const credentialId = randomBytes(32);
	const publicKey = randomBytes(77);
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

function recoveryCodeGeneration(): SealingChange<null> {
	const codes = Array.from({ length: 10 }, () => randomBytes(32));
	return {
		epoch: "keep",
		write: async (tx, read) => {
			await tx.query(`DELETE FROM ${schema}.recovery_code WHERE user_id = $1`, [read.userId]);
			for (const code of codes) {
				await tx.query(
					`INSERT INTO ${schema}.recovery_code (user_id, code_hmac, key_version) VALUES ($1, $2, 1)`,
					[read.userId, code],
				);
			}
			return null;
		},
		after: (read) => ({
			...sealedComponentsOf(read),
			recoveryCodes: codes.map((codeHmac) => ({ keyVersion: 1, codeHmac })),
		}),
	};
}

describe("concurrent changes of one account (T-INTEG-3)", () => {
	it(`keeps the seal valid over ${PAIRS} pairs, raises the version by exactly two each time, and refuses none of the checks beside them`, async () => {
		const userId = await seedAccount(setup, schema, {
			password: true,
			passkeys: 1,
			recoveryCodes: 10,
		});
		await sealAccount(services(setup), userId, {
			epoch: "keep",
			write: async () => null,
			after: (read) => sealedComponentsOf(read),
		});
		const verdicts: string[] = [];
		const versions: number[] = [];

		for (let pair = 0; pair < PAIRS; pair += 1) {
			const checks = (async () => {
				for (let check = 0; check < CHECKS_PER_PAIR; check += 1) {
					const read = await readSecurityState(checker, schema, userId);
					verdicts.push(
						read === null ? "missing" : (await checkSecurityState(keys, read, "required")).verdict,
					);
				}
			})();
			const outcomes = await Promise.all([
				sealAccount(services(first), userId, passkeyRegistration()),
				sealAccount(services(second), userId, recoveryCodeGeneration()),
				checks,
			]);
			expect(outcomes[0].kind).toBe("sealed");
			expect(outcomes[1].kind).toBe("sealed");
			const read = await readSecurityState(setup, schema, userId);
			if (read === null) {
				throw new Error("the account vanished");
			}
			expect((await checkSecurityState(keys, read, "required")).verdict).toBe("valid");
			versions.push(read.seal?.version ?? 0);
		}

		expect(versions).toEqual(Array.from({ length: PAIRS }, (_, pair) => 1 + 2 * (pair + 1)));
		expect(verdicts).toHaveLength(PAIRS * CHECKS_PER_PAIR);
		expect(verdicts.filter((verdict) => verdict !== "valid")).toEqual([]);
	});
});
