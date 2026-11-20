import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Architecture 3.15 B.4 names `RedeemResetResult` as the answer of `password.redeemReset`, and the
 * rules ask that the public interface be usable without reading the documentation. A caller who
 * has to narrow the union on `status` in a function of its own needs the type by name from the
 * package, as it has `SetPasswordResult` and `SignInResult` today.
 */

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

function namesTheEntryExports(): readonly string[] {
	const program = ts.createProgram([entry], {
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		target: ts.ScriptTarget.ES2022,
		strict: true,
		noEmit: true,
		skipLibCheck: true,
	});
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(entry);
	const module = source === undefined ? undefined : checker.getSymbolAtLocation(source);
	return module === undefined
		? []
		: checker.getExportsOfModule(module).map((symbol) => symbol.name);
}

describe("the result types of the mailed reset at the package entry", () => {
	it("exports RedeemResetResult beside SetPasswordResult", () => {
		const exported = namesTheEntryExports();

		expect(exported).toContain("SetPasswordResult");
		expect(exported).toContain("RedeemResetResult");
	}, 60_000);
});
