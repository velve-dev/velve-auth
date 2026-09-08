import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import { toErrorBody, toVisibleFailure } from "../src/core/http/error-map.js";
import {
	createAccount,
	enrol,
	openWebAuthnFixture,
	type WebAuthnFixture,
} from "./webauthn-fixtures.js";

/** The route answers 204 with no body, so what a caller can tell apart is the status, the code
 * and the body — and for two rejections that must be one string. */
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
		await enrol(fixture, b, "b-one");
		await enrol(fixture, b, "b-two");

		const before = await credentialCountOf(fixture, a);
		const answers = [
			await answerTo(fixture.service.remove({ actor: b, credentialId: first.credentialId })),
			await answerTo(fixture.service.remove({ actor: b, credentialId: randomUUID() })),
		];
		const after = await credentialCountOf(fixture, a);

		expect(answers[0]).toBe(answers[1]);
		expect(before).toBe(2);
		expect(after).toBe(before);
		expect(await credentialCountOf(fixture, b)).toBe(2);
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
		await enrol(fixture, account, "one");
		await enrol(fixture, account, "two");

		const answers = [
			await answerTo(fixture.service.remove({ actor: account, credentialId: "not-a-uuid" })),
			await answerTo(fixture.service.remove({ actor: account, credentialId: randomUUID() })),
		];

		expect(answers[0]).toBe(answers[1]);
		expect(await credentialCountOf(fixture, account)).toBe(2);
	});
});
