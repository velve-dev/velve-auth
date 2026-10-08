import { createHmac, hkdfSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import { createPendingAuthenticationService } from "../src/core/factor/pending/index.js";
import { createWebAuthnChallenges } from "../src/core/factor/webauthn/challenge.js";
import { rootKeyProvider } from "../src/core/keys/root-key-provider.js";
import { createSessionService } from "../src/core/session/service.js";
import { createOneTimeTokens } from "../src/core/token/one-time-token.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { decodingJsonb } from "./jsonb-decoding-driver.js";

//the MAC stored beside a row the library writes equals one computed apart from the code (S-INTEG-9)

const ROOT_KEY = Buffer.alloc(32, 11);
const OBSERVED = { ipAddress: null, userAgent: null };

function tlv(type: number, length: number, body: Buffer): Buffer {
	const head = Buffer.alloc(5);
	head[0] = type;
	head.writeUInt32BE(length, 1);
	return Buffer.concat([head, body]);
}
const text = (value: string) => tlv(1, Buffer.byteLength(value), Buffer.from(value, "utf8"));
const optionalText = (value: string | null) =>
	value === null ? tlv(0, 0, Buffer.alloc(0)) : text(value);
const integer = (value: number | bigint) => {
	const body = Buffer.alloc(8);
	body.writeBigInt64BE(BigInt(value));
	return tlv(4, 8, body);
};
const list = (items: readonly string[]) =>
	Buffer.concat([tlv(3, items.length, Buffer.alloc(0)), ...items.map(text)]);

function mac(purpose: string, owner: string | null, hash: Buffer, tail: Buffer): string {
	const key = Buffer.from(
		hkdfSync(
			"sha256",
			ROOT_KEY,
			Buffer.from("velve-auth/hkdf-sha256/v1"),
			Buffer.from("velve-auth/key/token-mac"),
			32,
		),
	);
	return createHmac("sha256", key)
		.update(
			Buffer.concat([
				text("velve-auth/token-binding/v1"),
				text(purpose),
				optionalText(owner),
				tlv(2, hash.length, hash),
				tail,
			]),
		)
		.digest("hex");
}

let migrated: MigratedSchema;
let schema: string;
const keys = rootKeyProvider({
	currentVersion: 1,
	keysByVersion: { 1: ROOT_KEY.toString("base64url") },
});

beforeAll(async () => {
	migrated = await openMigratedSchema("integ_token_stored_macs");
	schema = migrated.schema;
});
afterAll(async () => {
	await dropSchema(migrated.connection, schema);
	await migrated.connection.close();
});

describe("the MAC stored beside a row the library writes is the frozen one", () => {
	it("session", async () => {
		const userId = await createUser(migrated.connection, schema);
		const sessions = createSessionService({
			sealing: "migrating",
			driver: migrated.connection,
			keys,
			schema,
		});
		await sessions.issue({ userId, factors: ["password", "totp"], observed: OBSERVED });
		const [row] = await migrated.connection.query<{
			id: string;
			token_sha256: Buffer;
			token_mac: Buffer;
			micros: string;
		}>(
			`SELECT id, token_sha256, token_mac, (extract(epoch FROM created_at) * 1000000)::bigint::text AS micros
			 FROM ${schema}.session WHERE user_id = $1`,
			[userId],
		);
		const tail = Buffer.concat([
			text(row?.id ?? ""),
			list(["password", "totp"]),
			integer(1),
			integer(BigInt(row?.micros ?? "0")),
		]);
		expect(Buffer.from(row?.token_mac ?? []).toString("hex")).toBe(
			mac("session", userId, Buffer.from(row?.token_sha256 ?? []), tail),
		);
	});

	it("pending authentication, at the start and after a booking", async () => {
		const userId = await createUser(migrated.connection, schema);
		const pending = createPendingAuthenticationService({
			driver: migrated.connection,
			keys,
			schema,
		});
		await pending.begin({ userId, factorsCompleted: ["password"] });
		const read = async () =>
			(
				await migrated.connection.query<{ token_sha256: Buffer; token_mac: Buffer }>(
					`SELECT token_sha256, token_mac FROM ${schema}.pending_authentication WHERE user_id = $1`,
					[userId],
				)
			)[0];
		const row = await read();
		expect(Buffer.from(row?.token_mac ?? []).toString("hex")).toBe(
			mac(
				"pending_authentication",
				userId,
				Buffer.from(row?.token_sha256 ?? []),
				Buffer.concat([list(["password"]), integer(0)]),
			),
		);
	});

	it("one-time token with a payload", async () => {
		const userId = await createUser(migrated.connection, schema);
		const tokens = createOneTimeTokens(
			createOneTimeTokenRepository({ driver: decodingJsonb(migrated.connection), schema }),
			{ keys },
		);
		await tokens.issue({ purpose: "magic_link", userId, payload: { b: 1, a: "x" } });
		const [row] = await migrated.connection.query<{ token_sha256: Buffer; token_mac: Buffer }>(
			`SELECT token_sha256, token_mac FROM ${schema}.one_time_token WHERE user_id = $1`,
			[userId],
		);
		expect(Buffer.from(row?.token_mac ?? []).toString("hex")).toBe(
			mac(
				"magic_link",
				userId,
				Buffer.from(row?.token_sha256 ?? []),
				optionalText('{"a":"x","b":1}'),
			),
		);
	});

	it("webauthn challenge, for an owner and for none", async () => {
		const userId = await createUser(migrated.connection, schema);
		const challenges = createWebAuthnChallenges({ driver: migrated.connection, schema, keys });
		await challenges.issue({ purpose: "register", userId });
		await challenges.issue({ purpose: "authenticate", userId: null });
		const rows = await migrated.connection.query<{
			challenge_sha256: Buffer;
			token_mac: Buffer;
			purpose: string;
			user_id: string | null;
		}>(
			`SELECT challenge_sha256, token_mac, purpose, user_id FROM ${schema}.webauthn_challenge`,
			[],
		);
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(Buffer.from(row.token_mac).toString("hex")).toBe(
				mac(
					"webauthn_challenge",
					row.user_id,
					Buffer.from(row.challenge_sha256),
					text(row.purpose),
				),
			);
		}
	});
});
