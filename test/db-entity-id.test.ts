import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type Actor,
	actorOfConsumedOAuthFlow,
	actorOfRedeemedOneTimeToken,
	type ConsumedOAuthFlow,
	type RedeemedOneTimeToken,
} from "../src/core/db/actor.js";
import type { Driver } from "../src/core/db/driver.js";
import type {
	EntityId,
	IdentityId,
	ProviderId,
	SessionId,
	UserId,
	WebAuthnCredentialId,
} from "../src/core/db/entity-id.js";
import { toEntityId } from "../src/core/db/entity-id.js";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import { createSecretToken, type SecretToken } from "../src/core/token/secret-token.js";

const core = fileURLToPath(new URL("../src/core", import.meta.url));

function coreFiles(): readonly string[] {
	return readdirSync(core, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => `${entry.parentPath}/${entry.name}`);
}

const ACCOUNT = "6d0f2b1a-0000-4000-8000-000000000001";
const LOOKUP = { tokenSha256: new Uint8Array(32), purpose: "password_reset" } as const;

function repositoryReturning(rows: readonly Record<string, unknown>[]) {
	const driver: Driver = {
		query: async () => rows as never[],
		transaction: (run) => run(driver),
	};
	return createOneTimeTokenRepository({ driver, schema: "velve" });
}

/**
 * T-RAND-6 asks for two negative cases that do not compile. The first one — an account identifier
 * where a token belongs — stands in `token-static-scan.test.ts`. This is the second, which had no
 * type to be written against until `EntityId` existed (E-260).
 */
describe("a token is not a database key (S-RAND-6, second negative case)", () => {
	it("refuses a secret token where a row identifier belongs, and takes a conversion", () => {
		const token: SecretToken = createSecretToken();

		// @ts-expect-error S-RAND-6: a one-time token is a secret, not the identifier of a row.
		const smuggled: UserId = token;
		const converted: UserId = toEntityId<"user">(ACCOUNT);

		expect(typeof smuggled).toBe("string");
		expect(converted).toBe(ACCOUNT);
	});

	it("refuses the identifier of one table where another table's belongs", () => {
		const session: SessionId = toEntityId<"session">(ACCOUNT);

		// @ts-expect-error S-RAND-6: two tables, two identifiers, and no assignment between them.
		const asUser: UserId = session;

		expect(asUser).toBe(session);
	});

	it("names five identifiers, each of them distinct from the others", () => {
		const written: readonly EntityId<string>[] = [
			toEntityId<"user">("u") satisfies UserId,
			toEntityId<"session">("s") satisfies SessionId,
			toEntityId<"identity">("i") satisfies IdentityId,
			toEntityId<"webauthn_credential">("c") satisfies WebAuthnCredentialId,
			toEntityId<"oauth_provider">("google") satisfies ProviderId,
		];

		expect(written).toHaveLength(5);
		expect(new Set(written).size).toBe(5);
	});
});

describe("the second and third lawful provenance of an actor (E-234, E-341)", () => {
	it("mints none from an object no repository produced", () => {
		const fromRequestBody = { userId: toEntityId<"user">(ACCOUNT) };

		// @ts-expect-error S-OWNER-7: a hand-built object is not a redeemed one-time token.
		const fromToken: Actor = actorOfRedeemedOneTimeToken(fromRequestBody);
		// @ts-expect-error S-OWNER-7: a hand-built object is not a consumed OAuth flow.
		const fromFlow: Actor = actorOfConsumedOAuthFlow(fromRequestBody);

		expect([fromToken, fromFlow]).toStrictEqual([ACCOUNT, ACCOUNT]);
	});

	it("mints one from the row the token repository removed", async () => {
		const redeemed = await repositoryReturning([
			{ user_id: ACCOUNT, payload: null },
		]).consumeOneTimeToken(LOOKUP);

		expect(redeemed === null ? null : actorOfRedeemedOneTimeToken(redeemed)).toBe(ACCOUNT);
	});

	it("answers a removed row that names no account exactly as it answers no row", async () => {
		const answers = [
			await repositoryReturning([{ user_id: null, payload: null }]).consumeOneTimeToken(LOOKUP),
			await repositoryReturning([]).consumeOneTimeToken(LOOKUP),
		];

		expect(answers).toHaveLength(2);
		expect(answers).toStrictEqual([null, null]);
	});
});

describe("where the two new brands may be asserted", () => {
	it("asserts the redemption brand in the repository that removes the row and nowhere else", () => {
		const asserting = coreFiles()
			.filter((path) =>
				/\bas StoredOneTimeToken\b|\bas RedeemedOneTimeToken\b/.test(readFileSync(path, "utf8")),
			)
			.map((path) => path.replace(core, ""));

		expect(coreFiles().length).toBeGreaterThan(20);
		expect(asserting).toStrictEqual(["/db/repositories/token.ts"]);
	});

	it("asserts the OAuth flow brand nowhere yet, because no repository consumes a flow", () => {
		const asserting = coreFiles()
			.filter((path) => /\bas ConsumedOAuthFlow\b/.test(readFileSync(path, "utf8")))
			.map((path) => path.replace(core, ""));

		expect(coreFiles().length).toBeGreaterThan(20);
		expect(asserting).toStrictEqual([]);
	});

	it("mints an actor in one file, over a core that is not empty", () => {
		const minting = coreFiles()
			.filter((path) => /\bas Actor\b/.test(readFileSync(path, "utf8")))
			.map((path) => path.replace(core, ""));

		expect(coreFiles().length).toBeGreaterThan(20);
		expect(minting).toStrictEqual(["/db/actor.ts"]);
	});
});

declare const consumedFlow: ConsumedOAuthFlow;
declare const redeemedToken: RedeemedOneTimeToken;

describe("the three provenances stay apart", () => {
	it("takes neither evidence where the other belongs", () => {
		const producers = [
			// @ts-expect-error S-OWNER-7: a consumed OAuth flow is not a redeemed one-time token.
			() => actorOfRedeemedOneTimeToken(consumedFlow),
			// @ts-expect-error S-OWNER-7: a redeemed one-time token is not a consumed OAuth flow.
			() => actorOfConsumedOAuthFlow(redeemedToken),
		];

		expect(producers).toHaveLength(2);
		expect(
			[actorOfConsumedOAuthFlow, actorOfRedeemedOneTimeToken].map((p) => p.length),
		).toStrictEqual([1, 1]);
	});
});
