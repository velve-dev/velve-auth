import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
	createOneTimeTokenRepository,
	OneTimeTokenRepository,
	OneTimeTokenRepositoryOptions,
} from "../src/core/db/repositories/token.js";
import type {
	IssuedOneTimeToken,
	OneTimeTokenPayload,
	OneTimeTokenRedemption,
	OneTimeTokenRequest,
	OneTimeTokens,
} from "../src/core/token/index.js";

const coreDirectory = fileURLToPath(new URL("../src/core", import.meta.url));
const repositoryPath = `${coreDirectory}/db/repositories/token.ts`;
const repositorySource = readFileSync(repositoryPath, "utf8");

interface Source {
	readonly path: string;
	readonly text: string;
}

function coreSources(): readonly Source[] {
	return readdirSync(coreDirectory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => `${entry.parentPath}/${entry.name}`)
		.sort()
		.map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

const sources = coreSources();

function withoutComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function pathsMatching(pattern: RegExp): readonly string[] {
	return sources
		.filter((source) => pattern.test(withoutComments(source.text)))
		.map((source) => source.path);
}

const LITERAL = /`([^`]*)`/g;
const LOOKS_LIKE_SQL = /\b(SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i;

function statementsIn(source: string): readonly string[] {
	return [...source.matchAll(LITERAL)]
		.map((match) => match[1] ?? "")
		.filter((literal) => LOOKS_LIKE_SQL.test(literal));
}

function collapseWhitespace(sql: string): string {
	return sql.replace(/\s+/g, " ").trim();
}

/** The statements carry the schema as an interpolation; section 3.7 spells out the default. */
function asWritten(sql: string): string {
	return collapseWhitespace(sql).replace(/\$\{table\}/g, "velve.one_time_token");
}

/** Everything a `WHERE` filters on, which ends where the statement stops filtering. */
function predicatesIn(sql: string): readonly string[] {
	return collapseWhitespace(sql)
		.split(/\bWHERE\b/i)
		.slice(1)
		.map((tail) => tail.split(/\bRETURNING\b|\bINSERT\b|\)$/i)[0] ?? "");
}

const statements = statementsIn(repositorySource);

describe("the CSPRNG has exactly one caller in the core (S-RAND-5)", () => {
	it("has more than nothing to scan", () => {
		expect(sources.length).toBeGreaterThan(20);
	});

	it("calls crypto.getRandomValues only in core/token/random.ts", () => {
		expect(pathsMatching(/getRandomValues/)).toStrictEqual([`${coreDirectory}/token/random.ts`]);
	});
});

describe("one_time_token is reached from one file (S-TOKEN-1)", () => {
	it("names the table in the schema that creates it and in the repository, nowhere else", () => {
		expect(pathsMatching(/one_time_token/)).toStrictEqual([
			`${coreDirectory}/db/migrations/initial-schema.ts`,
			repositoryPath,
		]);
	});

	it("has two statements to inspect, so a passing scan means something", () => {
		expect(statements).toHaveLength(2);
	});

	it("filters on the purpose in every predicate it writes", () => {
		const predicates = statements.flatMap(predicatesIn);
		expect(predicates).toHaveLength(2);
		expect(predicates.filter((predicate) => !predicate.includes("purpose = $2"))).toStrictEqual([]);
	});

	it("names the purpose in the row it inserts", () => {
		const insert = statements.find((statement) => /\bINSERT\b/i.test(statement)) ?? "";
		expect(insert).toContain("purpose");
	});
});

describe("consumption is the statement section 3.7 prescribes (S-REPLAY-2)", () => {
	it("is that statement and not a paraphrase of it", () => {
		const consume = statements.find((statement) => /^\s*DELETE\b/i.test(statement)) ?? "";
		expect(asWritten(consume)).toBe(
			"DELETE FROM velve.one_time_token WHERE token_sha256 = $1 AND purpose = $2 " +
				"AND expires_at > now() RETURNING user_id, payload",
		);
	});

	// S-TOKEN-4: the row names the account, so a caller-supplied owner has nothing to add here.
	// This is the one row-removing statement in the library without an owner predicate, and it is
	// deliberate rather than forgotten.
	it("filters on no owner, because the token is the authority", () => {
		const consume = statements.find((statement) => /^\s*DELETE\b/i.test(statement)) ?? "";
		expect(predicatesIn(consume)[0]).not.toContain("user_id");
	});
});

describe("nothing reads the row before removing it (S-RACE-2)", () => {
	it("issues one statement per repository method", () => {
		expect(repositorySource.match(/options\.driver\.query</g)).toHaveLength(2);
		expect(repositorySource.match(/^\t\tasync [a-zA-Z]+\(/gm)).toHaveLength(2);
	});

	it("never selects from the table at all", () => {
		expect(statements.filter((statement) => /\bSELECT\b/i.test(statement))).toStrictEqual([]);
	});

	it("puts the validity conditions in the statement that removes the row", () => {
		const consume = statements.find((statement) => /^\s*DELETE\b/i.test(statement)) ?? "";
		expect(consume).toContain("expires_at > now()");
		expect(consume).toContain("purpose = $2");
	});
});

describe("a one-time artefact is a row, not a signed string (S-REPLAY-1)", () => {
	const owned = sources.filter(
		(source) => source.path.startsWith(`${coreDirectory}/token/`) || source.path === repositoryPath,
	);

	it("owns the files it claims to own", () => {
		expect(owned.length).toBeGreaterThanOrEqual(5);
	});

	it("signs nothing", () => {
		const signing = owned.filter((source) => /jose|SignJWT|jwt|\bsign\b/i.test(source.text));
		expect(signing.map((source) => source.path)).toStrictEqual([]);
	});

	it("stores the artefact under the hash of the token", () => {
		expect(statements.some((statement) => statement.includes("token_sha256"))).toBe(true);
	});
});

describe("no plaintext token reaches a message", () => {
	it("interpolates nothing but the table and the purpose into the one error it raises", () => {
		const thrown = repositorySource.match(/throw new Error\([\s\S]*?\);/g) ?? [];
		expect(thrown).toHaveLength(1);
		expect(thrown[0]).toMatch(/\$\{purpose\}/);
		expect(thrown[0]).not.toMatch(/token|payload|userId/);
	});
});

// The scan above reads the statements; this reads the signature, which is the other half of
// S-TOKEN-1: a lookup without a purpose must not compile.
declare const repository: OneTimeTokenRepository;

describe("the repository signature demands the purpose (S-TOKEN-1)", () => {
	it("refuses a lookup that is only a hash", () => {
		const lookupWithoutPurpose = () =>
			// @ts-expect-error a hash alone is not a lookup; the purpose is part of it.
			repository.consumeOneTimeToken({ tokenSha256: new Uint8Array(32) });
		expect(lookupWithoutPurpose).toBeInstanceOf(Function);
	});
});

// The reference in DOCUMENTATION.md names these types; this is what makes the names binding.
describe("the exported types describe the functions they name", () => {
	it("shapes the repository and the two operations over it", () => {
		expectTypeOf<
			Parameters<typeof createOneTimeTokenRepository>[0]
		>().toEqualTypeOf<OneTimeTokenRepositoryOptions>();
		expectTypeOf<Parameters<OneTimeTokens["issue"]>[0]>().toEqualTypeOf<OneTimeTokenRequest>();
		expectTypeOf<Awaited<ReturnType<OneTimeTokens["issue"]>>>().toEqualTypeOf<IssuedOneTimeToken>();
		expectTypeOf<
			Awaited<ReturnType<OneTimeTokens["redeem"]>>
		>().toEqualTypeOf<OneTimeTokenRedemption | null>();
		expectTypeOf<OneTimeTokenRequest["payload"]>().toEqualTypeOf<OneTimeTokenPayload | undefined>();
	});
});
