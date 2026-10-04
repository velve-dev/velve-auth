import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import { createPendingAuthenticationService } from "../src/core/factor/pending/index.js";
import { createWebAuthnChallenges } from "../src/core/factor/webauthn/challenge.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createOneTimeTokens } from "../src/core/token/index.js";
import { createVelveAuth } from "../src/index.js";
import { configFor, requestTo } from "./auth-fixtures.js";
import { createUser, dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";
import { createStubProvider, oauthConfigFor } from "./oauth-provider.js";

const sourceDirectory = fileURLToPath(new URL("../src", import.meta.url));

/** The four ways `jose` turns a payload into a self-contained signed string. */
const JOSE_SIGNERS = new Set(["SignJWT", "CompactSign", "FlattenedSign", "GeneralSign"]);

interface SourceText {
	readonly file: string;
	readonly text: string;
}

/** Every identifier naming a `jose` signer, so a namespace access and an alias are seen too. */
function joseSignersIn(sources: readonly SourceText[]): string[] {
	const findings: string[] = [];
	for (const { file, text } of sources) {
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2023, true);
		const visit = (node: ts.Node): void => {
			if (ts.isIdentifier(node) && JOSE_SIGNERS.has(node.text)) {
				const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
				findings.push(`${file}:${line + 1} ${node.text}`);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return findings;
}

function sourcesUnder(directory: string): SourceText[] {
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => join(entry.parentPath, entry.name))
		.sort()
		.map((path) => ({ file: relative(sourceDirectory, path), text: readFileSync(path, "utf8") }));
}

describe("T-REPLAY-1, static — no one-time artefact is a jose signature (S-REPLAY-1)", () => {
	it("finds no jose signer anywhere in src/", () => {
		const sources = sourcesUnder(sourceDirectory);
		expect(sources.length).toBeGreaterThan(100);
		expect(joseSignersIn(sources)).toStrictEqual([]);
	});

	it("reports a planted signer, so the empty list above is a measurement", () => {
		expect(
			joseSignersIn([
				{
					file: "planted.ts",
					text: 'import * as jose from "jose";\nexport const sign = (key: CryptoKey) => new jose.SignJWT({}).sign(key);\n',
				},
			]),
		).toStrictEqual(["planted.ts:2 SignJWT"]);
	});
});

interface Recorded {
	readonly sql: string;
	readonly parameters: readonly unknown[];
}

interface Artefact {
	readonly secret: string;
	readonly statements: readonly Recorded[];
}

const recorded: Recorded[] = [];
let migrated: MigratedSchema;
let userId: string;

function recording(inner: Driver): Driver {
	return {
		query: (sql, parameters) => {
			recorded.push({ sql, parameters });
			return inner.query(sql, parameters);
		},
		transaction: (run) => inner.transaction((transaction) => run(recording(transaction))),
	};
}

async function issuedBy(create: () => Promise<string>): Promise<Artefact> {
	recorded.length = 0;
	const secret = await create();
	return { secret, statements: [...recorded] };
}

const ARTEFACT_CREATORS: Readonly<Record<string, () => Promise<string>>> = {
	"one-time token": async () => {
		const tokens = createOneTimeTokens(
			createOneTimeTokenRepository({
				driver: recording(migrated.connection),
				schema: migrated.schema,
			}),
		);
		return (await tokens.issue({ purpose: "magic_link", userId })).token;
	},
	"pending authentication": async () => {
		const pending = createPendingAuthenticationService({
			driver: recording(migrated.connection),
			schema: migrated.schema,
		});
		return (await pending.begin({ userId, factorsCompleted: ["password"] })).token;
	},
	"WebAuthn challenge": async () => {
		const challenges = createWebAuthnChallenges({
			driver: recording(migrated.connection),
			schema: migrated.schema,
		});
		return (await challenges.issue({ purpose: "authenticate", userId: null })).challengeToken;
	},
	"OAuth flow": async () => {
		const provider = await createStubProvider({ claims: { sub: "replay-1" } });
		const handler = toWebHandler(
			createVelveAuth(
				configFor({
					database: recording(migrated.connection),
					schema: migrated.schema,
					oauth: oauthConfigFor({ openIdConnect: false }),
					fetch: provider.fetch,
				}),
			),
		);
		recorded.length = 0;
		const answer = await handler(
			requestTo("/sign-in/oauth/start", { body: { provider: "stubby" } }),
		);
		const { authorizationUrl } = (await answer.json()) as { authorizationUrl: string };
		return new URL(authorizationUrl).searchParams.get("state") ?? "";
	},
};

const HASHED_PRIMARY_KEYS = ["challenge_sha256", "state_sha256", "token_sha256"];

const issued = new Map<string, Artefact>();

beforeAll(async () => {
	migrated = await openMigratedSchema("replayrows");
	userId = await createUser(migrated.connection, migrated.schema);
	for (const [name, create] of Object.entries(ARTEFACT_CREATORS)) {
		issued.set(name, await issuedBy(create));
	}
}, 60_000);

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

async function primaryKeyOf(table: string): Promise<string[]> {
	const rows = await migrated.connection.query<{ column_name: string }>(
		`SELECT attribute.attname AS column_name
		 FROM pg_index index_
		 JOIN pg_attribute attribute
		   ON attribute.attrelid = index_.indrelid AND attribute.attnum = ANY(index_.indkey)
		 JOIN pg_class class_ ON class_.oid = index_.indrelid
		 JOIN pg_namespace namespace_ ON namespace_.oid = class_.relnamespace
		 WHERE namespace_.nspname = $1 AND class_.relname = $2 AND index_.indisprimary`,
		[migrated.schema, table],
	);
	return rows.map((row) => row.column_name);
}

interface IssuingInsert {
	readonly table: string;
	readonly columns: readonly string[];
	readonly firstValue: unknown;
}

function issuingInsertsOf(artefact: Artefact): IssuingInsert[] {
	return artefact.statements.flatMap(({ sql, parameters }) => {
		const found =
			/INSERT INTO\s+([\w.]+)(?:\s+AS\s+\w+)?\s*\(([^)]*)\)\s*VALUES\s*\(\s*\$(\d+)/.exec(sql);
		if (found === null) {
			return [];
		}
		const [, qualified = "", columns = "", firstPlaceholder = "0"] = found;
		return [
			{
				table: qualified.split(".").at(-1) ?? "",
				columns: columns.split(",").map((column) => column.trim()),
				firstValue: parameters[Number(firstPlaceholder) - 1],
			},
		];
	});
}

describe("T-REPLAY-1, integration — every one-time artefact is a row keyed by a hash (S-REPLAY-1)", () => {
	it.each(Object.keys(ARTEFACT_CREATORS))(
		"the %s is issued by one INSERT keyed on the SHA-256 of what the caller holds",
		async (name) => {
			const artefact = issued.get(name) as Artefact;
			const inserts = issuingInsertsOf(artefact);
			expect(inserts, name).toHaveLength(1);
			const [insert] = inserts as [IssuingInsert];
			const primaryKey = await primaryKeyOf(insert.table);

			expect(primaryKey).toHaveLength(1);
			expect(HASHED_PRIMARY_KEYS).toContain(primaryKey[0]);
			expect(insert.columns[0], "the key is the first column the statement writes").toBe(
				primaryKey[0],
			);
			expect(Buffer.from(insert.firstValue as Uint8Array).toString("hex")).toBe(
				createHash("sha256").update(artefact.secret, "utf8").digest("hex"),
			);
		},
	);

	it("maps exactly four artefact types onto the four hash-keyed tables the schema has", async () => {
		const mapped = new Set(
			[...issued.values()].map(
				(artefact) => (issuingInsertsOf(artefact)[0] as IssuingInsert).table,
			),
		);
		const tables = await migrated.connection.query<{ table_name: string }>(
			`SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
			[migrated.schema],
		);
		const hashKeyed: string[] = [];
		for (const { table_name } of tables) {
			const key = await primaryKeyOf(table_name);
			if (key.length === 1 && HASHED_PRIMARY_KEYS.includes(key[0] as string)) {
				hashKeyed.push(table_name);
			}
		}

		expect(issued.size).toBe(4);
		expect([...mapped].sort()).toStrictEqual(hashKeyed.sort());
		expect(hashKeyed).toHaveLength(4);
	});
});
