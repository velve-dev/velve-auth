import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createPendingAuthenticationService,
	type PendingAuthenticationService,
} from "../src/core/factor/pending/index.js";
import { createUser, dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";

let connection: TestConnection;
let schema: string;
let pending: PendingAuthenticationService;
let userId: string;

beforeAll(async () => {
	const migrated = await openMigratedSchema("availablefactors");
	connection = migrated.connection;
	schema = migrated.schema;
	pending = createPendingAuthenticationService({ driver: connection, schema });
});

afterAll(async () => {
	await dropSchema(connection, schema);
	await connection.close();
});

beforeEach(async () => {
	userId = await createUser(connection, schema);
});

async function enrolTotp(confirmed: boolean): Promise<void> {
	await connection.query(
		`INSERT INTO ${schema}.totp_credential (user_id, secret_enc, key_version, confirmed_at)
		 VALUES ($1, $2, 1, ${confirmed ? "now()" : "NULL"})`,
		[userId, randomBytes(48)],
	);
}

async function enrolWebauthn(): Promise<void> {
	await connection.query(
		`INSERT INTO ${schema}.webauthn_credential
		   (user_id, credential_id, public_key, backup_eligible, backup_state, user_verified_at_registration)
		 VALUES ($1, $2, $3, false, false, true)`,
		[userId, randomBytes(32), randomBytes(64)],
	);
}

async function enrolRecoveryCodes(): Promise<void> {
	await connection.query(
		`INSERT INTO ${schema}.recovery_code (user_id, code_hmac) VALUES ($1, $2)`,
		[userId, randomBytes(32)],
	);
}

const ENROL_BY_FACTOR: Readonly<Record<string, () => Promise<void>>> = {
	totp: () => enrolTotp(true),
	webauthn: enrolWebauthn,
	recovery: enrolRecoveryCodes,
};

async function enrol(factors: readonly string[]): Promise<void> {
	for (const factor of factors) {
		await ENROL_BY_FACTOR[factor]?.();
	}
}

/** Every subset of the three, so no combination is the one nobody looked at. */
const EVERY_COMBINATION: readonly (readonly string[])[] = [
	[],
	["totp"],
	["webauthn"],
	["recovery"],
	["totp", "webauthn"],
	["totp", "recovery"],
	["webauthn", "recovery"],
	["totp", "webauthn", "recovery"],
];

describe("availableFactors is what the account actually has (3.15 C.1, 3.6)", () => {
	it.each(
		EVERY_COMBINATION.map((enrolled) => [enrolled.join("+") || "nothing", enrolled] as const),
	)("reports %s at the moment the state begins", async (_label, enrolled) => {
		await enrol(enrolled);

		const issued = await pending.begin({ userId, factorsCompleted: ["password"] });

		expect([...issued.pending.availableFactors].sort()).toStrictEqual([...enrolled].sort());
	});

	it("reports the same list when the state is read back as when it was written", async () => {
		await enrol(["totp", "recovery"]);

		const issued = await pending.begin({ userId, factorsCompleted: ["password"] });
		const resolved = await pending.resolve(issued.token);

		expect(issued.pending.availableFactors).toStrictEqual(resolved?.pending.availableFactors);
		expect(issued.pending.availableFactors).toStrictEqual(["totp", "recovery"]);
	});

	it("counts an unconfirmed TOTP enrolment as no factor", async () => {
		await enrolTotp(false);
		await enrolWebauthn();

		const issued = await pending.begin({ userId, factorsCompleted: ["password"] });

		expect(issued.pending.availableFactors).toStrictEqual(["webauthn"]);
	});

	it("reports an empty list for an account with no second factor at all", async () => {
		const issued = await pending.begin({ userId, factorsCompleted: ["password"] });

		expect(issued.pending.availableFactors).toStrictEqual([]);
	});

	/** E-735: no caller supplies the list, so no caller can name a factor the account does not have. */
	it("takes no availableFactors from its caller", async () => {
		const begin = pending.begin as unknown as (input: Record<string, unknown>) => Promise<{
			pending: { availableFactors: readonly string[] };
		}>;

		const issued = await begin({
			userId,
			factorsCompleted: ["password"],
			availableFactors: ["totp", "webauthn", "recovery"],
		});

		expect(issued.pending.availableFactors).toStrictEqual([]);
	});

	it("names the account of the row it wrote and no other", async () => {
		const other = await createUser(connection, schema);
		await connection.query(
			`INSERT INTO ${schema}.totp_credential (user_id, secret_enc, key_version, confirmed_at)
			 VALUES ($1, $2, 1, now())`,
			[other, randomBytes(48)],
		);

		const issued = await pending.begin({ userId, factorsCompleted: ["password"] });

		expect(issued.pending.availableFactors).toStrictEqual([]);
	});
});
