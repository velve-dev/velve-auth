import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropSchema, type MigratedSchema, openMigratedSchema } from "./db-fixtures.js";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const proofModule = "core/db/actor.ts";
const migrationModules = "core/db/migrations/";

const OWNER_COLUMNS = ["user_id", "link_to_user_id"] as const;

const LOOKS_LIKE_SQL = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;

//a table with an owner column and no line here fails the census so none arrives without a decision
const OWNER_TABLE_DECISIONS: Readonly<Record<string, string>> = {
	password_credential: "src/core/password/credential.ts",
	identity: "src/core/oauth/identity-repository.ts",
	session: "src/core/db/repositories/session.ts",
	one_time_token: "src/core/db/repositories/token.ts",
	pending_authentication: "src/core/factor/pending/repository.ts",
	totp_credential: "src/core/factor/totp/repository.ts",
	totp_used_step: "src/core/factor/totp/repository.ts",
	recovery_code: "src/core/factor/recovery/repository.ts",
	webauthn_credential: "src/core/factor/webauthn/credential-repository.ts",
	webauthn_challenge: "src/core/factor/webauthn/challenge.ts",
	oauth_flow: "src/core/oauth/flow-repository.ts",
	import_mapping: "no repository: no module of the library reads or writes it",
	password_reset_required: "src/core/security-state/read.ts",
	//the session and pending repositories read the session epoch, the start probes key versions (E-3138, E-3191)
	security_state:
		"src/core/db/repositories/session.ts, src/core/factor/pending/repository.ts, src/core/auth/security-state.ts and src/core/auth/integrity-key-ring.ts",
};

const NO_REPOSITORY = "no repository:";

type ExceptionClass =
	| "secret address"
	| "consumed single-use row"
	| "account the path already named"
	| "row that carries the proof"
	| "credential under verification"
	| "pending resolution"
	| "provider subject"
	| "maintenance or start-up"
	| "shipped surface"
	| "created with its account"
	| "account a sign-in decided"
	| "the repository on another driver"
	| "seal row beside its envelope";

//each class narrows the requirement the way the decision log records it (E-242)
const EXCEPTION_CLASSES: Readonly<Record<ExceptionClass, string>> = {
	"secret address":
		"the row is addressed by the hash of a secret the caller presents, and the hash is a stronger predicate than the owner (E-242, E-2421)",
	"consumed single-use row":
		"the statement that removes the row is what proves the owner, and it hands that proof back (E-234, E-2421)",
	"account the path already named":
		"the statement reads or seals the security state of the one account the calling path has already named by its own proof, lookup, consumption or resolution, and decides nothing about which account that is (E-3153)",
	"row that carries the proof":
		"the insert writes the row whose secret later proves the owner, so no proof can precede it (E-242, E-2422)",
	"credential under verification":
		"the method reads or writes back the credential a sign-in is verifying, before or as the proof comes into being (E-2423)",
	"pending resolution":
		"the owner is the one a pending row named when its token hash resolved it, a structural value and not a brand (E-459, E-2424)",
	"provider subject":
		"the row is addressed by the provider and subject pair, and the account it names is the answer rather than the question (S-LINK-1, E-2425)",
	"maintenance or start-up":
		"the method reaches every owner at once by a deadline or a catalogue, never one owner (E-2426)",
	"shipped surface":
		"the only caller is a shipped declaration that takes a user id, which this requirement may not change (E-737, E-2427)",
	"account a sign-in decided":
		"the account is one the OAuth sign-in created in the same transaction or one automatic linking joined for a trusted provider, before any session exists (E-558, E-2434)",
	"the repository on another driver":
		"the method returns the same repository, keys and mode over a lent connection and reads no row itself (E-3144)",
	"created with its account":
		"the account row was inserted by the same transaction, so no other caller can own it yet (E-2428)",
	"seal row beside its envelope":
		"the condition only asks whether a seal row exists, correlated to the owner of the row the enclosing statement already reached by its own predicate (E-3121)",
};

const EXCEPTIONS: Readonly<Record<string, ExceptionClass>> = {
	"src/core/db/repositories/session.ts#createSessionRepository.findSessionByTokenHash":
		"secret address",
	"src/core/db/repositories/session.ts#createSessionRepository.deleteSessionByTokenHash":
		"secret address",
	"src/core/db/repositories/session.ts#createSessionRepository.replaceSession": "secret address",
	"src/core/db/repositories/session.ts#createSessionRepository.replacePresentedSession":
		"secret address",
	"src/core/factor/pending/repository.ts#createPendingAuthenticationRepository.findPendingAuthenticationByTokenHash":
		"secret address",
	"src/core/factor/pending/repository.ts#createPendingAuthenticationRepository.bookAttempt":
		"secret address",
	"src/core/factor/pending/repository.ts#createPendingAuthenticationRepository.deletePendingAuthenticationByTokenHash":
		"secret address",

	"src/core/db/repositories/token.ts#createOneTimeTokenRepository.consumeOneTimeToken":
		"consumed single-use row",
	"src/core/oauth/flow-repository.ts#createOAuthFlowRepository.consumeFlow":
		"consumed single-use row",
	"src/core/factor/webauthn/challenge.ts#createWebAuthnChallenges.consume":
		"consumed single-use row",
	"src/core/factor/recovery/repository.ts#createRecoveryCodeRepository.consumeCode":
		"consumed single-use row",

	"src/core/security-state/read.ts#securityStateReadStatement": "account the path already named",
	"src/core/security-state/read.ts#readSecurityState": "account the path already named",
	"src/core/security-state/read.ts#securityStateDocumentOf": "account the path already named",
	"src/core/security-state/sealing.ts#sealUnderAccountLock": "account the path already named",
	"src/core/security-state/sealing.ts#sealCreatedAccount": "account the path already named",
	"src/core/security-state/sealing.ts#sealAccount": "account the path already named",

	"src/core/db/repositories/session.ts#createSessionRepository.boundTo":
		"the repository on another driver",
	"src/core/db/repositories/session.ts#createSessionRepository.insertSession":
		"row that carries the proof",
	"src/core/factor/pending/repository.ts#createPendingAuthenticationRepository.insertPendingAuthentication":
		"row that carries the proof",
	"src/core/db/repositories/token.ts#createOneTimeTokenRepository.replaceOneTimeToken":
		"row that carries the proof",
	"src/core/factor/webauthn/challenge.ts#createWebAuthnChallenges.issue":
		"row that carries the proof",

	"src/core/password/credential.ts#createPasswordCredentialRepository.findByUserId":
		"credential under verification",
	"src/core/password/credential.ts#createPasswordCredentialRepository.writeForCreatedAccount":
		"created with its account",
	"src/core/password/credential.ts#createPasswordCredentialRepository.replaceIfUnchanged":
		"credential under verification",
	"src/core/factor/recovery/repository.ts#createRecoveryCodeRepository.pepperVersionsOf":
		"credential under verification",
	"src/core/factor/webauthn/credential-repository.ts#createWebAuthnCredentialRepository.findCredentialByCredentialId":
		"credential under verification",
	"src/core/factor/webauthn/credential-repository.ts#createWebAuthnCredentialRepository.recordAssertion":
		"credential under verification",

	//the epoch a new pending row binds is read for the account whose row the insert writes (E-3484)
	"src/core/factor/pending/repository.ts#createPendingAuthenticationRepository.sessionEpochOf":
		"row that carries the proof",
	"src/core/factor/totp/repository.ts#createTotpRepository.findCredentialOf": "pending resolution",
	"src/core/factor/totp/repository.ts#createTotpRepository.claimTimeStepOfPending":
		"pending resolution",
	"src/core/factor/webauthn/credential-repository.ts#createWebAuthnCredentialRepository.listDescriptorsOwnedBy":
		"pending resolution",
	"src/core/factor/webauthn/credential-repository.ts#createWebAuthnCredentialRepository.findOwnedCredentialByCredentialId":
		"pending resolution",

	"src/core/oauth/identity-repository.ts#createOAuthIdentityRepository.findIdentityBySubject":
		"provider subject",
	"src/core/oauth/identity-repository.ts#createOAuthIdentityRepository.refreshIdentity":
		"provider subject",
	"src/core/oauth/identity-repository.ts#createOAuthIdentityRepository.insertIdentityOfSignIn":
		"account a sign-in decided",

	"src/core/auth/maintenance.ts#sweepExpiredRows": "maintenance or start-up",
	"src/core/auth/security-state.ts#sealRowPresentFor": "seal row beside its envelope",
	"src/core/factor/startup.ts#assertStoredFactorKeyVersionsAreKnown": "maintenance or start-up",
	"src/core/password/startup.ts#assertStoredKeyVersionsAreKnown": "maintenance or start-up",
	"src/core/auth/integrity-key-ring.ts#assertStoredIntegrityKeysTakeMac": "maintenance or start-up",
	"src/core/token/rebind.ts#rebindTokenRowsUnderCurrentKey": "maintenance or start-up",
	"src/core/auth/integrity-key-ring.ts#schemaHoldsTheSealTable": "maintenance or start-up",
	"src/core/db/cascade-guard.ts#assertEveryUserReferenceCascades": "maintenance or start-up",

	"src/core/db/repositories/session.ts#createSessionRepository.listSessionsOfUser":
		"shipped surface",
	"src/core/db/repositories/session.ts#createSessionRepository.findOwnerOfSession":
		"shipped surface",
	"src/core/db/repositories/session.ts#createSessionRepository.deleteSessionById":
		"shipped surface",
	"src/core/factor/totp/repository.ts#createTotpRepository.isConfirmedFor": "shipped surface",
	"src/core/auth/user.ts#createUserRepository.findUserById": "shipped surface",
	"src/core/auth/user.ts#createUserRepository.findUserByEmail": "shipped surface",
	"src/core/auth/user.ts#createUserRepository.findUserByUsernameKey": "shipped surface",
};

interface CensusEntry {
	readonly unit: string;
	readonly tables: readonly string[];
	readonly carriesProof: boolean;
}

function sourceFiles(directory: string, prefix = ""): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			found.push(...sourceFiles(`${directory}${entry.name}/`, `${prefix}${entry.name}/`));
		} else if (entry.name.endsWith(".ts")) {
			found.push(`${prefix}${entry.name}`);
		}
	}
	return found;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
	target: ts.ScriptTarget.ES2023,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	strict: true,
	exactOptionalPropertyTypes: true,
	noEmit: true,
	skipLibCheck: true,
	types: [],
};

function isExported(node: ts.Node): boolean {
	return (
		ts.canHaveModifiers(node) &&
		(ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
	);
}

type Callable = ts.FunctionLikeDeclaration;

function isCallable(node: ts.Node): node is Callable {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node)
	);
}

function unwrapped(expression: ts.Expression): ts.Expression {
	let current = expression;
	for (;;) {
		if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) {
			current = current.expression;
		} else if (
			ts.isCallExpression(current) &&
			current.expression.getText() === "Object.freeze" &&
			current.arguments[0] !== undefined
		) {
			current = current.arguments[0];
		} else {
			return current;
		}
	}
}

function returnedObjectLiterals(callable: Callable): ts.ObjectLiteralExpression[] {
	const found: ts.ObjectLiteralExpression[] = [];
	const body = callable.body;
	if (body === undefined) {
		return found;
	}
	if (!ts.isBlock(body)) {
		const value = unwrapped(body);
		return ts.isObjectLiteralExpression(value) ? [value] : [];
	}
	const visit = (node: ts.Node): void => {
		if (isCallable(node)) {
			return;
		}
		if (ts.isReturnStatement(node) && node.expression !== undefined) {
			const value = unwrapped(node.expression);
			if (ts.isObjectLiteralExpression(value)) {
				found.push(value);
			}
		}
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(body, visit);
	return found;
}

function declarationNamedBy(
	expression: ts.Expression,
	checker: ts.TypeChecker,
): ts.Declaration | undefined {
	if (!ts.isIdentifier(expression)) {
		return undefined;
	}
	const symbol = checker.getSymbolAtLocation(expression);
	if (symbol === undefined) {
		return undefined;
	}
	const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
	return target.declarations?.[0];
}

function callableNamedBy(expression: ts.Expression, checker: ts.TypeChecker): Callable | undefined {
	if (isCallable(expression)) {
		return expression;
	}
	const declaration = declarationNamedBy(expression, checker);
	if (declaration !== undefined && isCallable(declaration)) {
		return declaration;
	}
	if (
		declaration !== undefined &&
		ts.isVariableDeclaration(declaration) &&
		declaration.initializer !== undefined &&
		isCallable(declaration.initializer)
	) {
		return declaration.initializer;
	}
	return undefined;
}

function objectLiteralNamedBy(
	expression: ts.Expression,
	checker: ts.TypeChecker,
): ts.ObjectLiteralExpression | undefined {
	const value = unwrapped(expression);
	if (ts.isObjectLiteralExpression(value)) {
		return value;
	}
	const declaration = declarationNamedBy(value, checker);
	if (
		declaration !== undefined &&
		ts.isVariableDeclaration(declaration) &&
		declaration.initializer !== undefined
	) {
		const initial = unwrapped(declaration.initializer);
		return ts.isObjectLiteralExpression(initial) ? initial : undefined;
	}
	return undefined;
}

//a spread contributes the methods of the object it spreads, called or named
function spreadLiterals(
	spread: ts.SpreadAssignment,
	checker: ts.TypeChecker,
): ts.ObjectLiteralExpression[] {
	const value = unwrapped(spread.expression);
	if (ts.isCallExpression(value)) {
		const callee = callableNamedBy(value.expression, checker);
		return callee === undefined ? [] : returnedObjectLiterals(callee);
	}
	const literal = objectLiteralNamedBy(value, checker);
	return literal === undefined ? [] : [literal];
}

function methodOf(
	property: ts.ObjectLiteralElementLike,
	checker: ts.TypeChecker,
): Callable | undefined {
	if (ts.isMethodDeclaration(property)) {
		return property;
	}
	if (ts.isPropertyAssignment(property)) {
		return callableNamedBy(property.initializer, checker);
	}
	if (ts.isShorthandPropertyAssignment(property)) {
		const declaration = checker.getShorthandAssignmentValueSymbol(property)?.declarations?.[0];
		if (declaration !== undefined && isCallable(declaration)) {
			return declaration;
		}
		if (
			declaration !== undefined &&
			ts.isVariableDeclaration(declaration) &&
			declaration.initializer !== undefined &&
			isCallable(declaration.initializer)
		) {
			return declaration.initializer;
		}
	}
	return undefined;
}

function methodsOf(
	literal: ts.ObjectLiteralExpression,
	checker: ts.TypeChecker,
	seen: Set<ts.Node> = new Set(),
): [string, Callable][] {
	if (seen.has(literal)) {
		return [];
	}
	seen.add(literal);
	const methods: [string, Callable][] = [];
	for (const property of literal.properties) {
		if (ts.isSpreadAssignment(property)) {
			for (const spread of spreadLiterals(property, checker)) {
				methods.push(...methodsOf(spread, checker, seen));
			}
			continue;
		}
		const method = methodOf(property, checker);
		if (method !== undefined) {
			methods.push([property.name?.getText() ?? "", method]);
		}
	}
	return methods;
}

function unitsOf(path: string, name: string, callable: Callable, checker: ts.TypeChecker) {
	const literals = returnedObjectLiterals(callable).filter(
		(literal) => methodsOf(literal, checker).length > 0,
	);
	if (literals.length === 0) {
		return [[`${path}#${name}`, callable] as [string, Callable]];
	}
	return literals.flatMap((literal) =>
		methodsOf(literal, checker).map(
			([method, body]) => [`${path}#${name}.${method}`, body] as [string, Callable],
		),
	);
}

function classMethods(declaration: ts.ClassLikeDeclaration): [string, Callable][] {
	const methods: [string, Callable][] = [];
	for (const member of declaration.members) {
		if (ts.isMethodDeclaration(member) && member.body !== undefined) {
			methods.push([member.name.getText(), member]);
		} else if (
			ts.isPropertyDeclaration(member) &&
			member.initializer !== undefined &&
			isCallable(member.initializer)
		) {
			methods.push([member.name.getText(), member.initializer]);
		}
	}
	return methods;
}

function unitsOfDeclaration(
	path: string,
	name: string,
	declaration: ts.Node,
	checker: ts.TypeChecker,
): [string, Callable][] {
	if (ts.isFunctionDeclaration(declaration)) {
		return unitsOf(path, name, declaration, checker);
	}
	if (ts.isClassDeclaration(declaration)) {
		return classMethods(declaration).map(([method, body]) => [`${path}#${name}.${method}`, body]);
	}
	if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) {
		return [];
	}
	if (isCallable(declaration.initializer)) {
		return unitsOf(path, name, declaration.initializer, checker);
	}
	const literal = objectLiteralNamedBy(declaration.initializer, checker);
	return literal === undefined
		? []
		: methodsOf(literal, checker).map(([method, body]) => [`${path}#${name}.${method}`, body]);
}

function exportListed(statement: ts.Statement, checker: ts.TypeChecker): [string, ts.Node][] {
	if (
		!ts.isExportDeclaration(statement) ||
		statement.moduleSpecifier !== undefined ||
		statement.exportClause === undefined ||
		!ts.isNamedExports(statement.exportClause)
	) {
		return [];
	}
	return statement.exportClause.elements.flatMap((element): [string, ts.Node][] => {
		const declaration = checker.getExportSpecifierLocalTargetSymbol(element)?.declarations?.[0];
		return declaration === undefined ? [] : [[element.name.text, declaration]];
	});
}

function exportedDeclarations(file: ts.SourceFile, checker: ts.TypeChecker): [string, ts.Node][] {
	const declared: [string, ts.Node][] = [];
	for (const statement of file.statements) {
		declared.push(...exportListed(statement, checker));
		if (!isExported(statement)) {
			continue;
		}
		if (
			(ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
			statement.name !== undefined
		) {
			declared.push([statement.name.text, statement]);
		}
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				declared.push([declaration.name.getText(), declaration]);
			}
		}
	}
	return declared;
}

function exportedCallables(
	file: ts.SourceFile,
	checker: ts.TypeChecker,
	path: string,
): [string, Callable][] {
	return exportedDeclarations(file, checker).flatMap(([name, declaration]) =>
		unitsOfDeclaration(path, name, declaration, checker),
	);
}

function isLiteralText(
	node: ts.Node,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateLiteralLikeNode {
	return (
		ts.isStringLiteral(node) ||
		ts.isNoSubstitutionTemplateLiteral(node) ||
		ts.isTemplateHead(node) ||
		ts.isTemplateMiddle(node) ||
		ts.isTemplateTail(node)
	);
}

function sameFileBodies(node: ts.Identifier, checker: ts.TypeChecker): ts.Node[] {
	const file = node.getSourceFile();
	const bodies: ts.Node[] = [];
	for (const declaration of checker.getSymbolAtLocation(node)?.declarations ?? []) {
		if (declaration.getSourceFile() !== file) {
			continue;
		}
		if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
			bodies.push(declaration.initializer);
		} else if (ts.isFunctionDeclaration(declaration) && declaration.body !== undefined) {
			bodies.push(declaration.body);
		}
	}
	return bodies;
}

//an imported constant contributes its literal text and an imported function contributes nothing
function importedConstantText(node: ts.Identifier, checker: ts.TypeChecker): string[] {
	const declaration = declarationNamedBy(node, checker);
	if (
		declaration === undefined ||
		declaration.getSourceFile() === node.getSourceFile() ||
		!ts.isVariableDeclaration(declaration) ||
		declaration.initializer === undefined
	) {
		return [];
	}
	const value = unwrapped(declaration.initializer);
	return isLiteralText(value) ? [value.text] : [];
}

//a unit reaches its own literals and every same-file declaration it names, and an import ends the walk
function reachableText(root: Callable, checker: ts.TypeChecker): string[] {
	const texts: string[] = [];
	const visited = new Set<ts.Node>();
	const visit = (node: ts.Node): void => {
		if (visited.has(node)) {
			return;
		}
		visited.add(node);
		if (isLiteralText(node)) {
			texts.push(node.text);
		}
		if (ts.isIdentifier(node)) {
			sameFileBodies(node, checker).forEach(visit);
			texts.push(...importedConstantText(node, checker));
		}
		ts.forEachChild(node, visit);
	};
	visit(root);
	return texts;
}

function namedTables(texts: readonly string[], ownerTables: readonly string[]): string[] {
	const named = new Set<string>();
	for (const table of ownerTables) {
		const inSql = new RegExp(`(?:\\bvelve|^)\\.${table}\\b|\\bvelve\\.${table}\\b`);
		if (texts.some((text) => text === table || inSql.test(text))) {
			named.add(table);
		}
	}
	const namesOwnerColumn = (text: string): boolean =>
		OWNER_COLUMNS.some(
			(column) =>
				text === column || (LOOKS_LIKE_SQL.test(text) && new RegExp(`\\b${column}\\b`).test(text)),
		);
	if (texts.some(namesOwnerColumn)) {
		named.add("(an owner column)");
	}
	return [...named].sort();
}

function isProofBrand(symbol: ts.Symbol): boolean {
	return (symbol.declarations ?? []).some(
		(declaration) =>
			declaration.getSourceFile().fileName.endsWith(proofModule) &&
			symbol.escapedName.toString().startsWith("__@"),
	);
}

function carriesProof(type: ts.Type, checker: ts.TypeChecker, depth: number): boolean {
	if (type.isUnion()) {
		const present = type.types.filter(
			(member) => (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) === 0,
		);
		return present.length > 0 && present.every((member) => carriesProof(member, checker, depth));
	}
	const properties = checker.getPropertiesOfType(type);
	if (properties.some(isProofBrand)) {
		return true;
	}
	if (depth === 0 || (type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) === 0) {
		return false;
	}
	return properties.some((property) => {
		const declaration = property.valueDeclaration ?? property.declarations?.[0];
		return (
			declaration !== undefined &&
			carriesProof(checker.getTypeOfSymbolAtLocation(property, declaration), checker, depth - 1)
		);
	});
}

function takesProof(callable: Callable, checker: ts.TypeChecker): boolean {
	return callable.parameters.some((parameter) =>
		carriesProof(checker.getTypeAtLocation(parameter), checker, 2),
	);
}

const BARE_OWNER_NAMES = new Set(["userId", "ownerId", "user_id"]);

function isPlainString(type: ts.Type): boolean {
	const members = type.isUnion() ? type.types : [type];
	return members.some((member) => (member.flags & ts.TypeFlags.String) !== 0);
}

function fieldsNameABareOwner(type: ts.Type, checker: ts.TypeChecker): boolean {
	const members = type.isUnion() ? type.types : [type];
	return members.some((member) =>
		checker.getPropertiesOfType(member).some((property) => {
			const declaration = property.valueDeclaration ?? property.declarations?.[0];
			return (
				declaration !== undefined &&
				BARE_OWNER_NAMES.has(property.name) &&
				isPlainString(checker.getTypeOfSymbolAtLocation(property, declaration))
			);
		}),
	);
}

//a brand beside a bare user id proves nothing about the id the statement uses
function takesBareOwner(callable: Callable, checker: ts.TypeChecker): boolean {
	return callable.parameters.some((parameter) => {
		const type = checker.getTypeAtLocation(parameter);
		const named = ts.isIdentifier(parameter.name) && BARE_OWNER_NAMES.has(parameter.name.text);
		return (named && isPlainString(type)) || fieldsNameABareOwner(type, checker);
	});
}

function censusOf(program: ts.Program, ownerTables: readonly string[]): CensusEntry[] {
	const checker = program.getTypeChecker();
	const entries: CensusEntry[] = [];
	for (const file of program.getSourceFiles()) {
		if (!file.fileName.startsWith(sourceRoot)) {
			continue;
		}
		const path = file.fileName.slice(sourceRoot.length);
		if (path.startsWith(migrationModules)) {
			continue;
		}
		for (const [unit, callable] of exportedCallables(file, checker, `src/${path}`)) {
			const texts = reachableText(callable, checker);
			if (!texts.some((text) => LOOKS_LIKE_SQL.test(text))) {
				continue;
			}
			const tables = namedTables(texts, ownerTables);
			if (tables.length === 0) {
				continue;
			}
			entries.push({
				unit,
				tables,
				carriesProof: takesProof(callable, checker) && !takesBareOwner(callable, checker),
			});
		}
	}
	return entries.sort((left, right) => left.unit.localeCompare(right.unit));
}

function programOver(extra?: { readonly path: string; readonly text: string }): ts.Program {
	const roots = sourceFiles(sourceRoot).map((file) => `${sourceRoot}${file}`);
	const host = ts.createCompilerHost(COMPILER_OPTIONS);
	if (extra === undefined) {
		return ts.createProgram(roots, COMPILER_OPTIONS, host);
	}
	const planted = `${sourceRoot}${extra.path}`;
	const readFile = host.getSourceFile.bind(host);
	host.getSourceFile = (fileName, language, onError, shouldCreate) =>
		fileName === planted
			? ts.createSourceFile(fileName, extra.text, language)
			: readFile(fileName, language, onError, shouldCreate);
	const fileExists = host.fileExists.bind(host);
	host.fileExists = (fileName) => fileName === planted || fileExists(fileName);
	return ts.createProgram([...roots, planted], COMPILER_OPTIONS, host);
}

function withoutProof(census: readonly CensusEntry[]): string[] {
	return census
		.filter((entry) => !entry.carriesProof && !(entry.unit in EXCEPTIONS))
		.map((entry) => `${entry.unit} reaches ${entry.tables.join(", ")}`);
}

let migrated: MigratedSchema;
let ownerTables: string[];
let census: CensusEntry[];

beforeAll(async () => {
	migrated = await openMigratedSchema("velve_owner_census");
	const rows = await migrated.connection.query<{ table_name: string }>(
		`SELECT DISTINCT table_name FROM information_schema.columns
		 WHERE table_schema = $1 AND column_name IN ('user_id', 'link_to_user_id')
		 ORDER BY table_name`,
		[migrated.schema],
	);
	ownerTables = rows.map((row) => row.table_name);
	census = censusOf(programOver(), ownerTables);
}, 120_000);

afterAll(async () => {
	await dropSchema(migrated.connection, migrated.schema);
	await migrated.connection.close();
});

describe("every repository method on an owned table takes a proof of ownership (S-OWNER-1, T-OWNER-1)", () => {
	it("has a decision for exactly the tables the schema gives an owner column", () => {
		expect(ownerTables.length).toBeGreaterThan(10);
		expect(ownerTables).toEqual(Object.keys(OWNER_TABLE_DECISIONS).sort());
	});

	it("finds a method for every table that has a repository, and none for a table that has not", () => {
		const reached = new Set(census.flatMap((entry) => entry.tables));
		for (const [table, decision] of Object.entries(OWNER_TABLE_DECISIONS)) {
			expect(reached.has(table), `${table}: ${decision}`).toBe(!decision.startsWith(NO_REPOSITORY));
		}
	});

	it("counts zero methods that reach an owned table without a proof and without a named exception", () => {
		expect(withoutProof(census)).toEqual([]);
	});

	it("names in the exception list only methods the census finds without a proof", () => {
		const withoutAProof = new Set(
			census.filter((entry) => !entry.carriesProof).map((entry) => entry.unit),
		);
		const stale = Object.keys(EXCEPTIONS).filter((unit) => !withoutAProof.has(unit));

		expect(stale).toEqual([]);
		for (const exceptionClass of Object.values(EXCEPTIONS)) {
			expect(EXCEPTION_CLASSES[exceptionClass]).toMatch(/\bE-\d+\b/);
		}
	});

	it("reports a planted method that reaches an owned table by a bare user id, beside a brand or not", () => {
		const planted = programOver({
			path: "core/planted-census-fault.ts",
			text: `import type { Actor } from "./db/actor.js";
export function createPlanted(driver: { query(sql: string, params: unknown[]): Promise<unknown[]> }) {
	return {
		byUserId: (input: { userId: string }) =>
			driver.query("SELECT id FROM velve.session WHERE user_id = $1", [input.userId]),
		byActor: (input: { actor: Actor }) =>
			driver.query("SELECT id FROM velve.session WHERE user_id = $1", [input.actor]),
		decoy: (input: { actor: Actor; userId: string }) =>
			driver.query("SELECT id FROM velve.session WHERE user_id = $1", [input.userId]),
	};
}
`,
		});
		const found = censusOf(planted, ownerTables).filter((entry) =>
			entry.unit.startsWith("src/core/planted-census-fault.ts#"),
		);

		expect(found).toEqual([
			{
				unit: "src/core/planted-census-fault.ts#createPlanted.byActor",
				tables: ["(an owner column)", "session"],
				carriesProof: true,
			},
			{
				unit: "src/core/planted-census-fault.ts#createPlanted.byUserId",
				tables: ["(an owner column)", "session"],
				carriesProof: false,
			},
			{
				unit: "src/core/planted-census-fault.ts#createPlanted.decoy",
				tables: ["(an owner column)", "session"],
				carriesProof: false,
			},
		]);
	}, 120_000);
});

const PLANTED_DRIVER = "{ query(sql: string, params: unknown[]): Promise<unknown[]> }";

interface PlantedShape {
	readonly text: string;
	readonly unit: string;
}

//each shape names velve.session by a bare user id and is a violator however it is exported
const VIOLATOR_SHAPES: Readonly<Record<string, PlantedShape>> = {
	"an export list": {
		unit: "readsByOwner",
		text: `function readsByOwner(driver: ${PLANTED_DRIVER}, userId: string) {
	return driver.query("SELECT id FROM velve.session WHERE user_id = $1", [userId]);
}
export { readsByOwner };
`,
	},
	"a spread into the returned object": {
		unit: "createSpread.byUserId",
		text: `function byOwner(driver: ${PLANTED_DRIVER}) {
	return {
		byUserId: (input: { userId: string }) =>
			driver.query("SELECT id FROM velve.session WHERE user_id = $1", [input.userId]),
	};
}
export function createSpread(driver: ${PLANTED_DRIVER}) {
	return { ...byOwner(driver), count: () => 1 };
}
`,
	},
	"an exported class": {
		unit: "SessionReader.byUserId",
		text: `export class SessionReader {
	constructor(private readonly driver: ${PLANTED_DRIVER}) {}
	byUserId(userId: string) {
		return this.driver.query("SELECT id FROM velve.session WHERE user_id = $1", [userId]);
	}
}
`,
	},
	"an exported object": {
		unit: "sessionReader.byUserId",
		text: `declare const driver: ${PLANTED_DRIVER};
export const sessionReader = {
	byUserId(userId: string) {
		return driver.query("SELECT id FROM velve.session WHERE user_id = $1", [userId]);
	},
};
`,
	},
	"lower case SQL": {
		unit: "createLower.byUserId",
		text: `export function createLower(driver: ${PLANTED_DRIVER}) {
	return {
		byUserId: (input: { userId: string }) =>
			driver.query("select id from velve.session where user_id = $1", [input.userId]),
	};
}
`,
	},
	"a table name imported from another module": {
		unit: "createImported.removeByScheme",
		text: `import { PASSWORD_CREDENTIAL_TABLE } from "./password/credential.js";
import { qualifiedTableName } from "./db/identifier.js";
export function createImported(driver: ${PLANTED_DRIVER}, schema: string) {
	const table = qualifiedTableName(schema, PASSWORD_CREDENTIAL_TABLE);
	return {
		removeByScheme: (input: { scheme: string }) =>
			driver.query(\`DELETE FROM \${table} WHERE scheme = $1\`, [input.scheme]),
	};
}
`,
	},
};

describe("the census finds a violator whatever shape it is written in (S-OWNER-1, T-OWNER-1)", () => {
	for (const [shape, planted] of Object.entries(VIOLATOR_SHAPES)) {
		it(`reports a method written as ${shape}`, () => {
			const path = "core/planted-census-shape.ts";
			const found = censusOf(programOver({ path, text: planted.text }), ownerTables)
				.filter((entry) => entry.unit.startsWith(`src/${path}#`))
				.map((entry) => ({ unit: entry.unit, carriesProof: entry.carriesProof }));

			expect(found).toContainEqual({ unit: `src/${path}#${planted.unit}`, carriesProof: false });
		}, 120_000);
	}

	it("counts the password key version check the tree already holds", () => {
		expect(census.map((entry) => entry.unit)).toContain(
			"src/core/password/startup.ts#assertStoredKeyVersionsAreKnown",
		);
	});
});
