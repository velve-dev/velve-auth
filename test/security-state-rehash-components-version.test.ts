import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rootKeyProvider } from "../src/core/keys/index.js";
import type { SecurityStateRead } from "../src/core/security-state/read.js";
import {
	componentsAfter,
	type SealingChange,
	sealAccount,
} from "../src/core/security-state/sealing.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { generateRootKey } from "./keys-fixtures.js";
import { resealDirectly, seedAccount } from "./security-state-fixtures.js";

//only a rehash that changes nothing but the stored password hash keeps the components version (E-3600)

let connection: TestConnection;
let schema: string;
const keys = rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: generateRootKey() } });
const alarms = { raise: () => undefined };

beforeAll(async () => {
	({ connection, schema } = await openMigratedSchema("rehash_components"));
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function services() {
	return { driver: connection, schema, keys, sealing: "required" as const, anchors: [], alarms };
}

interface Replacement {
	readonly phc: Uint8Array<ArrayBuffer>;
	readonly setBySessionId: string | null;
	readonly disable: boolean;
}

function passwordReplacement(
	replacement: Replacement,
	restoresTheVerifiedPassword: boolean,
): SealingChange<null> {
	return {
		epoch: "keep",
		...(restoresTheVerifiedPassword ? { restoresTheVerifiedPassword: true as const } : {}),
		write: async (tx, read) => {
			await tx.query(
				`UPDATE ${schema}.password_credential SET phc = $2, set_by_session_id = $3 WHERE user_id = $1`,
				[read.userId, replacement.phc, replacement.setBySessionId],
			);
			if (replacement.disable) {
				await tx.query(`UPDATE ${schema}.user SET disabled_at = now() WHERE id = $1`, [
					read.userId,
				]);
			}
			return null;
		},
		after: (read: SecurityStateRead) => ({
			...componentsAfter(read, {
				password: {
					...(read.password as NonNullable<SecurityStateRead["password"]>),
					phc: replacement.phc,
					setBySessionId: replacement.setBySessionId,
				},
			}),
			disabled: replacement.disable || read.disabled,
		}),
	};
}

async function sealedAccount(): Promise<{ userId: string; componentsVersion: number }> {
	const userId = await seedAccount(connection, schema, { password: true });
	await resealDirectly(connection, schema, keys, userId);
	const [row] = await connection.query<{ components_version: string }>(
		`SELECT components_version::text FROM ${schema}.security_state WHERE user_id = $1`,
		[userId],
	);
	return { userId, componentsVersion: Number(row?.components_version) };
}

async function componentsVersionAcross(
	replacement: Partial<Replacement>,
	restoresTheVerifiedPassword: boolean,
): Promise<{ before: number; version: number; after: number }> {
	const account = await sealedAccount();
	const outcome = await sealAccount(
		services(),
		account.userId,
		passwordReplacement(
			{ phc: randomBytes(96), setBySessionId: null, disable: false, ...replacement },
			restoresTheVerifiedPassword,
		),
	);
	if (outcome.kind !== "sealed") {
		throw new Error(`the change was refused: ${outcome.reason}`);
	}
	return {
		before: account.componentsVersion,
		version: outcome.sealed.version,
		after: outcome.sealed.generations.componentsVersion,
	};
}

describe("the components version across a password hash replaced under the account lock", () => {
	it("stays where a rehash replaced the hash and nothing else", async () => {
		const seen = await componentsVersionAcross({}, true);
		expect(seen.version).toBeGreaterThan(seen.before);
		expect(seen.after).toBe(seen.before);
	});

	it("moves where the same hash is replaced by a change that is not a rehash", async () => {
		const seen = await componentsVersionAcross({}, false);
		expect(seen.after).toBe(seen.version);
	});

	it("moves where a rehash also changed who set the password", async () => {
		const seen = await componentsVersionAcross({ setBySessionId: randomUUID() }, true);
		expect(seen.after).toBe(seen.version);
	});

	it("moves where a rehash also changed another component", async () => {
		const seen = await componentsVersionAcross({ disable: true }, true);
		expect(seen.after).toBe(seen.version);
	});
});
