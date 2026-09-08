import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import { createWebAuthnCredentialRepository } from "../src/core/factor/webauthn/credential-repository.js";
import { toErrorBody, toVisibleFailure } from "../src/core/http/error-map.js";
import {
	createAccount,
	enrol,
	openWebAuthnFixture,
	type WebAuthnFixture,
} from "./webauthn-fixtures.js";

/** The route answers 204 with no body, so what a caller can tell apart is the status, the code
 * and the body — and for two rejections that must be one string. */
const REMOVE_ANSWERED_204 = JSON.stringify({ status: 204, body: null });

async function answerTo(attempt: Promise<unknown>): Promise<string> {
	return attempt.then(
		() => JSON.stringify({ status: 204, body: null }),
		(failure: unknown) => {
			const visible = toVisibleFailure(failure);
			return JSON.stringify({
				status: visible.error.httpStatus,
				body: toErrorBody(visible.error),
			});
		},
	);
}

async function credentialCountOf(fixture: WebAuthnFixture, actor: Actor): Promise<number> {
	const [row] = await fixture.connection.query<{ rows: number }>(
		`SELECT count(*)::int AS rows FROM ${fixture.schema}.webauthn_credential WHERE user_id = $1`,
		[actor],
	);
	return row?.rows ?? -1;
}

describe("owning a webauthn credential", () => {
	let fixture: WebAuthnFixture;

	beforeAll(async () => {
		fixture = await openWebAuthnFixture("webauthn_ownership");
	});

	afterAll(() => fixture.close());

	/** T-OWNER-3. Two credentials each, so that the last-way-in rule is not what refuses. */
	it("removes nothing for a foreign credential and nothing for an invented one, alike", async () => {
		const a = await createAccount(fixture);
		const b = await createAccount(fixture);
		const first = await enrol(fixture, a, "a-one");
		await enrol(fixture, a, "a-two");
		const ownedByB = await enrol(fixture, b, "b-one");
		await enrol(fixture, b, "b-two");

		const before = await credentialCountOf(fixture, a);
		const answers = [
			await answerTo(fixture.service.remove({ actor: b, credentialId: first.credentialId })),
			await answerTo(fixture.service.remove({ actor: b, credentialId: randomUUID() })),
		];
		const after = await credentialCountOf(fixture, a);

		/* Anchored, not merely equal: two identical wrong answers satisfy an equality as well as
		   two identical right ones, and counting non-deletions cannot tell "correctly refused"
		   from "never deletes anything" (E-482). */
		expect(answers).toEqual([REMOVE_ANSWERED_204, REMOVE_ANSWERED_204]);
		expect(before).toBe(2);
		expect(after).toBe(before);
		expect(await credentialCountOf(fixture, b)).toBe(2);

		// The same call, in the same case, on a row that is the caller's: it deletes.
		await fixture.service.remove({ actor: b, credentialId: ownedByB.credentialId });
		expect(await credentialCountOf(fixture, b)).toBe(1);
		expect(await credentialCountOf(fixture, a)).toBe(2);
	});

	it("removes the caller's own credential", async () => {
		const account = await createAccount(fixture);
		const first = await enrol(fixture, account, "one");
		await enrol(fixture, account, "two");

		await fixture.service.remove({ actor: account, credentialId: first.credentialId });

		expect(await credentialCountOf(fixture, account)).toBe(1);
		expect((await fixture.service.list({ actor: account })).map((row) => row.label)).toEqual([
			"two",
		]);
	});

	/** L-13: the count runs over password, webauthn credentials and linked identities, and this
	 * account has nothing else. */
	it("refuses to remove the last way into the account", async () => {
		const account = await createAccount(fixture);
		const only = await enrol(fixture, account, "only");

		const refused = fixture.service.remove({ actor: account, credentialId: only.credentialId });

		await expect(refused).rejects.toMatchObject({ code: "last_sign_in_method" });
		expect(await credentialCountOf(fixture, account)).toBe(1);
	});

	it("removes the last credential once a password stands beside it", async () => {
		const account = await createAccount(fixture);
		const only = await enrol(fixture, account, "only");
		await fixture.connection.query(
			`INSERT INTO ${fixture.schema}.password_credential (user_id, phc, scheme, key_version)
			 VALUES ($1, $2, $3, 1)`,
			[account, Buffer.from("not a real hash"), "argon2id"],
		);

		await fixture.service.remove({ actor: account, credentialId: only.credentialId });

		expect(await credentialCountOf(fixture, account)).toBe(0);
	});

	it("shows a caller only its own credentials", async () => {
		const a = await createAccount(fixture);
		const b = await createAccount(fixture);
		await enrol(fixture, a, "mine");
		await enrol(fixture, b, "theirs");

		expect((await fixture.service.list({ actor: a })).map((row) => row.label)).toEqual(["mine"]);
		expect((await fixture.service.list({ actor: b })).map((row) => row.label)).toEqual(["theirs"]);
	});

	it("renames only the caller's own credential, and answers a foreign one as it answers an invented one", async () => {
		const a = await createAccount(fixture);
		const b = await createAccount(fixture);
		const mine = await enrol(fixture, a, "before");

		const renamed = await fixture.service.rename({
			actor: a,
			credentialId: mine.credentialId,
			label: "after",
		});
		const answers = [
			await answerTo(
				fixture.service.rename({ actor: b, credentialId: mine.credentialId, label: "stolen" }),
			),
			await answerTo(
				fixture.service.rename({ actor: b, credentialId: randomUUID(), label: "invented" }),
			),
		];

		expect(renamed.credential.label).toBe("after");
		expect(answers[0]).toBe(answers[1]);
		expect((await fixture.service.list({ actor: a }))[0]?.label).toBe("after");
	});

	/** A malformed identifier can name no row, and the route declares no 400, so it takes the
	 * same exit as a row that is not the caller's. */
	it("answers a credential identifier that is not a uuid as it answers an unknown one", async () => {
		const account = await createAccount(fixture);
		const keptOne = await enrol(fixture, account, "one");
		await enrol(fixture, account, "two");

		const answers = [
			await answerTo(fixture.service.remove({ actor: account, credentialId: "not-a-uuid" })),
			await answerTo(fixture.service.remove({ actor: account, credentialId: randomUUID() })),
		];

		expect(answers).toEqual([REMOVE_ANSWERED_204, REMOVE_ANSWERED_204]);
		expect(await credentialCountOf(fixture, account)).toBe(2);
		await fixture.service.remove({ actor: account, credentialId: keptOne.credentialId });
		expect(await credentialCountOf(fixture, account)).toBe(1);
	});
});

/**
 * E-459: the owner predicate takes a resolved session or a resolved intermediate state, and a
 * bare string is neither — which is what a request body carries (S-OWNER-7). The assertion is
 * the compile error, so this case exists to fail if the union ever admits `string`.
 */
describe("who may name an owner", () => {
	it("does not take a user identifier that came from nowhere", () => {
		const repository = createWebAuthnCredentialRepository({
			driver: {
				query: async () => [],
				transaction: (run) =>
					run({ query: async () => [], transaction: (inner) => inner as never }),
			},
			schema: "velve",
		});

		expect(() =>
			repository.listDescriptorsOwnedBy({
				// @ts-expect-error a plain string is neither proof of ownership this library accepts
				owner: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
			}),
		).not.toThrow();
	});
});

/**
 * Blocker on `recordAssertionStatement`: its `user_id = $2` is defence in depth — `verified.id`
 * and `verified.userId` come from one already-verified row — and no case would have noticed it
 * being lost. An S-OWNER-2 predicate nothing asserts is a predicate the next refactor removes.
 */
describe("recording an assertion", () => {
	let fixture: WebAuthnFixture;

	beforeAll(async () => {
		fixture = await openWebAuthnFixture("webauthn_record_assertion");
	});

	afterAll(() => fixture.close());

	it("writes nothing when the row and the owner it is presented with disagree", async () => {
		const a = await createAccount(fixture);
		const b = await createAccount(fixture);
		await enrol(fixture, a, "a-key");
		await enrol(fixture, b, "b-key");
		const repository = createWebAuthnCredentialRepository({
			driver: fixture.connection,
			schema: fixture.schema,
		});
		const [belongingToA] = await repository.listDescriptorsOwnedBy({ owner: a });
		if (belongingToA === undefined) {
			throw new Error("the credential was not created");
		}

		const written = await repository.recordAssertion({
			verified: { ...belongingToA, userId: b },
			signCount: 4242,
			isBackupEligible: true,
			isCurrentlyBackedUp: true,
		});

		expect(written).toBeNull();
		const [row] = await fixture.connection.query<{ sign_count: unknown; backup_state: boolean }>(
			`SELECT sign_count, backup_state FROM ${fixture.schema}.webauthn_credential WHERE id = $1`,
			[belongingToA.id],
		);
		expect(Number(row?.sign_count)).not.toBe(4242);
		expect(row?.backup_state).toBe(false);
	});

	it("writes the row when the owner it is presented with is the row's own", async () => {
		const account = await createAccount(fixture);
		await enrol(fixture, account, "key");
		const repository = createWebAuthnCredentialRepository({
			driver: fixture.connection,
			schema: fixture.schema,
		});
		const [own] = await repository.listDescriptorsOwnedBy({ owner: account });
		if (own === undefined) {
			throw new Error("the credential was not created");
		}

		const written = await repository.recordAssertion({
			verified: own,
			signCount: 4242,
			isBackupEligible: true,
			isCurrentlyBackedUp: true,
		});

		expect(written).not.toBeNull();
		const [row] = await fixture.connection.query<{ sign_count: unknown }>(
			`SELECT sign_count FROM ${fixture.schema}.webauthn_credential WHERE id = $1`,
			[own.id],
		);
		expect(Number(row?.sign_count)).toBe(4242);
	});
});
