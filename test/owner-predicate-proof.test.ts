import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	dropSchema,
	type MigratedSchema,
	openMigratedSchema,
	readUserOwnedTables,
} from "./db-fixtures.js";

const SOURCE_ROOT = fileURLToPath(new URL("../src/", import.meta.url));
const MIGRATIONS = "core/db/migrations/";

type SourceTree = ReadonlyMap<string, string>;

function readSourceTree(): SourceTree {
	const tree = new Map<string, string>();
	for (const entry of readdirSync(SOURCE_ROOT, { recursive: true, withFileTypes: true })) {
		const path = `${entry.parentPath}/${entry.name}`.slice(SOURCE_ROOT.length);
		if (entry.isFile() && entry.name.endsWith(".ts") && !path.startsWith(MIGRATIONS)) {
			tree.set(path, readFileSync(`${SOURCE_ROOT}${path}`, "utf8"));
		}
	}
	return tree;
}

function parsed(path: string, text: string): ts.SourceFile {
	return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function everyNode(root: ts.Node, visit: (node: ts.Node) => void): void {
	visit(root);
	root.forEachChild((child) => everyNode(child, visit));
}

const LOOKS_LIKE_SQL = /\b(SELECT|INSERT|UPDATE|DELETE)\b/;

//a template is read with each interpolation written as its source text, which names the table
function sqlTextOf(node: ts.Node): string | null {
	let text: string | null = null;
	if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) {
		text = node.text;
	}
	if (ts.isTemplateExpression(node)) {
		text = node.head.text;
		for (const span of node.templateSpans) {
			text += `\${${span.expression.getText()}}${span.literal.text}`;
		}
	}
	return text !== null && LOOKS_LIKE_SQL.test(text) ? text : null;
}

function depthsOf(sql: string): number[] {
	const depths: number[] = [];
	let depth = 0;
	for (const character of sql) {
		if (character === ")") {
			depth -= 1;
		}
		depths.push(depth);
		if (character === "(") {
			depth += 1;
		}
	}
	return depths;
}

function wordsAtDepth(sql: string, depths: readonly number[], word: RegExp, depth: number) {
	return [...sql.matchAll(word)].filter((match) => depths[match.index] === depth);
}

function endOfStatement(sql: string, depths: readonly number[], start: number): number {
	const depth = depths[start] ?? 0;
	for (let index = start; index < sql.length; index += 1) {
		if ((depths[index] ?? 0) < depth || (sql[index] === ";" && depths[index] === depth)) {
			return index;
		}
	}
	return sql.length;
}

interface RowChange {
	readonly file: string;
	readonly table: string;
	readonly conjuncts: readonly string[];
	readonly marker: string | null;
	readonly text: string;
}

const CHANGE =
	/(?<!\bFOR\s{1,20})(?<!\bFOR\s{1,20}NO\s{1,20}KEY\s{1,20})\b(DELETE\s+FROM|UPDATE)\s+(\$\{[^}]+\}|\w+)?/gi;
const MARKER = /\/\*\s*no owner predicate:\s*(S-[A-Z]+-\d+[\s\S]*?)\*\//i;
const INSERTED_INTO = /\bINSERT\s+INTO\s+(\$\{[^}]+\}|\w+)/i;

//an upsert's DO UPDATE is read against the table its INSERT names
function changedTable(sql: string, match: RegExpMatchArray): string {
	const named = match[2];
	if (named !== undefined && !/^SET$/i.test(named)) {
		return named;
	}
	return INSERTED_INTO.exec(sql)?.[1] ?? "";
}

function topLevelConjuncts(statement: string, depths: readonly number[], offset: number): string[] {
	const depth = depths[offset] ?? 0;
	const local = depths.slice(offset, offset + statement.length);
	const where = wordsAtDepth(statement, local, /\bWHERE\b/gi, depth).at(-1);
	if (where === undefined) {
		return [];
	}
	const returning = wordsAtDepth(statement, local, /\bRETURNING\b/gi, depth).find(
		(match) => match.index > where.index,
	);
	const clauseEnd = returning?.index ?? statement.length;
	const cuts = wordsAtDepth(statement, local, /\bAND\b/gi, depth)
		.filter((match) => match.index > where.index && match.index < clauseEnd)
		.map((match) => match.index);
	const bounds = [where.index + "WHERE".length, ...cuts, clauseEnd];
	return bounds.slice(0, -1).map((start, index) =>
		statement
			.slice(start, bounds[index + 1])
			.replace(/^\s*AND\b/i, "")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.trim(),
	);
}

//a lone grant names privileges and changes no row (E-2450)
const GRANTS_PRIVILEGES = /^\s*GRANT\b[^;]*$/i;

function rowChangesIn(file: string, sql: string): RowChange[] {
	if (GRANTS_PRIVILEGES.test(sql)) {
		return [];
	}
	const depths = depthsOf(sql);
	return [...sql.matchAll(CHANGE)].map((match) => {
		const start = match.index;
		const statement = sql.slice(start, endOfStatement(sql, depths, start));
		return {
			file,
			table: changedTable(sql, match),
			conjuncts: topLevelConjuncts(statement, depths, start),
			marker: MARKER.exec(statement)?.[1]?.replace(/\s+/g, " ").trim() ?? null,
			text: statement.replace(/\s+/g, " ").slice(0, 160),
		};
	});
}

//an owner predicate is a top-level conjunct comparing the owner column with a parameter, null-safe for a nullable owner (S-OWNER-2)
const OWNER_CONJUNCT =
	/^(?:(?:\w+|\$\{\w+\})\.)?(?:user_id|\$\{ownerColumn\})\s*(?:=|IS\s+NOT\s+DISTINCT\s+FROM)\s*\$\d+(?:::uuid)?$/i;

function hasOwnerPredicate(change: RowChange): boolean {
	return change.conjuncts.some((conjunct) => OWNER_CONJUNCT.test(conjunct));
}

function tablesNamedIn(text: string): Map<string, Set<string>> {
	const named = new Map<string, Set<string>>();
	for (const match of text.matchAll(/(\w+)\s*=\s*qualifiedTableName\([^,]+,\s*"(\w+)"\)/g)) {
		const [, variable = "", table = ""] = match;
		named.set(variable, new Set([...(named.get(variable) ?? []), table]));
	}
	return named;
}

const UNKNOWN_TABLE = "(unresolved)";

//an interpolation names a table when the file binds that name to exactly one
function resolvedTable(reference: string, named: ReadonlyMap<string, ReadonlySet<string>>): string {
	const literal = /qualifiedTableName\([^,]+,\s*"(\w+)"\)/.exec(reference)?.[1];
	if (literal !== undefined) {
		return literal;
	}
	const variable = /^\$\{(\w+)\}$/.exec(reference)?.[1] ?? "";
	const tables = [...(named.get(variable) ?? [])];
	return tables.length === 1 ? (tables[0] ?? UNKNOWN_TABLE) : UNKNOWN_TABLE;
}

function sqlLiteralsIn(path: string, text: string): string[] {
	const found: string[] = [];
	everyNode(parsed(path, text), (node) => {
		const sql = sqlTextOf(node);
		if (sql !== null) {
			found.push(sql);
		}
	});
	return found;
}

function everyRowChange(tree: SourceTree): RowChange[] {
	return [...tree].flatMap(([file, text]) => {
		const named = tablesNamedIn(text);
		return sqlLiteralsIn(file, text)
			.flatMap((sql) => rowChangesIn(file, sql))
			.map((change) => ({ ...change, table: resolvedTable(change.table, named) }));
	});
}

//every marked statement without an owner predicate by file and reason, and the list is exact in both directions
const NAMED_EXCEPTIONS: readonly string[] = [
	"core/auth/maintenance.ts: S-OWNER-2, a deadline is not an owner",
	"core/auth/user.ts: S-OWNER-2, velve.user is the owned row and id is its owner column",
	"core/auth/user.ts: S-OWNER-2, velve.user is the owned row and id is its owner column",
	"core/auth/user.ts: S-OWNER-2, velve.user is the owned row and id is its owner column",
	"core/auth/user.ts: S-OWNER-7, the caller is the application itself (B.3)",
	"core/auth/user.ts: S-OWNER-7, the caller is the application itself (B.3)",
	"core/db/repositories/session.ts: S-OWNER-2, the predicate is the secret itself",
	"core/db/repositories/session.ts: S-OWNER-7, 3.15 G hands a plugin a session id and no owner to bind it to",
	"core/db/repositories/token.ts: S-TOKEN-4",
	"core/factor/pending/repository.ts: S-OWNER-2, E-242, the predicate is the secret itself",
	"core/factor/pending/repository.ts: S-OWNER-2, E-242, the predicate is the secret itself",
	"core/flows/confirmation.ts: S-OWNER-2, velve.user is the owned row and id is its owner column",
	"core/flows/confirmation.ts: S-OWNER-2, velve.user is the owned row and id is its owner column",
	"core/oauth/flow-repository.ts: S-CSRF-5, the row is reached by its state hash and the pointer cookie is what proves the caller may spend it",
	"core/oauth/identity-repository.ts: S-LINK-1, the row is addressed by the pair that identifies it and the account it names is the answer rather than the question",
];

let migrated: MigratedSchema;
let userBound: ReadonlySet<string>;

beforeAll(async () => {
	migrated = await openMigratedSchema("ownerpredicate");
	const owned = await readUserOwnedTables(migrated.connection, migrated.schema);
	userBound = new Set(["user", ...owned.map((each) => each.table)]);
});

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

//a statement whose table cannot be resolved is held to the rule as though it were user-bound
function reachedByTheRule(change: RowChange): boolean {
	return change.table === UNKNOWN_TABLE || userBound.has(change.table);
}

function withoutOwnerPredicate(changes: readonly RowChange[]): RowChange[] {
	return changes.filter((change) => reachedByTheRule(change) && !hasOwnerPredicate(change));
}

function describing(changes: readonly RowChange[]): string {
	return changes.map((change) => `${change.file} [${change.table}]: ${change.text}`).join("\n");
}

describe("T-OWNER-2: the owner condition stands in the outermost WHERE (S-OWNER-2)", () => {
	const tree = readSourceTree();

	//a table named by a constant or chosen at run time stays unresolved and is held to the rule
	it("finds the row-changing statements and resolves every table not computed at run time", () => {
		const changes = everyRowChange(tree).filter(reachedByTheRule);
		const unresolved = new Set(
			changes.filter((change) => change.table === UNKNOWN_TABLE).map((change) => change.file),
		);

		expect(changes.length).toBeGreaterThan(30);
		expect([...unresolved].sort()).toStrictEqual([
			"core/auth/maintenance.ts",
			"core/db/repositories/owned-row-repository.ts",
			"core/identity/sign-in-methods.ts",
			"core/password/credential.ts",
		]);
	});

	it("gives every one a top-level user_id = $n, or a marker this file names", () => {
		const missing = withoutOwnerPredicate(everyRowChange(tree));
		const unmarked = missing.filter((change) => change.marker === null);
		const markers = missing
			.filter((change) => change.marker !== null)
			.map((change) => `${change.file}: ${change.marker}`)
			.sort();

		expect(unmarked, describing(unmarked)).toStrictEqual([]);
		expect(markers).toStrictEqual([...NAMED_EXCEPTIONS].sort());
	});

	it.each([
		["the predicate missing", "DELETE FROM t WHERE id = $1 RETURNING id"],
		["the owner behind an OR", "DELETE FROM t WHERE id = $1 OR user_id = $2"],
		[
			"the owner inside a parenthesised OR",
			"UPDATE t SET a = 1 WHERE id = $1 AND (user_id = $2 OR true)",
		],
		[
			"the owner inside a subquery",
			"DELETE FROM t WHERE id IN (SELECT id FROM t WHERE user_id = $2)",
		],
		["the owner only in RETURNING", "DELETE FROM t WHERE id = $1 RETURNING user_id"],
		["the owner compared with a column", "DELETE FROM t WHERE id = $1 AND user_id = user_id"],
		[
			"a CTE that drops it",
			"WITH gone AS (DELETE FROM t WHERE id = $1) SELECT 1 WHERE user_id = $2",
		],
	])("refuses a planted statement with %s", (_case, sql) => {
		const planted = rowChangesIn("core/planted.ts", sql).map((change) => ({
			...change,
			table: UNKNOWN_TABLE,
		}));

		expect(planted).toHaveLength(1);
		expect(withoutOwnerPredicate(planted)).toHaveLength(1);
	});

	it("still reads a statement that follows a grant", () => {
		const changes = rowChangesIn(
			"core/planted.ts",
			"GRANT SELECT ON t TO r; DELETE FROM t WHERE id = $1",
		).map((change) => ({ ...change, table: UNKNOWN_TABLE }));

		expect(withoutOwnerPredicate(changes).map((change) => change.text)).toContain(
			"DELETE FROM t WHERE id = $1",
		);
	});

	it("reads a lone grant as changing no row", () => {
		expect(
			rowChangesIn("core/planted.ts", "GRANT USAGE, SELECT, UPDATE ON SEQUENCE s TO r"),
		).toStrictEqual([]);
	});

	it.each([
		["the plain form", "DELETE FROM t WHERE id = $1 AND user_id = $2 RETURNING id"],
		["the owner first", "UPDATE t SET label = $3 WHERE user_id = $2 AND id = $1::uuid"],
		["an aliased owner", "DELETE FROM t s USING u WHERE s.id = $1 AND s.user_id = $2"],
		[
			"a CTE that keeps it",
			"WITH gone AS (DELETE FROM t WHERE user_id = $1 AND purpose = $2) INSERT INTO x VALUES (1)",
		],
	])("accepts %s", (_case, sql) => {
		const accepted = rowChangesIn("core/planted.ts", sql).map((change) => ({
			...change,
			table: UNKNOWN_TABLE,
		}));

		expect(accepted).toHaveLength(1);
		expect(withoutOwnerPredicate(accepted)).toStrictEqual([]);
	});
});

//the compiler resolves each call to the declaration it reaches and a common name reaches nothing else
function programOver(tree: SourceTree): ts.Program {
	const options: ts.CompilerOptions = {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		types: [],
	};
	const host = ts.createCompilerHost(options, true);
	const readFromDisk = host.getSourceFile.bind(host);
	host.getSourceFile = (fileName, language) => {
		const relative = fileName.startsWith(SOURCE_ROOT) ? fileName.slice(SOURCE_ROOT.length) : null;
		const text = relative === null ? undefined : tree.get(relative);
		return text === undefined
			? readFromDisk(fileName, language)
			: ts.createSourceFile(fileName, text, language, true, ts.ScriptKind.TS);
	};
	host.fileExists = (fileName) =>
		(fileName.startsWith(SOURCE_ROOT) && tree.has(fileName.slice(SOURCE_ROOT.length))) ||
		ts.sys.fileExists(fileName);
	return ts.createProgram(
		[...tree.keys()].map((path) => `${SOURCE_ROOT}${path}`),
		options,
		host,
	);
}

function containerNameOf(declaration: ts.Node): string | null {
	const owner = declaration.parent;
	if (ts.isInterfaceDeclaration(owner)) {
		return owner.name.text;
	}
	if (ts.isTypeLiteralNode(owner) && ts.isTypeAliasDeclaration(owner.parent)) {
		return owner.parent.name.text;
	}
	return null;
}

function memberName(member: ts.Node): string | null {
	const named =
		ts.isPropertyAssignment(member) ||
		ts.isMethodDeclaration(member) ||
		ts.isShorthandPropertyAssignment(member);
	return named && ts.isIdentifier(member.name) ? member.name.text : null;
}

//an object literal typed as an interface is where that interface's members are implemented
function implementationsOf(program: ts.Program): Map<string, ts.Node[]> {
	const checker = program.getTypeChecker();
	const found = new Map<string, ts.Node[]>();
	for (const file of program.getSourceFiles()) {
		if (!file.fileName.startsWith(SOURCE_ROOT)) {
			continue;
		}
		everyNode(file, (node) => {
			if (!ts.isObjectLiteralExpression(node)) {
				return;
			}
			const type = checker.getContextualType(node);
			const typeName = type?.aliasSymbol?.name ?? type?.getSymbol()?.name;
			for (const member of node.properties) {
				const name = memberName(member);
				if (typeName !== undefined && name !== null) {
					const key = `${typeName}.${name}`;
					found.set(key, [...(found.get(key) ?? []), member]);
				}
			}
		});
	}
	return found;
}

function declarationsBehind(checker: ts.TypeChecker, node: ts.Node): readonly ts.Declaration[] {
	const symbol = checker.getSymbolAtLocation(node);
	if (symbol === undefined) {
		return [];
	}
	const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
	return (target.declarations ?? []).filter((declaration) =>
		declaration.getSourceFile().fileName.startsWith(SOURCE_ROOT),
	);
}

function fileOf(node: ts.Node): string {
	return node.getSourceFile().fileName.slice(SOURCE_ROOT.length);
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isArrowFunction(node) ||
		ts.isFunctionExpression(node)
	);
}

//a callback handed to a call runs as part of the function, a function it defines does not
function callsMadeBy(body: ts.Node): ts.CallExpression[] {
	const calls: ts.CallExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (isFunctionLike(node) && !ts.isCallExpression(node.parent)) {
			return;
		}
		if (ts.isCallExpression(node)) {
			calls.push(node);
		}
		node.forEachChild(visit);
	};
	body.forEachChild(visit);
	return calls;
}

function returnedExpressions(declaration: ts.Node): ts.Expression[] {
	const body = isFunctionLike(declaration) ? declaration.body : undefined;
	if (body === undefined) {
		return [];
	}
	if (!ts.isBlock(body)) {
		return [body];
	}
	const returned: ts.Expression[] = [];
	everyNode(body, (node) => {
		if (ts.isReturnStatement(node) && node.expression !== undefined) {
			returned.push(node.expression);
		}
	});
	return returned;
}

function bodyOf(declaration: ts.Node): ts.Node | undefined {
	if (isFunctionLike(declaration)) {
		return declaration.body;
	}
	if (ts.isPropertyAssignment(declaration) || ts.isVariableDeclaration(declaration)) {
		const value = declaration.initializer;
		return value !== undefined && isFunctionLike(value) ? value.body : undefined;
	}
	return undefined;
}

interface StatementIndex {
	issuedBy(call: ts.CallExpression): ReadonlySet<string>;
}

//a call issues the SQL it hands to a driver's query or whatever the implementation it resolves to issues
function statementIndex(program: ts.Program): StatementIndex {
	const checker = program.getTypeChecker();
	const implementations = implementationsOf(program);
	const memo = new Map<ts.Node, Set<string>>();

	function resolved(callee: ts.Node): readonly ts.Node[] {
		const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
		return declarationsBehind(checker, name).flatMap((declaration) => {
			const container = containerNameOf(declaration);
			if (container !== null && ts.isIdentifier(name)) {
				return implementations.get(`${container}.${name.text}`) ?? [];
			}
			return [declaration];
		});
	}

	function sqlOf(expression: ts.Node, seen: Set<ts.Node>): string[] {
		if (seen.has(expression)) {
			return [];
		}
		seen.add(expression);
		const literal = sqlTextOf(expression);
		if (literal !== null) {
			return [`${fileOf(expression)}\u0000${literal}`];
		}
		if (ts.isIdentifier(expression)) {
			return declarationsBehind(checker, expression).flatMap((declaration) =>
				ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
					? sqlOf(declaration.initializer, seen)
					: [],
			);
		}
		if (ts.isCallExpression(expression)) {
			return resolved(expression.expression).flatMap((declaration) =>
				returnedExpressions(declaration).flatMap((returned) => sqlOf(returned, seen)),
			);
		}
		if (ts.isConditionalExpression(expression)) {
			return [...sqlOf(expression.whenTrue, seen), ...sqlOf(expression.whenFalse, seen)];
		}
		return ts.isParenthesizedExpression(expression) ? sqlOf(expression.expression, seen) : [];
	}

	function issuedBy(call: ts.CallExpression): Set<string> {
		const callee = call.expression;
		if (ts.isPropertyAccessExpression(callee) && callee.name.text === "query") {
			const [statement] = call.arguments;
			return new Set(statement === undefined ? [] : sqlOf(statement, new Set()));
		}
		const found = new Set<string>();
		for (const declaration of resolved(callee)) {
			for (const statement of issuedByDeclaration(declaration)) {
				found.add(statement);
			}
		}
		return found;
	}

	function issuedByDeclaration(declaration: ts.Node): Set<string> {
		const known = memo.get(declaration);
		if (known !== undefined) {
			return known;
		}
		const found = new Set<string>();
		memo.set(declaration, found);
		const body = bodyOf(declaration);
		for (const call of body === undefined ? [] : callsMadeBy(body)) {
			for (const statement of issuedBy(call)) {
				found.add(statement);
			}
		}
		return found;
	}

	return { issuedBy };
}

const SELECTS_THE_OWNER = /^\s*SELECT\b[\s\S]*?\buser_id\b[\s\S]*?\bFROM\s+(\$\{[^}]+\}|\w+)/i;

const BY_ID = /^(?:(?:\w+|\$\{\w+\})\.)?(?:id|\$\{idColumn\})\s*=\s*\$\d+(?:::uuid)?$/i;

//a change reached by the row's identifier and bound to no owner, the shape a prior read decides for
function isByIdAlone(change: RowChange): boolean {
	return !hasOwnerPredicate(change) && change.conjuncts.some((conjunct) => BY_ID.test(conjunct));
}

interface Classified {
	readonly readsOwnerOf: ReadonlySet<string>;
	readonly changesUnboundOn: ReadonlySet<string>;
}

function classified(statements: ReadonlySet<string>, tree: SourceTree): Classified {
	const readsOwnerOf = new Set<string>();
	const changesUnboundOn = new Set<string>();
	for (const statement of statements) {
		const [file = "", sql = ""] = statement.split("\u0000");
		const named = tablesNamedIn(tree.get(file) ?? "");
		const select = SELECTS_THE_OWNER.exec(sql);
		if (select !== null) {
			readsOwnerOf.add(resolvedTable(select[1] ?? "", named));
		}
		for (const change of rowChangesIn(file, sql)) {
			if (isByIdAlone(change)) {
				changesUnboundOn.add(resolvedTable(change.table, named));
			}
		}
	}
	return { readsOwnerOf, changesUnboundOn };
}

function reportedNameOf(node: ts.FunctionLikeDeclaration): string {
	const holder =
		ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ? node : node.parent;
	const name = (holder as { name?: ts.Node }).name;
	return name !== undefined && ts.isIdentifier(name) ? name.text : "(anonymous)";
}

//a read of the owner in one call before a change by id alone in a later call is the shape the second threshold counts
function readsOwnerBeforeAnUnboundChange(tree: SourceTree): string[] {
	const program = programOver(tree);
	const index = statementIndex(program);
	const findings = new Set<string>();
	for (const file of program.getSourceFiles()) {
		if (!file.fileName.startsWith(SOURCE_ROOT)) {
			continue;
		}
		everyNode(file, (node) => {
			if (!isFunctionLike(node) || node.body === undefined) {
				return;
			}
			const events = callsMadeBy(node.body).map((call) => classified(index.issuedBy(call), tree));
			events.forEach((event, position) => {
				for (const table of event.readsOwnerOf) {
					if (events.slice(position + 1).some((later) => later.changesUnboundOn.has(table))) {
						findings.add(`${fileOf(node)}: ${reportedNameOf(node)} [${table}]`);
					}
				}
			});
		});
	}
	return [...findings].sort();
}

describe("T-OWNER-2: no owner is read before a change that does not bind it (S-OWNER-2)", () => {
	const tree = readSourceTree();

	it("sees a planted read-then-delete, so the scan can find one", () => {
		const planted = new Map([
			...tree,
			[
				"core/planted.ts",
				[
					'const table = qualifiedTableName(schema, "identity");',
					`async function plantedOwnerOf(id) { return driver.query(\`SELECT user_id FROM \${table} WHERE id = $1\`, [id]); }`,
					`async function plantedRemove(id) { return driver.query(\`DELETE FROM \${table} WHERE id = $1\`, [id]); }`,
					"export async function plantedUnlink(id) { await plantedOwnerOf(id); await plantedRemove(id); }",
				].join("\n"),
			],
		]);

		expect(readsOwnerBeforeAnUnboundChange(planted)).toContain(
			"core/planted.ts: plantedUnlink [identity]",
		);
	});

	//the plugin revocation reads the owner and then deletes by id alone (S-OWNER-2)
	it.fails("finds no function that reads an owner and then changes the row unbound", () => {
		expect(readsOwnerBeforeAnUnboundChange(tree)).toStrictEqual([]);
	});

	it("finds exactly the plugin revocation, so the open finding is the one it names", () => {
		expect(readsOwnerBeforeAnUnboundChange(tree)).toStrictEqual([
			"core/plugin/context.ts: revokeSession [session]",
		]);
	});
});
