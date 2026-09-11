import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { createRecoveryCodeService } from "../src/core/factor/recovery/index.js";
import {
	assertStoredFactorKeyVersionsAreKnown,
	FactorKeyRingError,
	type FactorKeyVersionCheckOptions,
	type StoredFactorKeyVersions,
} from "../src/core/factor/startup.js";
import { createTotpService, timeStepAt, totpCodeForStep } from "../src/core/factor/totp/index.js";
import { toVisibleFailure } from "../src/core/http/error-map.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import { createVelveAuth } from "../src/index.js";
import { createTestClock } from "../src/testing/index.js";
import { configFor } from "./auth-fixtures.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import {
	beginPendingState,
	enrolConfirmedCredential,
	pendingAuthenticationsOn,
	testKeyRing,
} from "./totp-fixtures.js";

let connection: TestConnection;
let schema: string;

const ring = testKeyRing(2);
const bothVersions: KeyProvider = ring.providerAt(1, [1, 2]);
const withoutVersionOne: KeyProvider = ring.providerAt(2, [2]);

beforeAll(async () => {
	const migrated = await openMigratedSchema("factorkeyring");
	connection = migrated.connection;
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

function recoveryOn(keys: KeyProvider) {
	return createRecoveryCodeService({
		driver: connection,
		schema,
		keys,
		pending: pendingAuthenticationsOn(connection, schema),
	});
}

async function accountWithBothFactorsUnderVersionOne(): Promise<{
	userId: string;
	secretBytes: Uint8Array<ArrayBuffer>;
	codes: readonly string[];
}> {
	const userId = await createUser(connection, schema);
	const secretBytes = await enrolConfirmedCredential(connection, schema, bothVersions, userId);
	const { codes } = await recoveryOn(bothVersions).generate({ actor: actorOfTestUser(userId) });
	return { userId, secretBytes, codes };
}

async function refusalFrom(check: Promise<void>): Promise<FactorKeyRingError | null> {
	return check.then(
		() => null,
		(failure: unknown) => (failure instanceof FactorKeyRingError ? failure : null),
	);
}

/**
 * E-179 put the "a stored key version has left the ring" report at assembly for passwords, and
 * E-428 handed the same report over for TOTP secrets and it was never built. L-3 puts
 * `recovery_code` in the same class, and in `identity: "username"` that is the only way back in.
 */
describe("a second-factor key version that has left the ring is a start error", () => {
	it("passes on empty tables, so a fresh installation is not refused", async () => {
		await expect(
			assertStoredFactorKeyVersionsAreKnown({ driver: connection, schema, keys: bothVersions }),
		).resolves.toBeUndefined();
	});

	it("passes while every stored version is still held", async () => {
		await accountWithBothFactorsUnderVersionOne();

		await expect(
			assertStoredFactorKeyVersionsAreKnown({ driver: connection, schema, keys: bothVersions }),
		).resolves.toBeUndefined();
	});

	it("names both tables, both purposes and the version, and nothing else", async () => {
		await accountWithBothFactorsUnderVersionOne();
		const options: FactorKeyVersionCheckOptions = {
			driver: connection,
			schema,
			keys: withoutVersionOne,
		};

		const refused = await refusalFrom(assertStoredFactorKeyVersionsAreKnown(options));

		const expected: readonly StoredFactorKeyVersions[] = [
			{ table: "totp_credential", purpose: "totp-enc", missingVersions: [1] },
			{ table: "recovery_code", purpose: "token-pepper", missingVersions: [1] },
		];
		expect(refused?.code).toBe("stored_key_version_unknown");
		expect(refused?.missing).toStrictEqual(expected);
		expect(refused?.message).toContain("totp-enc key version 1");
		expect(refused?.message).toContain("token-pepper key version 1");
	});

	/**
	 * This is what the check exists for: on the request path the loss is concealed on purpose, so
	 * an operator who drops a version learns of it from users and from nowhere else (E-428).
	 */
	it("is the only signal, because both factors answer a dropped version as a wrong one", async () => {
		const account = await accountWithBothFactorsUnderVersionOne();
		const pending = pendingAuthenticationsOn(connection, schema);
		const totp = createTotpService({
			driver: connection,
			schema,
			keys: withoutVersionOne,
			pending,
			issuer: "Velve",
			clock: createTestClock(),
		});

		const totpToken = (await beginPendingState(pending, account.userId)).token;
		const totpFailure = await totp
			.verify({ pendingToken: totpToken, code: "000000" })
			.then(() => null)
			.catch((cause: unknown) => toVisibleFailure(cause));

		const recoveryToken = (await beginPendingState(pending, account.userId)).token;
		const recoveryFailure = await recoveryOn(withoutVersionOne)
			.verify({ pendingToken: recoveryToken, code: account.codes[0] ?? "" })
			.then(() => null)
			.catch((cause: unknown) => toVisibleFailure(cause));

		expect(`${totpFailure?.error.httpStatus} ${totpFailure?.error.code}`).toBe(
			"401 invalid_factor_code",
		);
		expect(`${recoveryFailure?.error.httpStatus} ${recoveryFailure?.error.code}`).toBe(
			"401 invalid_recovery_code",
		);
	});

	/**
	 * The mechanism above is reachable from a test and from nothing else until `migrate()` calls
	 * it, which is the state E-428 calls worth nothing and E-1698 left the check in. This drives
	 * the public entry point rather than the module, so removing the call reddens it.
	 */
	it("is reached by migrate() and not only by a caller who knows it exists", async () => {
		await accountWithBothFactorsUnderVersionOne();
		const auth = createVelveAuth(
			configFor({ database: connection as Driver, schema, keys: withoutVersionOne }),
		);

		const refused = await refusalFrom(auth.migrate().then(() => undefined));

		expect(refused?.code).toBe("stored_key_version_unknown");
		expect(refused?.missing.map((entry) => entry.table)).toStrictEqual([
			"totp_credential",
			"recovery_code",
		]);
	});

	it("lets migrate() through while the ring still holds every stored version", async () => {
		await accountWithBothFactorsUnderVersionOne();
		const auth = createVelveAuth(
			configFor({ database: connection as Driver, schema, keys: bothVersions }),
		);

		await expect(auth.migrate()).resolves.toBeDefined();
	});

	/**
	 * The asymmetry with the password case: a password lockout heals itself through a reset, and
	 * `factor.totp.remove` (3.15 B.6) demands the code the dropped key made unreadable, so the
	 * account cannot put the broken factor down either (E-1697).
	 */
	it("leaves the user unable to remove the factor they can no longer pass", async () => {
		const account = await accountWithBothFactorsUnderVersionOne();
		const clock = createTestClock();
		const totp = createTotpService({
			driver: connection,
			schema,
			keys: withoutVersionOne,
			pending: pendingAuthenticationsOn(connection, schema),
			issuer: "Velve",
			clock,
		});

		const removal = await totp
			.remove({
				actor: actorOfTestUser(account.userId),
				code: totpCodeForStep(account.secretBytes, timeStepAt(clock.now())),
			})
			.then(() => null)
			.catch((cause: unknown) => toVisibleFailure(cause));

		expect(`${removal?.error.httpStatus} ${removal?.error.code}`).toBe("401 invalid_factor_code");
	});
});
