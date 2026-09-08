import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PendingAuthenticationService } from "../src/core/factor/pending/index.js";
import {
	createRecoveryCodeSet,
	normaliseRecoveryCode,
	RECOVERY_CODE_COUNT,
	RECOVERY_CODE_ENTROPY_BYTES,
	RECOVERY_CODE_GROUP_LENGTH,
} from "../src/core/factor/recovery/code.js";
import { pepperRecoveryCode } from "../src/core/factor/recovery/pepper.js";
import {
	createRecoveryCodeService,
	type RecoveryCodeService,
} from "../src/core/factor/recovery/service.js";
import { toVisibleFailure } from "../src/core/http/error-map.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import {
	beginPendingState,
	pendingAuthenticationsOn,
	testKeyProvider,
	testKeyRing,
} from "./totp-fixtures.js";

let connection: TestConnection;
let schema: string;
let keys: KeyProvider;
let pending: PendingAuthenticationService;
let recovery: RecoveryCodeService;

interface StoredCode {
	code_hmac: Uint8Array;
	key_version: number;
}

async function readStoredCodes(userId: string): Promise<StoredCode[]> {
	return connection.query<StoredCode>(
		`SELECT code_hmac, key_version FROM ${schema}.recovery_code WHERE user_id = $1`,
		[userId],
	);
}

beforeAll(async () => {
	const migrated = await openMigratedSchema("recovery_codes");
	connection = migrated.connection;
	schema = migrated.schema;
	keys = testKeyProvider();
	pending = pendingAuthenticationsOn(connection, schema);
	recovery = createRecoveryCodeService({ driver: connection, schema, keys, pending });
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

describe("S-RAND-3: ten codes of 160 bit, pairwise distinct, shown in groups", () => {
	it("hands out exactly ten", async () => {
		const actor = actorOfTestUser(await createUser(connection, schema));
		const { codes } = await recovery.generate({ actor });
		expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
	});

	it("carries 160 bit in each, as a base32 alphabet of 32 characters over 32 places", () => {
		expect(RECOVERY_CODE_ENTROPY_BYTES * 8).toBe(160);
		for (const code of createRecoveryCodeSet()) {
			expect(normaliseRecoveryCode(code)).toHaveLength((RECOVERY_CODE_ENTROPY_BYTES * 8) / 5);
		}
	});

	it("shows them in groups", () => {
		for (const code of createRecoveryCodeSet()) {
			const groups = code.split("-");
			expect(groups).toHaveLength(32 / RECOVERY_CODE_GROUP_LENGTH);
			for (const group of groups) {
				expect(group).toHaveLength(RECOVERY_CODE_GROUP_LENGTH);
			}
		}
	});

	it("is pairwise distinct within a set and across sets", () => {
		const seen = new Set<string>();
		for (let round = 0; round < 200; round += 1) {
			const set = createRecoveryCodeSet();
			expect(new Set(set).size).toBe(RECOVERY_CODE_COUNT);
			for (const code of set) {
				seen.add(code);
			}
		}
		expect(seen.size).toBe(200 * RECOVERY_CODE_COUNT);
	});

	it("uses no character a reader can mistake for another", () => {
		for (const code of createRecoveryCodeSet()) {
			expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z-]+$/);
			expect(code).not.toMatch(/[ILOU]/);
		}
	});

	it("reads a code back however it was retyped", () => {
		const [code] = createRecoveryCodeSet();
		const canonical = normaliseRecoveryCode(code ?? "");
		expect(normaliseRecoveryCode(canonical.toLowerCase())).toBe(canonical);
		expect(normaliseRecoveryCode(canonical.replace(/(.{4})/g, "$1 "))).toBe(canonical);
		expect(normaliseRecoveryCode(canonical.replace(/0/g, "O").replace(/1/g, "l"))).toBe(canonical);
	});
});

describe("S-REST-3: the stored form is an HMAC and display is impossible", () => {
	it("stores one row per code, keyed by the HMAC, with the pepper version beside it", async () => {
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);
		const { codes } = await recovery.generate({ actor });

		const stored = await readStoredCodes(userId);
		expect(stored).toHaveLength(RECOVERY_CODE_COUNT);

		const current = await keys.current("token-pepper");
		for (const row of stored) {
			expect(row.key_version).toBe(current.version);
			expect(row.code_hmac).toHaveLength(32);
		}

		const storedHmacs = new Set(stored.map((row) => Buffer.from(row.code_hmac).toString("hex")));
		for (const code of codes) {
			const { codeHmac } = await pepperRecoveryCode(keys, code);
			expect(storedHmacs.has(Buffer.from(codeHmac).toString("hex"))).toBe(true);
		}
	});

	it("keeps no code and no fragment of one in the row (S-REST-1)", async () => {
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);
		const { codes } = await recovery.generate({ actor });

		const dumped = (await readStoredCodes(userId))
			.map((row) => Buffer.from(row.code_hmac))
			.map(
				(value) =>
					`${value.toString("latin1")}|${value.toString("base64")}|${value.toString("hex")}`,
			)
			.join("\n");

		for (const code of codes) {
			const canonical = normaliseRecoveryCode(code);
			expect(dumped).not.toContain(code);
			expect(dumped).not.toContain(canonical);
			expect(dumped).not.toContain(Buffer.from(canonical).toString("base64"));
		}
	});

	it("offers only a count, never the codes (3.15 B.6)", async () => {
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);
		await recovery.generate({ actor });

		const remaining = await recovery.remaining({ actor });
		expect(remaining).toEqual({ remainingCount: RECOVERY_CODE_COUNT });
		expect(Object.keys(remaining)).toEqual(["remainingCount"]);
	});
});

describe("consumption is a DELETE … RETURNING on one row (S-RACE-4, 3.6)", () => {
	it("spends the code that was used and leaves the other nine", async () => {
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);
		const { codes } = await recovery.generate({ actor });
		const [first] = codes;

		await recovery.verify({
			pendingToken: (await beginPendingState(pending, userId)).token,
			code: first ?? "",
		});

		expect(await recovery.remaining({ actor })).toEqual({ remainingCount: 9 });
	});

	it("refuses the same code a second time", async () => {
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);
		const { codes } = await recovery.generate({ actor });
		const [first] = codes;

		await recovery.verify({
			pendingToken: (await beginPendingState(pending, userId)).token,
			code: first ?? "",
		});
		await expect(
			recovery.verify({
				pendingToken: (await beginPendingState(pending, userId)).token,
				code: first ?? "",
			}),
		).rejects.toMatchObject({ reason: "recovery_code_not_found" });
	});

	it("accepts a code retyped in lower case and without its groups", async () => {
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);
		const { codes } = await recovery.generate({ actor });
		const [first] = codes;

		await recovery.verify({
			pendingToken: (await beginPendingState(pending, userId)).token,
			code: normaliseRecoveryCode(first ?? "").toLowerCase(),
		});
		expect(await recovery.remaining({ actor })).toEqual({ remainingCount: 9 });
	});

	it("refuses a code belonging to another account", async () => {
		const owner = await createUser(connection, schema);
		const stranger = await createUser(connection, schema);
		const { codes } = await recovery.generate({ actor: actorOfTestUser(owner) });
		await recovery.generate({ actor: actorOfTestUser(stranger) });

		await expect(
			recovery.verify({
				pendingToken: (await beginPendingState(pending, stranger)).token,
				code: codes[0] ?? "",
			}),
		).rejects.toMatchObject({ reason: "recovery_code_not_found" });
		expect(await recovery.remaining({ actor: actorOfTestUser(owner) })).toEqual({
			remainingCount: RECOVERY_CODE_COUNT,
		});
	});

	it("answers an account that never generated a set the way it answers a wrong code", async () => {
		const never = await createUser(connection, schema);
		const withCodes = await createUser(connection, schema);
		await recovery.generate({ actor: actorOfTestUser(withCodes) });

		const missing = await recovery
			.verify({
				pendingToken: (await beginPendingState(pending, never)).token,
				code: "AAAAAAAA-AAAAAAAA-AAAAAAAA-AAAAAAAA",
			})
			.then(() => null)
			.catch((cause: unknown) => toVisibleFailure(cause));
		const wrong = await recovery
			.verify({
				pendingToken: (await beginPendingState(pending, withCodes)).token,
				code: "AAAAAAAA-AAAAAAAA-AAAAAAAA-AAAAAAAA",
			})
			.then(() => null)
			.catch((cause: unknown) => toVisibleFailure(cause));

		expect(missing?.error.code).toBe("invalid_recovery_code");
		expect(missing?.error.code).toBe(wrong?.error.code);
		expect(missing?.error.message).toBe(wrong?.error.message);
		expect(missing?.error.httpStatus).toBe(401);
		expect(missing?.loggedReason).toBe("recovery_codes_never_generated");
		expect(wrong?.loggedReason).toBe("recovery_code_not_found");
	});
});

describe("generate replaces the whole set (3.15 B.6)", () => {
	it("deletes every earlier code, including the ones already spent from", async () => {
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);
		const first = await recovery.generate({ actor });
		await recovery.verify({
			pendingToken: (await beginPendingState(pending, userId)).token,
			code: first.codes[0] ?? "",
		});

		const second = await recovery.generate({ actor });

		expect(await recovery.remaining({ actor })).toEqual({ remainingCount: RECOVERY_CODE_COUNT });
		expect(new Set(second.codes)).not.toEqual(new Set(first.codes));
		await expect(
			recovery.verify({
				pendingToken: (await beginPendingState(pending, userId)).token,
				code: first.codes[1] ?? "",
			}),
		).rejects.toMatchObject({ reason: "recovery_code_not_found" });
	});

	it("takes the codes with the account (S-TOKEN-5)", async () => {
		const userId = await createUser(connection, schema);
		await recovery.generate({ actor: actorOfTestUser(userId) });
		await connection.query(`DELETE FROM ${schema}.user WHERE id = $1`, [userId]);

		expect(await readStoredCodes(userId)).toHaveLength(0);
	});
});

describe("L-3: the pepper version travels with the code", () => {
	it("still finds a code written under a version that is no longer current", async () => {
		const ring = testKeyRing(2);
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);

		const beforeRotation = createRecoveryCodeService({
			driver: connection,
			schema,
			pending,
			keys: ring.providerAt(1, [1]),
		});
		const { codes } = await beforeRotation.generate({ actor });
		expect(new Set((await readStoredCodes(userId)).map((row) => row.key_version))).toEqual(
			new Set([1]),
		);

		const afterRotation = createRecoveryCodeService({
			driver: connection,
			schema,
			pending,
			keys: ring.providerAt(2),
		});
		await afterRotation.verify({
			pendingToken: (await beginPendingState(pending, userId)).token,
			code: codes[0] ?? "",
		});

		expect(await afterRotation.remaining({ actor })).toEqual({ remainingCount: 9 });
	});

	it("writes the new version once the set is regenerated", async () => {
		const ring = testKeyRing(2);
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);

		await createRecoveryCodeService({
			driver: connection,
			schema,
			pending,
			keys: ring.providerAt(1, [1]),
		}).generate({ actor });
		await createRecoveryCodeService({
			driver: connection,
			schema,
			pending,
			keys: ring.providerAt(2),
		}).generate({ actor });

		expect(new Set((await readStoredCodes(userId)).map((row) => row.key_version))).toEqual(
			new Set([2]),
		);
	});

	it("answers a code whose version has left the ring the way it answers a wrong code (S-KEY-4)", async () => {
		const ring = testKeyRing(2);
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);

		const { codes } = await createRecoveryCodeService({
			driver: connection,
			schema,
			pending,
			keys: ring.providerAt(1, [1]),
		}).generate({ actor });

		const withoutTheOldVersion = createRecoveryCodeService({
			driver: connection,
			schema,
			pending,
			keys: ring.providerAt(2, [2]),
		});
		const failure = await withoutTheOldVersion
			.verify({
				pendingToken: (await beginPendingState(pending, userId)).token,
				code: codes[0] ?? "",
			})
			.then(() => null)
			.catch((cause: unknown) => toVisibleFailure(cause));

		expect(failure?.error.code).toBe("invalid_recovery_code");
		expect(failure?.loggedReason).toBe("recovery_codes_never_generated");
		expect(await withoutTheOldVersion.remaining({ actor })).toEqual({
			remainingCount: RECOVERY_CODE_COUNT,
		});
	});
});
