import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import { createOneTimeTokens } from "../src/core/token/one-time-token.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { decodingJsonb } from "./jsonb-decoding-driver.js";
import { testKeyRing } from "./totp-fixtures.js";

//one stored payload gets one verdict whatever form the driver hands jsonb back in (S-INTEG-9)

let migrated: MigratedSchema;
let schema: string;
const keys = testKeyRing(1).providerAt(1);

beforeAll(async () => {
	migrated = await openMigratedSchema("integ_token_payload_text");
	schema = migrated.schema;
});

afterAll(async () => {
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

async function redeemedThrough(driver: Driver): Promise<boolean> {
	const userId = await createUser(migrated.connection, schema);
	const tokens = createOneTimeTokens(createOneTimeTokenRepository({ driver, schema }), { keys });
	const { token } = await tokens.issue({
		purpose: "email_change",
		userId,
		payload: { email: "new@example.com", accountEmail: "old@example.com" },
	});
	await migrated.connection.query(
		`UPDATE ${schema}.one_time_token SET payload = to_jsonb(payload::text) WHERE user_id = $1`,
		[userId],
	);
	return (await tokens.redeem({ token, purpose: "email_change" })) !== null;
}

describe("a payload rewritten into a jsonb string of its own text (S-INTEG-9)", () => {
	it("is refused under a jsonb-decoding driver, as it is under a text driver", async () => {
		const underText = await redeemedThrough(migrated.connection);
		const underDecoding = await redeemedThrough(decodingJsonb(migrated.connection));

		expect({ underText, underDecoding }).toStrictEqual({ underText: false, underDecoding: false });
	});
});
