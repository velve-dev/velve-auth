import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

const UNIQUE_SYMBOL_MARKER = /^(?:export )?declare const (\w+): unique symbol;$/gm;
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
 * Every brand marker `src/` declares: the brand it keys, or `null` and the reason it carries no
 * invariant — the one judgement no scan can make for itself (E-1373). A marker absent from here
 * fails the census, and a brand named here without an assertion below fails it too.
 */
const BRAND_MARKERS: ReadonlyMap<
	string,
	{ readonly asserts: string | null; readonly note: string }
> = new Map([
	["core/db/actor.ts:actorBrand", { asserts: "Actor", note: "a bare string is not an owner" }],
	[
		"core/db/actor.ts:consumedOAuthFlowBrand",
		{ asserts: "ConsumedOAuthFlow", note: "a hand-built row is not a consumed flow" },
	],
	[
		"core/db/actor.ts:consumedRecoveryCodeBrand",
		{ asserts: "ConsumedRecoveryCode", note: "a hand-built row is not a redeemed code" },
	],
	[
		"core/db/actor.ts:redeemedOneTimeTokenBrand",
		{ asserts: "RedeemedOneTimeToken", note: "a hand-built row is not a redemption" },
	],
	[
		"core/db/actor.ts:resolvedSessionBrand",
		{ asserts: "ResolvedSession", note: "a hand-built row is not a resolved session" },
	],
	[
		"core/db/entity-id.ts:entityIdBrand",
		{ asserts: "UserId", note: "a bare string is not a row identifier" },
	],
	[
		"core/factor/pending/token.ts:pendingTokenBrand",
		{ asserts: "PendingToken", note: "a bare string is not a pending token" },
	],
	[
		"core/http/redirect.ts:__brand",
		{ asserts: "RedirectPath", note: "a bare string is not a vetted path (S-REDIR-3)" },
	],
	[
		"core/http/route.ts:routeOutput",
		{
			asserts: null,
			note: "RunnableRoute's phantom output carrier, and not a value brand. 3.11 requires the route object to hold no member Reflect.ownKeys can find, so the property is optional deliberately and nothing is refused assignment into it. It is the counterexample to telling a load-bearing brand from a decorative one by shape (E-1373).",
		},
	],
	[
		"core/oauth/flow-secrets.ts:__brand",
		{ asserts: "OAuthFlowPointer", note: "a bare string is not a flow pointer" },
	],
	[
		"core/password/secret.ts:SECRET_BRAND",
		{ asserts: "DerivedKey", note: "a bare buffer is not key material (S-TIM-3)" },
	],
	[
		"core/session/token.ts:__brand",
		{ asserts: "SessionToken", note: "a bare string is not a session token" },
	],
	[
		"core/token/secret-token.ts:secretTokenBrand",
		{ asserts: "SecretToken", note: "a bare string is not a one-time token" },
	],
]);

/** The shape a brand takes when it has stopped branding: present, named, and optional. */
type ABrandThatBrandsNothing = string & { readonly __brand?: "decorative" };

type BaseIsRefusedBy<Brand, Base, Name extends string> = [Base] extends [Brand]
	? { readonly thisBrandNoLongerRefusesItsBase: Name }
	: true;

/**
 * Checked by `pnpm typecheck` and by nothing else — `vitest.config.ts` enables no typecheck
 * project, so a weakened brand leaves this suite green and reddens `tsc --noEmit` (E-1385). Each
 * entry names its own brand, so the failure reads `thisBrandNoLongerRefusesItsBase: "RedirectPath"`
 * rather than an argument count.
 *
 * What this does not reach: it says a base does not widen into a brand, never that only the vetting
 * function mints one — every brand here is minted by a cast, and `test/db-entity-id.test.ts` pins
 * the minting site of three of the twelve. Two brands collapsing into each other while each still
 * refuses its base is invisible (E-1375), and so is a brand spelled in a way the census cannot read.
 */
const BRAND_REFUSES_ITS_BASE: {
	readonly Actor: BaseIsRefusedBy<Actor, string, "Actor">;
	readonly ConsumedOAuthFlow: BaseIsRefusedBy<
		ConsumedOAuthFlow,
		{ readonly userId: UserId },
		"ConsumedOAuthFlow"
	>;
	readonly ConsumedRecoveryCode: BaseIsRefusedBy<
		ConsumedRecoveryCode,
		{ readonly userId: UserId },
		"ConsumedRecoveryCode"
	>;
	readonly DerivedKey: BaseIsRefusedBy<DerivedKey, Uint8Array<ArrayBuffer>, "DerivedKey">;
	readonly OAuthFlowPointer: BaseIsRefusedBy<
		ReturnType<typeof createFlowPointer>,
		string,
		"OAuthFlowPointer"
	>;
	readonly PendingToken: BaseIsRefusedBy<PendingToken, string, "PendingToken">;
	readonly RedeemedOneTimeToken: BaseIsRefusedBy<
		RedeemedOneTimeToken,
		{ readonly userId: UserId },
		"RedeemedOneTimeToken"
	>;
	readonly RedirectPath: BaseIsRefusedBy<RedirectPath, string, "RedirectPath">;
	readonly ResolvedSession: BaseIsRefusedBy<
		ResolvedSession,
		{ readonly userId: string },
		"ResolvedSession"
	>;
	readonly SecretToken: BaseIsRefusedBy<SecretToken, string, "SecretToken">;
	readonly SessionToken: BaseIsRefusedBy<SessionToken, string, "SessionToken">;
	readonly UserId: BaseIsRefusedBy<UserId, string, "UserId">;
} = {
	Actor: true,
	ConsumedOAuthFlow: true,
	ConsumedRecoveryCode: true,
	DerivedKey: true,
	OAuthFlowPointer: true,
	PendingToken: true,
	RedeemedOneTimeToken: true,
	RedirectPath: true,
	SecretToken: true,
	SessionToken: true,
	ResolvedSession: true,
	UserId: true,
};

/** Without this the twelve above pass for machinery that has stopped deciding anything. */
const A_DECORATIVE_BRAND_IS_REPORTED: BaseIsRefusedBy<
	ABrandThatBrandsNothing,
	string,
	"decorative"
> = { thisBrandNoLongerRefusesItsBase: "decorative" };

describe("the census of brand markers", () => {
	it("reads a source tree that is more than one file and states more than one marker", () => {
		expect(typeScriptFilesUnder(sourceDirectory).length).toBeGreaterThan(50);
		expect(brandMarkersUnder(sourceDirectory).length).toBeGreaterThan(1);
	});

	it("names every brand marker the tree declares, and nothing the tree does not", () => {
		expect(brandMarkersUnder(sourceDirectory)).toEqual([...BRAND_MARKERS.keys()].sort());
	});

	/**
	 * The runtime half of the guard: a brand cannot be listed without an assertion, or asserted
	 * without being listed, whichever way the omission is made (E-1385).
	 */
	it("asserts exactly the brands the census says are asserted", () => {
		const listed = [...BRAND_MARKERS.values()]
			.map((marker) => marker.asserts)
			.filter((brand) => brand !== null)
			.sort();

		expect(Object.keys(BRAND_REFUSES_ITS_BASE).sort()).toEqual(listed);
	});

	it("gives every listed marker a note", () => {
		const unexplained = [...BRAND_MARKERS]
			.filter(([, marker]) => marker.note.trim() === "")
			.map(([marker]) => marker);

		expect(unexplained).toEqual([]);
	});

	it("reports a brand that has stopped branding, which is what makes the assertions assertions", () => {
		expect(A_DECORATIVE_BRAND_IS_REPORTED.thisBrandNoLongerRefusesItsBase).toBe("decorative");
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
