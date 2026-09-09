import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
	createOneTimeTokenRepository,
	OneTimeTokenError,
	OneTimeTokenErrorCode,
	OneTimeTokenRepository,
	OneTimeTokenRepositoryOptions,
} from "../src/core/db/repositories/token.js";
import {
	type IssuedOneTimeToken,
	type OneTimeTokenPayload,
	type OneTimeTokenRedemption,
	type OneTimeTokenRequest,
	type OneTimeTokens,
	toSecretToken,
} from "../src/core/token/index.js";
import { onOneLine, withoutSqlComments } from "../tools/sql-collapse.mjs";

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
	return collapseWhitespace(withoutSqlComments(sql))
		.replace(/\$\{table\}/g, "velve.one_time_token")
		.replace(/\$\{schema\}/g, "velve");
}

/** Everything a `WHERE` filters on, which ends where the statement stops filtering. */
function predicatesIn(sql: string): readonly string[] {
	return collapseWhitespace(sql)
		.split(/\bWHERE\b/i)
		.slice(1)
		.map((tail) => tail.split(/\bRETURNING\b|\bINSERT\b|\)$/i)[0] ?? "");
}

const statements = statementsIn(repositorySource);
const tokenStatements = statements.filter((statement) => /\$\{table\}/.test(statement));
const ownerStatements = statements.filter((statement) => /\$\{schema\}\.user\b/.test(statement));

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
		// L-11 adds a third: the sweep deletes expired rows from the seven tables with a `*_sweep_idx`,
		// and naming them is what it does. What it is allowed to do there is pinned below, because
		// admitting a file to this list without that would move the sweep out of every scan in this
		// file — each of the others reads the repository source alone (E-353).
		expect(pathsMatching(/one_time_token/)).toStrictEqual([
			`${coreDirectory}/auth/maintenance.ts`,
			`${coreDirectory}/db/migrations/initial-schema.ts`,
			repositoryPath,
		]);
	});

	/**
	 * The sweep reaches the table on a deadline, which is neither a purpose nor an owner, and that is
	 * the whole of its licence. It names the table in a list of tables and builds its statement from
	 * the configured schema, so the name and the SQL never meet in one literal — which is exactly why
	 * admitting the file to the path list above proves nothing on its own, and why what it may do is
	 * pinned here instead: one statement, a DELETE, a deadline predicate, no `purpose`, no `user_id`,
	 * and its own marker naming the requirement that permits it (E-353).
	 */
	it("lets the sweep reach the table on a deadline and on nothing else", () => {
		const sweep = readFileSync(`${coreDirectory}/auth/maintenance.ts`, "utf8");
		const written = statementsIn(sweep);

		expect(written).toHaveLength(1);
		expect(written[0]).toMatch(/^\s*DELETE\b/i);
		const predicates = predicatesIn(written[0] ?? "").map((predicate) => predicate.trim());
		expect(predicates).toHaveLength(1);
		// The column is interpolated, so what is pinned is the comparison, not the name.
		expect(predicates[0]?.endsWith("<= now()")).toBe(true);
		expect(written[0]).toContain("/* no owner predicate: S-OWNER-2");
		expect(written[0]).not.toContain("purpose");
		expect(written[0]).not.toContain("user_id");
		// The table is named where the sweep lists what it sweeps, and in no statement.
		expect(sweep.match(/one_time_token/g)).toHaveLength(1);
		expect(sweep).toContain('["one_time_token", "expires_at"]');
	});

	it("writes three statements, two of them against the table", () => {
		expect(statements).toHaveLength(3);
		expect(tokenStatements).toHaveLength(2);
		expect(ownerStatements).toHaveLength(1);
	});

	it("filters on the purpose in every predicate it writes against the table", () => {
		const predicates = tokenStatements.flatMap(predicatesIn);
		expect(predicates).toHaveLength(2);
		expect(predicates.filter((predicate) => !predicate.includes("purpose = $2"))).toStrictEqual([]);
	});

	it("names the purpose in the row it inserts", () => {
		const insert = tokenStatements.find((statement) => /\bINSERT\b/i.test(statement)) ?? "";
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
	// E-142 requires the statement itself to say so and to name the requirement that permits it.
	// It was the only such statement in the library when this was written; the count is asserted
	// below rather than left in this sentence (E-353), and the census is E-795's finding.
	it("filters on no owner, and declares that in its own text", () => {
		const consume = statements.find((statement) => /^\s*DELETE\b/i.test(statement)) ?? "";
		expect(predicatesIn(consume)[0]).not.toContain("user_id");
		expect(consume).toContain("/* no owner predicate: S-TOKEN-4 */");
	});

	it("carries the marker on no other statement of this repository, and is one of sixteen overall", () => {
		const carrying = sources.filter((source) => /no owner predicate/.test(source.text));
		const markers = sources.flatMap((source) => source.text.match(/no owner predicate/g) ?? []);

		// Five more since wave 5, from two features: the flow row is reached by its state hash and
		// the identity row by the pair that identifies it (E-565), and a first confirmation is
		// reached by the account it is about, which is the owned row itself (E-607). No owner
		// predicate could narrow any of them.
		expect(markers).toHaveLength(16);
		expect(carrying).toHaveLength(9);
		expect(statements.filter((statement) => /no owner predicate/.test(statement))).toHaveLength(1);
	});
});

describe("the redemption still filters on everything once it is on one line (E-266)", () => {
	it("keeps hash, purpose and expiry outside the marker", () => {
		const consume = statements.find((statement) => /^\s*DELETE\b/i.test(statement)) ?? "";
		expect(withoutSqlComments(onOneLine(consume))).toContain(
			"WHERE token_sha256 = $1 AND purpose = $2 AND expires_at > now()",
		);
	});
});

describe("nothing reads the row before removing it (S-RACE-2)", () => {
	it("reads nothing from the table, so no read can precede a write to it", () => {
		expect(tokenStatements.filter((statement) => /\bSELECT\b/i.test(statement))).toStrictEqual([]);
	});

	// The one read in the file is a lock on a different table (S-TOKEN-3, E-259); it decides
	// nothing about the row it precedes, which is what S-RACE-2 forbids.
	it("reads only the owner row, and takes no row lock while doing it", () => {
		expect(ownerStatements.map(asWritten)).toStrictEqual([
			"SELECT pg_advisory_xact_lock(hashtextextended($2, 0)) AS serialised, " +
				"(SELECT 1 FROM velve.user owner WHERE owner.id = $1) AS owner_exists",
		]);
		expect(repositorySource).not.toMatch(/\bFOR (NO KEY )?UPDATE\b/);
	});

	it("consumes in a single statement with no statement before it", () => {
		const consumeBody =
			repositorySource.slice(repositorySource.indexOf("async consumeOneTimeToken")) ?? "";
		expect(consumeBody.match(/\.query</g)).toHaveLength(1);
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

describe("what the repository raises carries a code and no secret", () => {
	/**
	 * The fourth raise is the driver-contract guard E-598 added, and it is not a refusal of anything
	 * a caller sent: it fires when the driver hands back a `timestamptz` it did not decode, which
	 * `auth/user.ts` and `db/repositories/session.ts` have always answered the same way. It carries no
	 * value from the row, which is what this rule is about.
	 */
	it("raises nothing that is not a coded refusal or the driver-contract guard", () => {
		const raises = repositorySource.match(/throw new [A-Za-z]+\([\s\S]*?\);/g) ?? [];
		expect(raises).toHaveLength(5);
		expect(
			raises.filter(
				(raise) =>
					!/^throw new OneTimeTokenError\("one_time_token_[a-z_]+", (purpose|null)\);$/.test(
						raise,
					) && raise !== 'throw new TypeError("the driver must decode timestamptz into a Date");',
			),
		).toStrictEqual([]);
	});

	it("takes every message from a fixed table that no input reaches", () => {
		const table = repositorySource.slice(
			repositorySource.indexOf("MESSAGE_BY_ERROR_CODE"),
			repositorySource.indexOf("export class OneTimeTokenError"),
		);
		expect(table).not.toContain("`");
		expect(table).not.toMatch(/token_sha256|payload|userId/);
		expect(repositorySource).toMatch(/super\(MESSAGE_BY_ERROR_CODE\[code\]\)/);
	});
});

// The scan above reads the statements; this reads the signature, which is the other half of
// S-TOKEN-1: a lookup without a purpose must not compile.
declare const repository: OneTimeTokenRepository;
declare const tokens: OneTimeTokens;
declare const userId: string;

describe("the repository signature demands the purpose (S-TOKEN-1)", () => {
	it("refuses a lookup that is only a hash", () => {
		const lookupWithoutPurpose = () =>
			// @ts-expect-error a hash alone is not a lookup; the purpose is part of it.
			repository.consumeOneTimeToken({ tokenSha256: new Uint8Array(32) });
		expect(lookupWithoutPurpose).toBeInstanceOf(Function);
	});
});

// S-RAND-6: a database key is not a secret. T-RAND-6 asks for the negative case to be a
// compile error rather than a review note.
describe("an account identifier is not a token (S-RAND-6)", () => {
	it("refuses one where a token belongs, and takes it only when someone says so", () => {
		const redeemWithAnAccountIdentifier = () =>
			// @ts-expect-error a uuid is a database key; it becomes a token only by conversion.
			tokens.redeem({ token: userId, purpose: "magic_link" });
		const redeemWithAConversion = () =>
			tokens.redeem({ token: toSecretToken(userId), purpose: "magic_link" });

		expect(redeemWithAnAccountIdentifier).toBeInstanceOf(Function);
		expect(redeemWithAConversion).toBeInstanceOf(Function);
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
		expectTypeOf<OneTimeTokenError["code"]>().toEqualTypeOf<OneTimeTokenErrorCode>();
	});
});
