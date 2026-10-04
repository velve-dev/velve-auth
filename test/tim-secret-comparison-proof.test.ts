import { appendFileSync, cpSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

const sourceDirectory = fileURLToPath(new URL("../src", import.meta.url));
const repositoryDirectory = fileURLToPath(new URL("..", import.meta.url));

const diagnosticHost: ts.FormatDiagnosticsHost = {
	getCanonicalFileName: (name) => name,
	getCurrentDirectory: () => repositoryDirectory,
	getNewLine: () => "\n",
};

/** The options `pnpm typecheck` runs under, so the scan sees the types the build sees. */
function repositoryCompilerOptions(): ts.CompilerOptions {
	const path = join(repositoryDirectory, "tsconfig.json");
	const read = ts.readConfigFile(path, ts.sys.readFile);
	return ts.parseJsonConfigFileContent(read.config, ts.sys, repositoryDirectory).options;
}

/** T-TIM-3's list: every comparison operator and every comparison method. */
const COMPARISON_OPERATORS = new Set([
	ts.SyntaxKind.EqualsEqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsEqualsToken,
	ts.SyntaxKind.EqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsToken,
]);
const COMPARISON_METHODS = new Set(["startsWith", "includes", "localeCompare", "indexOf"]);

const BRAND_DECLARATION_FILE = join("core", "password", "secret.ts");
const BRAND_NAME = "SECRET_BRAND";

interface Finding {
	readonly file: string;
	readonly line: number;
	readonly text: string;
}

function typeScriptFilesUnder(directory: string): string[] {
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
}

function isBrandProperty(symbol: ts.Symbol, root: string): boolean {
	return (symbol.declarations ?? []).some((declaration) => {
		const name = (declaration as ts.PropertySignature).name;
		return (
			name !== undefined &&
			ts.isComputedPropertyName(name) &&
			ts.isIdentifier(name.expression) &&
			name.expression.text === BRAND_NAME &&
			relative(root, declaration.getSourceFile().fileName) === BRAND_DECLARATION_FILE
		);
	});
}

function carriesTheSecretBrand(checker: ts.TypeChecker, type: ts.Type, root: string): boolean {
	const constrained = checker.getBaseConstraintOfType(type) ?? type;
	if (constrained.isUnion()) {
		return constrained.types.some((member) => carriesTheSecretBrand(checker, member, root));
	}
	return checker
		.getPropertiesOfType(constrained)
		.some((property) => isBrandProperty(property, root));
}

/** The type-aware form of T-TIM-3 over `<root>/core/**`, with `root` the directory holding `core`. */
function secretComparisonsUnder(root: string): Finding[] {
	const files = typeScriptFilesUnder(join(root, "core"));
	const program = ts.createProgram(files, { ...repositoryCompilerOptions(), noEmit: true });
	const unresolved = ts.getPreEmitDiagnostics(program);
	if (unresolved.length > 0) {
		//a type the checker could not resolve is any and would hide a comparison from the scan
		throw new Error(ts.formatDiagnostics(unresolved, diagnosticHost));
	}
	const checker = program.getTypeChecker();
	const isSecret = (node: ts.Expression) =>
		carriesTheSecretBrand(checker, checker.getTypeAtLocation(node), root);
	const findings: Finding[] = [];

	for (const file of files) {
		const source = program.getSourceFile(file);
		if (source === undefined) {
			throw new Error(`${file} was not part of the program`);
		}
		const record = (node: ts.Node) =>
			findings.push({
				file: relative(root, file),
				line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
				text: node.getText(source),
			});
		const visit = (node: ts.Node): void => {
			if (
				ts.isBinaryExpression(node) &&
				COMPARISON_OPERATORS.has(node.operatorToken.kind) &&
				(isSecret(node.left) || isSecret(node.right))
			) {
				record(node);
			}
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				COMPARISON_METHODS.has(node.expression.name.text) &&
				(isSecret(node.expression.expression) || node.arguments.some(isSecret))
			) {
				record(node);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return findings;
}

const plantedCopies: string[] = [];

afterAll(() => {
	for (const copy of plantedCopies) {
		rmSync(copy, { recursive: true, force: true });
	}
});

describe("T-TIM-3 — no comparison operator or method touches a Secret (S-TIM-3)", () => {
	it("finds no violation in src/core within five seconds", () => {
		const started = performance.now();
		const findings = secretComparisonsUnder(sourceDirectory);
		const elapsed = performance.now() - started;

		expect(findings).toStrictEqual([]);
		expect(elapsed, `the scan took ${Math.round(elapsed)} ms`).toBeLessThan(5_000);
	}, 30_000);

	it("reports exactly one finding for a planted `derived === other`", () => {
		const workspace = mkdtempSync(join(tmpdir(), "velve-tim3-"));
		plantedCopies.push(workspace);
		const copy = join(workspace, "src");
		cpSync(sourceDirectory, copy, { recursive: true });
		symlinkSync(join(repositoryDirectory, "node_modules"), join(workspace, "node_modules"), "dir");
		appendFileSync(
			join(copy, BRAND_DECLARATION_FILE),
			"\nexport function plantedComparison(derived: DerivedKey, other: DerivedKey): boolean {\n\treturn derived === other;\n}\n",
		);

		expect(secretComparisonsUnder(copy)).toStrictEqual([
			expect.objectContaining({ file: BRAND_DECLARATION_FILE, text: "derived === other" }),
		]);
	}, 30_000);
});
