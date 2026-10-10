import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

//no sealing transaction may read the state twice (E-3157)

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const SEALING_MODULE = "core/security-state/sealing.ts";
const READ_MODULE = "core/security-state/read.ts";

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

interface FunctionFacts {
	readonly name: string;
	readonly calls: readonly { readonly callee: string; readonly firstArgument: string }[];
}

function functionsOf(path: string, text: string): FunctionFacts[] {
	const file = ts.createSourceFile(path, text, ts.ScriptTarget.ES2023, true);
	const facts: FunctionFacts[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
			const calls: { callee: string; firstArgument: string }[] = [];
			const collect = (inner: ts.Node): void => {
				if (ts.isCallExpression(inner)) {
					calls.push({
						callee: inner.expression.getText(file),
						firstArgument: inner.arguments[0]?.getText(file) ?? "",
					});
				}
				ts.forEachChild(inner, collect);
			};
			collect(node.body);
			facts.push({ name: node.name.text, calls });
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return facts;
}

function readsOfState(facts: FunctionFacts): number {
	return facts.calls.filter((call) => call.callee === "readSecurityState").length;
}

function findingsInFunction(path: string, facts: FunctionFacts): string[] {
	const findings: string[] = [];
	const locks = facts.calls.some((call) => call.callee === "lockAccountRow");
	if (locks && readsOfState(facts) > 1) {
		findings.push(`${path}#${facts.name} reads the state more than once under the lock`);
	}
	if (path !== SEALING_MODULE) {
		return findings;
	}
	for (const call of facts.calls) {
		const handsOverTheChange =
			call.callee === "change.write" ||
			call.callee === "change.afterSeal" ||
			call.callee === "context.convertUnsealed";
		if (handsOverTheChange && call.firstArgument !== "guarded") {
			findings.push(`${path}#${facts.name} hands ${call.callee} the unguarded transaction`);
		}
	}
	return findings;
}

function scan(sources: ReadonlyMap<string, string>): string[] {
	const findings: string[] = [];
	for (const [path, text] of sources) {
		if (path !== READ_MODULE && text.includes("(SELECT jsonb_build_object(\n  'user_id'")) {
			findings.push(`${path} spells the state read outside ${READ_MODULE}`);
		}
		for (const facts of functionsOf(path, text)) {
			findings.push(...findingsInFunction(path, facts));
		}
	}
	return findings;
}

function shippedSources(): Map<string, string> {
	return new Map(
		sourceFiles(sourceRoot).map((path) => [path, readFileSync(`${sourceRoot}${path}`, "utf8")]),
	);
}

describe("a sealing transaction reads the state once", () => {
	it("finds the read and the sealing module in the tree", () => {
		const sources = shippedSources();
		const sealing = functionsOf(SEALING_MODULE, sources.get(SEALING_MODULE) ?? "");

		expect(sealing.find((facts) => facts.name === "sealUnderAccountLock")).toBeDefined();
		expect(
			readsOfState(
				sealing.find((facts) => facts.name === "sealUnderAccountLock") ?? { name: "", calls: [] },
			),
		).toBe(1);
	});

	it("finds no function that locks the account and reads the state twice, and no change handed the bare transaction", () => {
		expect(scan(shippedSources())).toEqual([]);
	});

	it("reports a second read planted under the lock", () => {
		const sources = shippedSources();
		const sealing = sources.get(SEALING_MODULE) ?? "";
		const planted = sealing.replace(
			"const written = await change.write(guarded, read, { version, sessionEpoch });",
			"const written = await change.write(guarded, read, { version, sessionEpoch });\n\tawait readSecurityState(tx, context.schema, userId);",
		);
		expect(planted).not.toBe(sealing);

		expect(scan(new Map([...sources, [SEALING_MODULE, planted]]))).toEqual([
			"core/security-state/sealing.ts#sealUnderAccountLock reads the state more than once under the lock",
		]);
	});

	it("reports a change handed the transaction without the guard", () => {
		const sources = shippedSources();
		const sealing = sources.get(SEALING_MODULE) ?? "";
		const planted = sealing.replace(
			"await change.write(guarded, read, {",
			"await change.write(tx, read, {",
		);
		expect(planted).not.toBe(sealing);

		expect(scan(new Map([...sources, [SEALING_MODULE, planted]]))).toEqual([
			"core/security-state/sealing.ts#sealUnderAccountLock hands change.write the unguarded transaction",
		]);
	});

	it("reports the state read spelled in another module", () => {
		const sources = shippedSources();
		const statement =
			(sources.get(READ_MODULE) ?? "").match(
				/\x60\(SELECT jsonb_build_object\([^\x60]*\x60/,
			)?.[0] ?? "";
		expect(statement).not.toBe("");

		expect(
			scan(new Map([...sources, ["core/elsewhere.ts", `export const copy = ${statement};`]])),
		).toEqual([`core/elsewhere.ts spells the state read outside ${READ_MODULE}`]);
	});
});
