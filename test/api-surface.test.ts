import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distDirectory = fileURLToPath(new URL("../dist", import.meta.url));

const EXPORT_LIST = /^(export \{)([^}]*)(\};)$/gm;
const MEMBER_LINE = /^(\s+)(?:readonly )?(?:\[[^\]]+\]|[A-Za-z_$][\w$]*)\??: .*;$/;
const STRING_LITERAL_UNION = /"[^"\\]*"(?: \| "[^"\\]*")+/g;
const DOCUMENTATION_LINE = /^\s*(?:\/\*\*|\*\/|\*(?!\/)|\/\/)/;

/**
 * A diff here has two possible causes and they look identical, so the message names the second one:
 * a reader who assumes their own change can spend an hour before suspecting the build (E-1377).
 */
const MIGHT_BE_THE_INSTRUMENT = [
	"The subject may have changed, or the instrument may have moved — this diff looks the same either way.",
	"The build does not emit the same declarations twice (E-1386): over fifty clean builds of an unchanged tree, dist/ took three distinct forms at 29/12/9, and five files moved — core/{auth,factor,flows,oauth,password}/routes.d.mts.",
	"Two orderings are normalised away before this comparison, member order and union-constituent order, and a third instability would surface here looking exactly like a surface change.",
	"To tell them apart, rebuild without touching the tree and compare dist/**/*.d.mts across the runs. TWO BUILDS ARE NOT ENOUGH: two agree 43% of the time, so a single comparison showing no difference is close to a coin flip. Eight builds leave 1.3%, ten leave 0.4%.",
].join(" ");

class UnreadableDistributionError extends Error {
	constructor(what: string) {
		super(`cannot read the shipped declarations: ${what}`);
		this.name = "UnreadableDistributionError";
	}
}

/**
 * The whole export list arrives on one physical line, so three features each adding a name meet in
 * one three-way conflict resolvable only by regenerating. One name per line makes their additions
 * disjoint hunks (E-776).
 */
function oneExportPerLine(body: string): string {
	return body.replace(EXPORT_LIST, (_whole, open: string, names: string, close: string) => {
		const listed = names
			.split(",")
			.map((name) => name.trim())
			.filter((name) => name !== "");
		return `${open}\n${listed.map((name) => `\t${name},`).join("\n")}\n${close}`;
	});
}

/**
 * Two orderings the build does not hold fixed (E-1377, E-1386). Exactly two, named so that a third
 * is recognisably a third rather than a mystery — and applied to all 45 of the 79 files that carry
 * either, not only to the five the build actually moves:
 *
 * 1. **member order** — the members of an inferred object type, `MEMBER_LINE` below;
 * 2. **union-constituent order** — the constituents of a union of string literals,
 *    `STRING_LITERAL_UNION` below.
 *
 * A doc comment belongs to the member beneath it, so it is sorted **with** that member and never
 * on its own: sorting the member lines alone leaves the comment at a position and re-attaches it to
 * whichever member sorts into that slot, which is a changed record and not a hidden reordering
 * (E-1383).
 */
/**
 * Returning 1 for both orders of an equal pair is not an ordering. Equal keys are reachable only
 * through the misclassification the limits below name, and no input to the **normaliser** separates
 * this from the invalid form on V8 — but an input to this function does, and that is what the test
 * below asserts (E-1390).
 */
function compareMemberLines(left: string, right: string): number {
	if (left === right) {
		return 0;
	}
	return left < right ? -1 : 1;
}

function inTheOrderTheBuildDoesNotDecide(body: string): string {
	const sortedUnions = body.replace(STRING_LITERAL_UNION, (union) =>
		union.split(" | ").sort().join(" | "),
	);
	const normalised: string[] = [];
	let run: { readonly key: string; readonly lines: readonly string[] }[] = [];
	let documentation: string[] = [];
	let indent: string | null = null;
	const flushRun = () => {
		for (const documented of run.toSorted((left, right) =>
			compareMemberLines(left.key, right.key),
		)) {
			normalised.push(...documented.lines);
		}
		run = [];
		indent = null;
	};
	for (const line of sortedUnions.split("\n")) {
		if (DOCUMENTATION_LINE.test(line)) {
			documentation.push(line);
			continue;
		}
		const member = MEMBER_LINE.exec(line);
		if (member === null) {
			flushRun();
			normalised.push(...documentation, line);
			documentation = [];
			continue;
		}
		if (indent !== null && String(member[1]) !== indent) {
			flushRun();
		}
		indent = String(member[1]);
		run.push({ key: line, lines: [...documentation, line] });
		documentation = [];
	}
	flushRun();
	normalised.push(...documentation);
	return normalised.join("\n");
}

function declarationFilesUnder(directory: string): readonly string[] {
	if (!existsSync(directory)) {
		throw new UnreadableDistributionError(`${directory} is missing — run \`pnpm build\` first`);
	}
	const declarations = readdirSync(directory, { recursive: true, encoding: "utf8" })
		.filter((file) => file.endsWith(".d.mts"))
		.map((file) => file.replaceAll("\\", "/"))
		.sort();
	if (declarations.length === 0) {
		throw new UnreadableDistributionError(`${directory} holds no declaration file`);
	}
	return declarations;
}

function readPublicSurface(): string {
	return declarationFilesUnder(distDirectory)
		.map((file) => {
			const shipped = readFileSync(`${distDirectory}/${file}`, "utf8").trimEnd();
			const body = inTheOrderTheBuildDoesNotDecide(oneExportPerLine(shipped));
			return `## ${file}\n\n${body === "" ? "(empty)" : body}`;
		})
		.join("\n\n");
}

describe("public API surface", () => {
	/**
	 * What this does not catch: it announces a change rather than refusing one, because re-recording
	 * is one command; it reads the last build, so `pnpm api` alone can compare a stale tree; it
	 * records module-level exports no entry re-exports, so it reddens for more than the surface; it
	 * says nothing about `dist/*.mjs`; and it stops at `dist/`, so of the four `@simplewebauthn/server`
	 * types structurally in the surface, the two held by `satisfies DeclaresEveryFieldOf` in
	 * `core/factor/webauthn/payload.ts` are held by `pnpm typecheck` and not by this, and the two
	 * `PublicKeyCredential*OptionsJSON` are held by nothing (E-454, E-1384).
	 *
	 * It also classifies lines context-free, so a JSDoc body line carrying no leading `*` reads as a
	 * member and sorts away from its block. None exist in `dist` today — 0 of 384 doc-block lines — and if
	 * one appears the record becomes a broken fragment rather than a wrong one (E-1388).
	 *
	 * The hint on failure offers the build as the alternative instrument and not the filesystem, so
	 * a reader whose `dist/` has picked up a stray file will rebuild and find the tree stable.
	 *
	 * The two refusal tests below assert the error **class**, so they cannot tell one refusal from
	 * the other: remove the empty-directory throw and the missing-directory throw catches the same
	 * case, and both tests stay green (E-1390).
	 */
	it("matches the committed snapshot", async () => {
		await expect(readPublicSurface()).toMatchFileSnapshot(
			"./__snapshots__/api-surface.md",
			MIGHT_BE_THE_INSTRUMENT,
		);
	});

	/**
	 * The fault this file was blind to until E-1376: `readdirSync` without `recursive` read the nine
	 * barrels and none of the seventy files the members of a published type live in, so a field
	 * added to an exported class moved nothing here.
	 */
	it("reads the declarations below the top level, not only the entry points", () => {
		const files = declarationFilesUnder(distDirectory);
		const nested = files.filter((file) => file.includes("/"));

		expect(files.filter((file) => !file.includes("/")).length).toBeGreaterThan(1);
		expect(nested.length).toBeGreaterThan(1);
		expect(nested).toContain("core/auth/startup.d.mts");
	});

	it("refuses to answer where the directory it was pointed at is not there", () => {
		expect(() => declarationFilesUnder(`${distDirectory}/no-such-directory`)).toThrow(
			UnreadableDistributionError,
		);
	});

	it("refuses to answer where the directory it was pointed at declares nothing", () => {
		expect(() =>
			declarationFilesUnder(fileURLToPath(new URL("./fixtures", import.meta.url))),
		).toThrow(UnreadableDistributionError);
	});

	it("holds the two orderings the build does not decide, and nothing else", () => {
		const oneWay = 'interface A {\n  b: "x" | "y";\n  a: string;\n}\n';
		const theOther = 'interface A {\n  a: string;\n  b: "y" | "x";\n}\n';
		const added = 'interface A {\n  a: string;\n  b: "y" | "x";\n  c: number;\n}\n';

		expect(inTheOrderTheBuildDoesNotDecide(oneWay)).toBe(inTheOrderTheBuildDoesNotDecide(theOther));
		expect(inTheOrderTheBuildDoesNotDecide(added)).not.toBe(
			inTheOrderTheBuildDoesNotDecide(theOther),
		);
	});

	/** E-1383: sorting the member lines alone re-attaches a doc comment to whichever member sorts
	 * into its slot, so the record disagreed with the declaration it copies. */
	it("keeps a doc comment on the member it documents, whichever way the members sort", () => {
		const onB = "interface A {\n  /** about b */\n  b: string;\n  a: string;\n}\n";
		const onA = "interface A {\n  /** about a */\n  a: string;\n  b: string;\n}\n";

		expect(inTheOrderTheBuildDoesNotDecide(onB)).toContain("  /** about b */\n  b: string;");
		expect(inTheOrderTheBuildDoesNotDecide(onA)).toContain("  /** about a */\n  a: string;");
		expect(inTheOrderTheBuildDoesNotDecide(onB)).not.toBe(inTheOrderTheBuildDoesNotDecide(onA));
	});

	/**
	 * The comparator is asserted directly, because no input to the normaliser reaches it: V8's
	 * TimSort consumes the comparator only through `comparefn(...) < 0`, so answering 1 where a
	 * valid comparator answers 0 never changes a branch it takes. That is an engine property and
	 * not a guarantee — a conforming stable merge that tests `<= 0` does diverge — so the property
	 * is pinned where it lives rather than through the caller (E-1390).
	 */
	it("orders two identical member lines as equal, and a run carrying them unchanged", () => {
		const twice = "interface A {\n  a: string;\n  a: string;\n  b: string;\n}\n";

		expect(compareMemberLines("  a: string;", "  a: string;")).toBe(0);
		expect(inTheOrderTheBuildDoesNotDecide(twice)).toBe(twice);
	});

	it("keeps a doc comment spanning several lines with its member", () => {
		const spanning = "interface A {\n  /**\n   * about b\n   */\n  b: string;\n  a: string;\n}\n";

		expect(inTheOrderTheBuildDoesNotDecide(spanning)).toContain(
			"  /**\n   * about b\n   */\n  b: string;",
		);
	});
});
