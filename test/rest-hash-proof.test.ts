import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DrivenUser, driveOneUserThroughEveryFlow } from "./rest-fixtures.js";

let driven: DrivenUser;

beforeAll(async () => {
	driven = await driveOneUserThroughEveryFlow("resthash");
}, 60_000);

afterAll(async () => {
	await driven.close();
});

interface HashColumn {
	readonly table: string;
	readonly column: string;
	readonly secrets: readonly string[];
}

const HASH_COLUMNS: readonly HashColumn[] = [
	{ table: "session", column: "token_sha256", secrets: ["session token"] },
	{
		table: "one_time_token",
		column: "token_sha256",
		secrets: [
			"one-time token (email_verify)",
			"one-time token (password_reset)",
			"one-time token (email_change)",
			"one-time token (magic_link)",
		],
	},
	{ table: "pending_authentication", column: "token_sha256", secrets: ["pending token"] },
	{ table: "webauthn_challenge", column: "challenge_sha256", secrets: ["WebAuthn challenge"] },
	{ table: "oauth_flow", column: "state_sha256", secrets: ["OAuth state"] },
];

function plaintextOf(name: string): string {
	const found = driven.secrets.find((secret) => secret.name === name);
	if (found === undefined) {
		throw new Error(`the driven account produced no ${name}`);
	}
	return found.value;
}

//the reference hash comes from node:crypto and not from the library that wrote the column
function sha256Of(plaintext: string): string {
	return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

async function storedHashes(column: HashColumn): Promise<string[]> {
	const rows = await driven.mounted.connection.query<{ hashed: Uint8Array }>(
		`SELECT ${column.column} AS hashed FROM ${driven.mounted.schema}.${column.table}`,
		[],
	);
	return rows.map((row) => Buffer.from(row.hashed).toString("hex"));
}

describe("T-REST-2: what is only compared lies as its SHA-256 (S-REST-2)", () => {
	it("declares each of the five columns bytea", async () => {
		const rows = await driven.mounted.connection.query<{ table_name: string; data_type: string }>(
			`SELECT table_name, data_type FROM information_schema.columns
			 WHERE table_schema = $1 AND (table_name, column_name) IN (
			   ('session', 'token_sha256'), ('one_time_token', 'token_sha256'),
			   ('pending_authentication', 'token_sha256'), ('webauthn_challenge', 'challenge_sha256'),
			   ('oauth_flow', 'state_sha256'))
			 ORDER BY table_name`,
			[driven.mounted.schema],
		);

		expect(rows).toHaveLength(5);
		expect(rows.filter((row) => row.data_type !== "bytea")).toStrictEqual([]);
	});

	it.each(HASH_COLUMNS.map((column) => [`${column.table}.${column.column}`, column] as const))(
		"stores %s as exactly the 32-byte SHA-256 of the plaintext",
		async (_name, column) => {
			const stored = await storedHashes(column);
			const expected = column.secrets.map((name) => sha256Of(plaintextOf(name)));

			expect(stored.map((hex) => hex.length / 2)).toStrictEqual(stored.map(() => 32));
			expect([...stored].sort()).toStrictEqual([...expected].sort());
		},
	);

	it("holds nothing in those columns a plaintext could be read back from", async () => {
		const stored = (await Promise.all(HASH_COLUMNS.map(storedHashes))).flat();
		const plaintexts = HASH_COLUMNS.flatMap((column) => column.secrets.map(plaintextOf));

		expect(stored).toHaveLength(8);
		expect(
			stored.filter((hex) =>
				plaintexts.some((plaintext) => hex.includes(Buffer.from(plaintext).toString("hex"))),
			),
		).toStrictEqual([]);
	});
});
