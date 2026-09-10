import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
	Actor,
	ConsumedOAuthFlow,
	ConsumedRecoveryCode,
	RedeemedOneTimeToken,
	ResolvedSession,
} from "../src/core/db/actor.js";
import type { UserId } from "../src/core/db/entity-id.js";
import type { PendingToken } from "../src/core/factor/pending/token.js";
import type { RedirectPath } from "../src/core/http/redirect.js";
import type { createFlowPointer } from "../src/core/oauth/flow-secrets.js";
import type { DerivedKey } from "../src/core/password/secret.js";
import type { SessionToken } from "../src/core/session/token.js";
import type { SecretToken } from "../src/core/token/secret-token.js";

const sourceDirectory = fileURLToPath(new URL("../src", import.meta.url));

const UNIQUE_SYMBOL_MARKER = /^declare const (\w+): unique symbol;$/gm;
const LITERAL_MARKER = /readonly (__brand)\??:/g;

class UnreadableSourceTreeError extends Error {
	constructor(what: string) {
		super(`cannot read the source tree: ${what}`);
		this.name = "UnreadableSourceTreeError";
	}
}

function typeScriptFilesUnder(directory: string): readonly string[] {
	let listed: readonly string[];
	try {
		listed = readdirSync(directory, { recursive: true, encoding: "utf8" });
	} catch {
		throw new UnreadableSourceTreeError(`${directory} cannot be listed`);
	}
	const files = listed.filter((entry) => entry.endsWith(".ts"));
	if (files.length === 0) {
		throw new UnreadableSourceTreeError(`${directory} holds no TypeScript file`);
	}
	return files.map((entry) => `${directory}/${entry}`);
}

function brandMarkersUnder(directory: string): readonly string[] {
	const found = typeScriptFilesUnder(directory).flatMap((path) => {
		const source = readFileSync(path, "utf8");
		const named = [...source.matchAll(UNIQUE_SYMBOL_MARKER), ...source.matchAll(LITERAL_MARKER)];
		return named.map((match) => `${path.slice(directory.length + 1)}:${String(match[1])}`);
	});
	if (found.length === 0) {
		throw new UnreadableSourceTreeError(`${directory} states no brand marker`);
	}
	return [...new Set(found)].sort();
}

/**
 * Every brand marker `src/` declares, and what stands behind it. A marker absent from this map
 * fails the census below, so a brand cannot enter the tree without a line saying whether it carries
 * an invariant — which is the one judgement no scan can make for itself (E-1373).
 */
const BRAND_MARKERS: ReadonlyMap<string, string> = new Map([
	["core/db/actor.ts:actorBrand", "Actor, asserted below"],
	["core/db/actor.ts:consumedOAuthFlowBrand", "ConsumedOAuthFlow, asserted below"],
	["core/db/actor.ts:consumedRecoveryCodeBrand", "ConsumedRecoveryCode, asserted below"],
	["core/db/actor.ts:redeemedOneTimeTokenBrand", "RedeemedOneTimeToken, asserted below"],
	["core/db/actor.ts:resolvedSessionBrand", "ResolvedSession, asserted below"],
	["core/db/entity-id.ts:entityIdBrand", "EntityId, asserted below through UserId"],
	["core/factor/pending/token.ts:pendingTokenBrand", "PendingToken, asserted below"],
	["core/http/redirect.ts:__brand", "RedirectPath, asserted below"],
	[
		"core/http/route.ts:routeOutput",
		"RunnableRoute's phantom output carrier, and not a value brand. 3.11 requires the route object to hold no member Reflect.ownKeys can find, so the property is optional deliberately and nothing is refused assignment into it. It is the counterexample to telling a load-bearing brand from a decorative one by shape (E-1373).",
	],
	[
		"core/oauth/flow-secrets.ts:__brand",
		"OAuthFlowPointer, asserted below through createFlowPointer",
	],
	["core/password/secret.ts:SECRET_BRAND", "Secret, asserted below through DerivedKey"],
	["core/session/token.ts:__brand", "SessionToken, asserted below"],
	["core/token/secret-token.ts:secretTokenBrand", "SecretToken, asserted below"],
]);

/** The shape a brand takes when it has stopped branding: present, named, and optional. */
type ABrandThatBrandsNothing = string & { readonly __brand?: "decorative" };

describe("a brand refuses the type it brands", () => {
	/**
	 * What this does not catch, and none of it is closeable by widening the assertions below.
	 *
	 * It asserts that a base type does not widen into a branded one. It does not assert that a
	 * brand is minted only by the function that vets the value: every brand here is minted by a
	 * cast, and a cast added anywhere in `src/` is invisible from this file.
	 * `test/db-entity-id.test.ts` scans for `as <Brand>` and pins the minting site of three of
	 * them; the other nine have no such scan.
	 *
	 * It does not catch two brands collapsing into each other while each still refuses its base —
	 * `readonly __brand: string` in place of a literal does that, and every assertion below still
	 * holds. The pairwise property is 132 assertions over these twelve, and picking a subset would
	 * be picking which collapse to notice.
	 *
	 * The census reads two spellings, a `unique symbol` declaration and the literal `__brand`. A
	 * brand written a third way is neither listed nor guarded, and no pattern closes that, because
	 * every pattern has a complement.
	 */
	it("takes no string where a branded string belongs", () => {
		expectTypeOf<string>().not.toExtend<Actor>();
		expectTypeOf<string>().not.toExtend<PendingToken>();
		expectTypeOf<string>().not.toExtend<RedirectPath>();
		expectTypeOf<string>().not.toExtend<SecretToken>();
		expectTypeOf<string>().not.toExtend<SessionToken>();
		expectTypeOf<string>().not.toExtend<UserId>();
		expectTypeOf<string>().not.toExtend<ReturnType<typeof createFlowPointer>>();
	});

	it("takes no buffer where key material belongs (S-TIM-3)", () => {
		expectTypeOf<Uint8Array<ArrayBuffer>>().not.toExtend<DerivedKey>();
	});

	/** S-OWNER-7: a provenance is what a repository returned, so a hand-built row is not one. */
	it("takes no hand-built row where a proof of ownership belongs", () => {
		expectTypeOf<{ readonly userId: string }>().not.toExtend<ResolvedSession>();
		expectTypeOf<{ readonly userId: UserId }>().not.toExtend<ConsumedOAuthFlow>();
		expectTypeOf<{ readonly userId: UserId }>().not.toExtend<ConsumedRecoveryCode>();
		expectTypeOf<{ readonly userId: UserId }>().not.toExtend<RedeemedOneTimeToken>();
	});

	/** Without this the lines above pass for an assertion machinery that has stopped asserting. */
	it("reports a brand that has stopped branding as one its base widens into", () => {
		expectTypeOf<string>().toExtend<ABrandThatBrandsNothing>();
	});
});

describe("the census of brand markers", () => {
	it("reads a source tree that is more than one file and states more than one marker", () => {
		expect(typeScriptFilesUnder(sourceDirectory).length).toBeGreaterThan(50);
		expect(brandMarkersUnder(sourceDirectory).length).toBeGreaterThan(1);
	});

	it("names every brand marker the tree declares, and nothing the tree does not", () => {
		expect(brandMarkersUnder(sourceDirectory)).toEqual([...BRAND_MARKERS.keys()].sort());
	});

	it("gives every listed marker a reason", () => {
		const unexplained = [...BRAND_MARKERS]
			.filter(([, reason]) => reason.trim() === "")
			.map(([marker]) => marker);

		expect(unexplained).toEqual([]);
	});

	it("refuses to answer where the tree it was pointed at is not there", () => {
		expect(() => brandMarkersUnder(`${sourceDirectory}/no-such-directory`)).toThrow(
			UnreadableSourceTreeError,
		);
	});

	it("refuses to answer where the tree it was pointed at states no marker", () => {
		expect(typeScriptFilesUnder(`${sourceDirectory}/client`).length).toBeGreaterThan(0);
		expect(() => brandMarkersUnder(`${sourceDirectory}/client`)).toThrow(UnreadableSourceTreeError);
	});
});
