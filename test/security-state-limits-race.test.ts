import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VelveError } from "../src/core/http/error-map.js";
import { rootKeyProvider } from "../src/core/keys/index.js";
import {
	assertBelowCredentialLimit,
	type LimitsConfig,
	resolveLimits,
} from "../src/core/security-state/limits.js";
import { readSecurityState, sealedComponentsOf } from "../src/core/security-state/read.js";
import { type SealingChange, sealAccount } from "../src/core/security-state/sealing.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { generateRootKey } from "./keys-fixtures.js";
import { seedAccount } from "./security-state-fixtures.js";

//the limits of T-INTEG-10 checked on the read the account lock protects (E-3158)

let setup: TestConnection;
let first: TestConnection;
let second: TestConnection;
let schema: string;
const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
const limits = resolveLimits(undefined) as LimitsConfig;

beforeAll(async () => {
	const migrated = await openMigratedSchema("seal_limits");
	setup = migrated.connection;
	schema = migrated.schema;
	[first, second] = await Promise.all([openTestConnection(), openTestConnection()]);
});

afterAll(async () => {
	await Promise.all([first.close(), second.close()]);
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
			assertBelowCredentialLimit(read, "passkey", limits);
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

function identityLink(): SealingChange<null> {
	const subject = randomUUID();
	return {
		epoch: "keep",
		write: async (tx, read) => {
			assertBelowCredentialLimit(read, "identity", limits);
			await tx.query(
				`INSERT INTO ${schema}.identity (user_id, provider, subject) VALUES ($1, 'github', $2)`,
				[read.userId, subject],
			);
			return null;
		},
		after: (read) => {
			const components = sealedComponentsOf(read);
			return {
				...components,
				identities: [...components.identities, { provider: "github", subject }],
			};
		},
	};
}

async function countsOf(userId: string) {
	const read = await readSecurityState(setup, schema, userId);
	return { passkeys: read?.passkeys.length, identities: read?.identities.length };
}

describe("the configured limits", () => {
	it("default to 20 passkeys and 10 identities and take a configured count", () => {
		expect(resolveLimits(undefined)).toEqual({ passkeysPerAccount: 20, identitiesPerAccount: 10 });
		expect(resolveLimits({ passkeysPerAccount: 5 })).toEqual({
			passkeysPerAccount: 5,
			identitiesPerAccount: 10,
		});
	});

	it("refuse a limit that is no count of at least one", () => {
		for (const value of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
			expect(resolveLimits({ passkeysPerAccount: value })).toBeNull();
			expect(resolveLimits({ identitiesPerAccount: value })).toBeNull();
		}
	});
});

describe("a registration or a link over the limit (T-INTEG-10)", () => {
	it("refuses the 21st passkey and the 11th identity and writes neither", async () => {
		const userId = await seedAccount(setup, schema, {
			password: true,
			passkeys: 20,
			identities: 10,
		});

		await expect(sealAccount(services(first), userId, passkeyRegistration())).rejects.toEqual(
			new VelveError("passkey_limit_reached"),
		);
		await expect(sealAccount(services(first), userId, identityLink())).rejects.toEqual(
			new VelveError("identity_limit_reached"),
		);
		expect(await countsOf(userId)).toEqual({ passkeys: 20, identities: 10 });
	});

	it("lets exactly one of two simultaneous registrations at 19 passkeys through", async () => {
		const userId = await seedAccount(setup, schema, { password: true, passkeys: 19 });

		const outcomes = await Promise.allSettled([
			sealAccount(services(first), userId, passkeyRegistration()),
			sealAccount(services(second), userId, passkeyRegistration()),
		]);

		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([
			{ status: "rejected", reason: new VelveError("passkey_limit_reached") },
		]);
		expect((await countsOf(userId)).passkeys).toBe(20);
	});

	it("lets exactly one of two simultaneous links at 9 identities through", async () => {
		const userId = await seedAccount(setup, schema, { password: true, identities: 9 });

		const outcomes = await Promise.allSettled([
			sealAccount(services(first), userId, identityLink()),
			sealAccount(services(second), userId, identityLink()),
		]);

		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect((await countsOf(userId)).identities).toBe(10);
	});
});
