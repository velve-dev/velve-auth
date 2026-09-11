import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import {
	type PendingAuthenticationService,
	type PendingResolution,
	verifyUnderPendingAttemptLimit,
} from "../src/core/factor/pending/index.js";
import {
	createRecoveryCodeRepository,
	createRecoveryCodeService,
	createRecoveryCodeSet,
	formatRecoveryCode,
	normaliseRecoveryCode,
	type PepperedRecoveryCode,
	RECOVERY_CODE_COUNT,
	RECOVERY_CODE_GROUP_LENGTH,
	RecoveryCodeOwnerUnknownError,
	type RecoveryCodeRepository,
	type RecoveryCodeRepositoryOptions,
	type RecoveryCodeService,
	type RecoveryCodeServiceOptions,
} from "../src/core/factor/recovery/index.js";
import {
	createTotpRepository,
	createTotpService,
	type StoredTotpCredential,
	type TimeStepClaim,
	TOTP_DIGITS,
	type TotpCredentialInsert,
	type TotpEnrollment,
	type TotpRepository,
	type TotpRepositoryOptions,
	type TotpService,
	type TotpServiceOptions,
} from "../src/core/factor/totp/index.js";
import { actorOfTestUser, createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { pendingAuthenticationsOn, testKeyProvider } from "./totp-fixtures.js";

let connection: TestConnection;
let schema: string;
let pending: PendingAuthenticationService;

beforeAll(async () => {
	const migrated = await openMigratedSchema("totp_surface");
	connection = migrated.connection;
	schema = migrated.schema;
	pending = pendingAuthenticationsOn(connection, schema);
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

/**
 * The two barrels are what the instance consumes, so every name they publish is pinned here.
 * E-201 set the precedent: a type nothing in `src/` annotates yet is named in a test rather than
 * withheld, because withholding it means digging it out again at the call site.
 */
describe("the surface the TOTP module publishes", () => {
	it("takes a clock it cannot default, and a pending service to spend attempts on", () => {
		expectTypeOf<keyof TotpServiceOptions>().toEqualTypeOf<
			"driver" | "keys" | "pending" | "issuer" | "clock" | "schema" | "toleranceInSteps"
		>();
		expectTypeOf<TotpServiceOptions["clock"]>().not.toBeUndefined();
		expectTypeOf<keyof TotpRepositoryOptions>().toEqualTypeOf<"driver" | "schema">();
	});

	it("reaches the credential through an owner where a session proves it and through an id where a pending state does", () => {
		expectTypeOf<TotpService["remove"]>().parameter(0).toHaveProperty("actor");
		expectTypeOf<TotpCredentialInsert["actor"]>().toEqualTypeOf<Actor>();
		expectTypeOf<TotpRepository["findCredentialOf"]>().parameter(0).toHaveProperty("userId");
		expectTypeOf<TimeStepClaim["timeStep"]>().toBeNumber();
		expectTypeOf<StoredTotpCredential["confirmedAt"]>().toEqualTypeOf<Date | null>();
	});

	it("answers a verification with the resolution rather than with nothing (E-410)", () => {
		expectTypeOf<TotpService["verify"]>().returns.resolves.toEqualTypeOf<PendingResolution>();
		expectTypeOf<
			RecoveryCodeService["verify"]
		>().returns.resolves.toEqualTypeOf<PendingResolution>();
	});

	it("hands out the secret in the two forms an authenticator can take it", () => {
		expectTypeOf<TotpEnrollment>().toEqualTypeOf<{
			readonly secretBase32: string;
			readonly otpauthUri: string;
		}>();
		expect(TOTP_DIGITS).toBe(6);
	});

	it("builds a repository and a service from the barrel alone", () => {
		expectTypeOf(createTotpRepository).toBeFunction();
		expectTypeOf(createTotpService).toBeFunction();
		expectTypeOf(verifyUnderPendingAttemptLimit).toBeFunction();
	});
});

describe("the surface the recovery module publishes", () => {
	it("takes the same three collaborators the TOTP service takes, without a clock", () => {
		expectTypeOf<keyof RecoveryCodeServiceOptions>().toEqualTypeOf<
			"driver" | "keys" | "pending" | "schema"
		>();
		expectTypeOf<keyof RecoveryCodeRepositoryOptions>().toEqualTypeOf<"driver" | "schema">();
		expectTypeOf<RecoveryCodeRepository["consumeCode"]>().toBeFunction();
		expectTypeOf<PepperedRecoveryCode["keyVersion"]>().toBeNumber();
		expectTypeOf(createRecoveryCodeRepository).toBeFunction();
	});

	it("puts the groups back on a canonical code", () => {
		const [code] = createRecoveryCodeSet();
		const canonical = normaliseRecoveryCode(code ?? "");

		expect(formatRecoveryCode(canonical)).toBe(code);
		expect(formatRecoveryCode(canonical).split("-")).toHaveLength(
			canonical.length / RECOVERY_CODE_GROUP_LENGTH,
		);
	});

	it("refuses to write a set for an account that is not there", async () => {
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);
		const recovery = createRecoveryCodeService({
			driver: connection,
			schema,
			keys: testKeyProvider(),
			pending,
		});

		await recovery.generate({ actor });
		expect(await recovery.remaining({ actor })).toEqual({ remainingCount: RECOVERY_CODE_COUNT });

		await connection.query(`DELETE FROM ${schema}.user WHERE id = $1`, [userId]);

		await expect(recovery.generate({ actor })).rejects.toBeInstanceOf(
			RecoveryCodeOwnerUnknownError,
		);
	});

	it("names the account nowhere in what that refusal says", async () => {
		const userId = await createUser(connection, schema);
		const actor = actorOfTestUser(userId);
		const recovery = createRecoveryCodeService({
			driver: connection,
			schema,
			keys: testKeyProvider(),
			pending,
		});
		await connection.query(`DELETE FROM ${schema}.user WHERE id = $1`, [userId]);

		const refusal = await recovery.generate({ actor }).catch((failure: unknown) => failure);

		expect(refusal).toBeInstanceOf(RecoveryCodeOwnerUnknownError);
		expect((refusal as Error).message).not.toContain(userId);
		expect((refusal as RecoveryCodeOwnerUnknownError).code).toBe("recovery_code_owner_unknown");
	});
});
