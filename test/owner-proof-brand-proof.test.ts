import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL("../src/", import.meta.url));
const ACTOR_MODULE = "core/db/actor.ts";

type SourceTree = ReadonlyMap<string, string>;

function readSourceTree(): SourceTree {
	const tree = new Map<string, string>();
	for (const entry of readdirSync(SOURCE_ROOT, { recursive: true, withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".ts")) {
			const path = `${entry.parentPath}/${entry.name}`;
			tree.set(path.slice(SOURCE_ROOT.length), readFileSync(path, "utf8"));
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

function referencedTypeNames(node: ts.Node): Set<string> {
	const names = new Set<string>();
	everyNode(node, (each) => {
		if (ts.isTypeReferenceNode(each)) {
			names.add(each.typeName.getText());
		}
	});
	return names;
}

//a brand is an exported type of the actor module that carries a declared unique symbol (S-OWNER-7)
function brandsDeclaredIn(actorModule: string): Set<string> {
	const brands = new Set<string>();
	parsed(ACTOR_MODULE, actorModule).forEachChild((statement) => {
		if (ts.isTypeAliasDeclaration(statement) && statement.type.getText().includes("Brand]")) {
			brands.add(statement.name.text);
		}
	});
	return brands;
}

function definitionsOf(tree: SourceTree): Map<string, readonly ts.Node[]> {
	const definitions = new Map<string, ts.Node[]>();
	for (const [path, text] of tree) {
		everyNode(parsed(path, text), (node) => {
			if (ts.isTypeAliasDeclaration(node)) {
				definitions.set(node.name.text, [...(definitions.get(node.name.text) ?? []), node.type]);
			}
			if (ts.isInterfaceDeclaration(node)) {
				const heritage = node.heritageClauses ?? [];
				definitions.set(node.name.text, [...(definitions.get(node.name.text) ?? []), ...heritage]);
			}
		});
	}
	return definitions;
}

function namesAProof(part: ts.Node, proofs: ReadonlySet<string>): boolean {
	if (ts.isTypeReferenceNode(part)) {
		return proofs.has(part.typeName.getText());
	}
	if (ts.isHeritageClause(part)) {
		return part.types.some((heritage) => proofs.has(heritage.expression.getText()));
	}
	return false;
}

function isProofItself(definition: readonly ts.Node[], proofs: ReadonlySet<string>): boolean {
	return definition.some((node) =>
		(ts.isIntersectionTypeNode(node) ? node.types : [node]).some((part) =>
			namesAProof(part, proofs),
		),
	);
}

//an alias or interface that is a brand intersected with more is a brand under another name
function proofTypesOf(tree: SourceTree): Set<string> {
	const proofs = brandsDeclaredIn(tree.get(ACTOR_MODULE) ?? "");
	const definitions = definitionsOf(tree);
	let grew = true;
	while (grew) {
		grew = false;
		for (const [name, definition] of definitions) {
			if (!proofs.has(name) && isProofItself(definition, proofs)) {
				proofs.add(name);
				grew = true;
			}
		}
	}
	return proofs;
}

interface Assertion {
	readonly file: string;
	readonly proof: string;
}

function assertedProofs(node: ts.Node, proofs: ReadonlySet<string>): string[] {
	if (!ts.isAsExpression(node) && !ts.isTypeAssertionExpression(node)) {
		return [];
	}
	return [...referencedTypeNames(node.type)].filter((name) => proofs.has(name));
}

function launderedIntoAProducer(node: ts.Node): string[] {
	if (!ts.isCallExpression(node) || !/^actorOf[A-Z]/.test(node.expression.getText())) {
		return [];
	}
	const laundered = node.arguments.some(
		(argument) => ts.isAsExpression(argument) || ts.isTypeAssertionExpression(argument),
	);
	return laundered ? [`${node.expression.getText()}(… as …)`] : [];
}

function namesTheUserEntity(type: ts.TypeNode): boolean {
	return /^(UserId|EntityId<\s*"user"\s*>)$/.test(type.getText());
}

//a user id is minted by a cast or by toEntityId, and an untyped toEntityId could be either (S-OWNER-7)
function mintedUserIds(node: ts.Node): string[] {
	if (
		(ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
		namesTheUserEntity(node.type)
	) {
		return ["UserId"];
	}
	if (!ts.isCallExpression(node) || node.expression.getText() !== "toEntityId") {
		return [];
	}
	const [entity] = node.typeArguments ?? [];
	if (entity === undefined) {
		return ["toEntityId(…) without an entity"];
	}
	return entity.getText() === '"user"' ? ["UserId"] : [];
}

function proofAssertionsIn(tree: SourceTree): Assertion[] {
	const proofs = proofTypesOf(tree);
	const found: Assertion[] = [];
	for (const [file, text] of tree) {
		everyNode(parsed(file, text), (node) => {
			const minted = [
				...assertedProofs(node, proofs),
				...launderedIntoAProducer(node),
				...mintedUserIds(node),
			];
			for (const proof of minted) {
				found.push({ file, proof });
			}
		});
	}
	return found;
}

//each proof may be minted only in the modules named for it here (S-OWNER-7)
const MINTED_ONLY_IN: Readonly<Record<string, readonly string[]>> = {
	Actor: [ACTOR_MODULE],
	SessionResolution: ["core/session/service.ts"],
	StoredOneTimeToken: ["core/db/repositories/token.ts"],
	ConsumedOAuthFlow: ["core/oauth/flow-repository.ts"],
	ConsumedRecoveryCode: ["core/factor/recovery/repository.ts"],
	UserId: [
		"core/db/repositories/token.ts",
		"core/factor/recovery/repository.ts",
		"core/oauth/flow-repository.ts",
	],
};

const EVERY_PROOF_TYPE = [
	"Actor",
	"ConsumedOAuthFlow",
	"ConsumedRecoveryCode",
	"OneTimeTokenRedemption",
	"RedeemedOneTimeToken",
	"ResolvedSession",
	"SessionResolution",
	"StoredOneTimeToken",
];

function outsideTheirModules(assertions: readonly Assertion[]): Assertion[] {
	return assertions.filter(({ file, proof }) => !(MINTED_ONLY_IN[proof] ?? []).includes(file));
}

function planted(tree: SourceTree, file: string, text: string): SourceTree {
	return new Map([...tree, [file, text]]);
}

describe("T-OWNER-7: a proof of ownership is asserted only where it is produced (S-OWNER-7)", () => {
	const tree = readSourceTree();

	it("reads the brands from the actor module and follows them through every alias of one", () => {
		expect(tree.size).toBeGreaterThan(100);
		expect([...brandsDeclaredIn(tree.get(ACTOR_MODULE) ?? "")].sort()).toStrictEqual([
			"Actor",
			"ConsumedOAuthFlow",
			"ConsumedRecoveryCode",
			"RedeemedOneTimeToken",
			"ResolvedSession",
		]);
		expect([...proofTypesOf(tree)].sort()).toStrictEqual(EVERY_PROOF_TYPE);
	});

	it("finds every assertion of a proof in the module that produces it, and none elsewhere", () => {
		const assertions = proofAssertionsIn(tree);

		expect(assertions.length).toBeGreaterThanOrEqual(Object.keys(MINTED_ONLY_IN).length);
		expect(new Set(assertions.map(({ proof }) => proof))).toStrictEqual(
			new Set(Object.keys(MINTED_ONLY_IN)),
		);
		expect(outsideTheirModules(assertions)).toStrictEqual([]);
	});

	it.each([
		["a user id cast to an actor", "export const a = userId as Actor;", "Actor"],
		[
			"a request body cast to a resolution",
			"export const r = { userId: body.userId } as SessionResolution;",
			"SessionResolution",
		],
		[
			"a double cast through unknown",
			"export const r = body as unknown as ResolvedSession;",
			"ResolvedSession",
		],
		[
			"an angle-bracket assertion",
			"export const t = <RedeemedOneTimeToken>row;",
			"RedeemedOneTimeToken",
		],
		[
			"a cast handed straight to a producer",
			"export const a = actorOfResolvedSession(body as never);",
			"actorOfResolvedSession(… as …)",
		],
	])("catches a planted cast: %s", (_case, text, proof) => {
		const file = "core/auth/planted.ts";

		expect(outsideTheirModules(proofAssertionsIn(planted(tree, file, text)))).toStrictEqual([
			{ file, proof },
		]);
	});

	it.each([
		[
			"a handler converting a body field",
			'export const u = toEntityId<"user">(input.userId);',
			"UserId",
		],
		["a handler casting a body field", "export const u = input.userId as UserId;", "UserId"],
		[
			"a cast to the entity type itself",
			'export const u = input.userId as EntityId<"user">;',
			"UserId",
		],
		[
			"a conversion that leaves the entity to inference",
			"export const u: UserId = toEntityId(input.userId);",
			"toEntityId(…) without an entity",
		],
	])("catches a planted user id: %s", (_case, text, proof) => {
		const file = "core/auth/routes-planted.ts";

		expect(outsideTheirModules(proofAssertionsIn(planted(tree, file, text)))).toStrictEqual([
			{ file, proof },
		]);
	});

	it("catches a proof asserted by the right module's neighbour", () => {
		const neighbour = "core/session/planted.ts";
		const text = "export const r = { userId } as SessionResolution;";

		expect(outsideTheirModules(proofAssertionsIn(planted(tree, neighbour, text)))).toStrictEqual([
			{ file: neighbour, proof: "SessionResolution" },
		]);
	});
});
