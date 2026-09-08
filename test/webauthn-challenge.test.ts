import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/core/db/actor.js";
import {
	createWebAuthnChallenges,
	WEBAUTHN_CHALLENGE_LIFETIME_SECONDS,
	type WebAuthnChallenges,
} from "../src/core/factor/webauthn/challenge.js";
import { toErrorBody, toVisibleFailure } from "../src/core/http/error-map.js";
import { decodeBase64Url } from "../src/core/keys/base64url.js";
import {
	beginSecondFactor,
	createAccount,
	newAuthenticator,
	openWebAuthnFixture,
	type WebAuthnFixture,
} from "./webauthn-fixtures.js";

interface ChallengeRow {
	readonly challenge_sha256: Uint8Array;
	readonly purpose: string;
	readonly user_id: string | null;
	readonly column_type: string;
}

function visibleAnswerTo(failure: unknown): string {
	const visible = toVisibleFailure(failure);
	return JSON.stringify({
		status: visible.error.httpStatus,
		body: toErrorBody(visible.error),
	});
}

describe("the webauthn challenge", () => {
	let fixture: WebAuthnFixture;
	let actor: Actor;
	let challenges: WebAuthnChallenges;

	beforeAll(async () => {
		fixture = await openWebAuthnFixture("webauthn_challenge");
		actor = await createAccount(fixture);
		challenges = createWebAuthnChallenges({
			driver: fixture.connection,
			schema: fixture.schema,
		});
	});

	afterAll(() => fixture.close());

	/** T-REST-2, for the one column of the five this feature owns. */
	it("stores the challenge as thirty-two bytea bytes equal to the computed hash", async () => {
		const { challengeToken } = await challenges.issue({ purpose: "register", userId: actor });

		const [row] = await fixture.connection.query<ChallengeRow>(
			`SELECT challenge.challenge_sha256,
			        format_type(column_.atttypid, column_.atttypmod) AS column_type
			 FROM ${fixture.schema}.webauthn_challenge challenge
			 JOIN pg_class table_ ON table_.relname = 'webauthn_challenge'
			 JOIN pg_namespace namespace_ ON namespace_.oid = table_.relnamespace
			   AND namespace_.nspname = $2
			 JOIN pg_attribute column_ ON column_.attrelid = table_.oid
			   AND column_.attname = 'challenge_sha256'
			 WHERE challenge.user_id = $1`,
			[actor, fixture.schema],
		);

		expect(row?.column_type).toBe("bytea");
		expect(row?.challenge_sha256).toHaveLength(32);
		expect(Buffer.from(row?.challenge_sha256 ?? new Uint8Array()).toString("hex")).toBe(
			createHash("sha256").update(challengeToken, "utf8").digest("hex"),
		);
	});

	/** A prefix, not the whole token: the column holds 32 bytes and the token is 43 characters,
	 * so searching for the whole of it would find nothing however the bytes were written. */
	it("never writes the challenge itself into the row", async () => {
		const { challengeToken } = await challenges.issue({ purpose: "register", userId: actor });

		const [found] = await fixture.connection.query<{ hits: number }>(
			`SELECT count(*)::int AS hits FROM ${fixture.schema}.webauthn_challenge
			 WHERE encode(challenge_sha256, 'escape') LIKE $1
			    OR encode(challenge_sha256, 'base64') LIKE $1
			    OR encode(challenge_sha256, 'hex') LIKE $1`,
			[`%${challengeToken.slice(0, 16)}%`],
		);

		expect(found?.hits).toBe(0);
	});

	/** T-RAND-4: the same source and the same encoding as the session token. */
	it("carries at least 256 bit over a thousand challenges", async () => {
		const seen = new Set<string>();
		let smallest = Number.POSITIVE_INFINITY;

		for (let index = 0; index < 1000; index += 1) {
			const { challengeToken, challengeBytes } = await challenges.issue({
				purpose: "register",
				userId: null,
			});
			seen.add(challengeToken);
			smallest = Math.min(smallest, (decodeBase64Url(challengeToken)?.length ?? 0) * 8);
			expect(challengeBytes).toHaveLength(32);
		}

		expect(smallest).toBeGreaterThanOrEqual(256);
		expect(seen.size).toBe(1000);
	});

	describe("T-REPLAY-5", () => {
		it("refuses a second use, a use after five minutes and a use in the wrong ceremony, alike", async () => {
			const spent = await challenges.issue({ purpose: "register", userId: actor });
			expect(await challenges.consume({ ...spent, purpose: "register", userId: actor })).toBe(true);

			const stale = await challenges.issue({ purpose: "register", userId: actor });
			await fixture.connection.query(
				`UPDATE ${fixture.schema}.webauthn_challenge
				 SET expires_at = now() - make_interval(secs => 1)
				 WHERE challenge_sha256 = $1`,
				[createHash("sha256").update(stale.challengeToken, "utf8").digest()],
			);

			const misdirected = await challenges.issue({ purpose: "register", userId: actor });

			const outcomes = [
				await challenges.consume({ ...spent, purpose: "register", userId: actor }),
				await challenges.consume({ ...stale, purpose: "register", userId: actor }),
				await challenges.consume({ ...misdirected, purpose: "authenticate", userId: actor }),
			];

			expect(outcomes).toEqual([false, false, false]);
		});

		it("answers all three rejections with the same bytes", async () => {
			const account = await createAccount(fixture);
			const device = await newAuthenticator();
			const started = await fixture.service.register.start({ actor: account, userName: "a" });
			const response = await device.attest({ challenge: started.challengeToken });
			await fixture.service.register.finish({
				actor: account,
				challengeToken: started.challengeToken,
				response,
				label: "first",
			});

			const stale = await fixture.service.register.start({ actor: account, userName: "a" });
			await fixture.connection.query(
				`UPDATE ${fixture.schema}.webauthn_challenge
				 SET expires_at = now() - make_interval(secs => 1)
				 WHERE challenge_sha256 = $1`,
				[createHash("sha256").update(stale.challengeToken, "utf8").digest()],
			);
			const misdirected = await fixture.service.register.start({
				actor: account,
				userName: "a",
			});

			const misdirectedAssertion = await device.assert({ challenge: misdirected.challengeToken });
			const pendingForAccount = await beginSecondFactor(fixture, account);
			const attempts = [
				() =>
					fixture.service.register.finish({
						actor: account,
						challengeToken: started.challengeToken,
						response,
						label: "again",
					}),
				() =>
					fixture.service.register.finish({
						actor: account,
						challengeToken: stale.challengeToken,
						response,
						label: "late",
					}),
				() =>
					fixture.service.authenticate.finish({
						pending: pendingForAccount,
						challengeToken: misdirected.challengeToken,
						response: misdirectedAssertion,
					}),
			];
			const answers: string[] = [];
			for (const attempt of attempts) {
				answers.push(await attempt().then(() => "accepted", visibleAnswerTo));
			}

			expect(answers[0]).toBe(answers[1]);
			expect(answers[1]).toBe(answers[2]);
			expect(answers[0]).toContain("webauthn_challenge_invalid");
		});

		it("holds a challenge for five minutes and not a second longer", async () => {
			const { challengeToken } = await challenges.issue({ purpose: "register", userId: actor });

			const [row] = await fixture.connection.query<{ lifetime: number }>(
				`SELECT round(extract(epoch FROM expires_at - created_at))::int AS lifetime
				 FROM ${fixture.schema}.webauthn_challenge WHERE challenge_sha256 = $1`,
				[createHash("sha256").update(challengeToken, "utf8").digest()],
			);

			expect(row?.lifetime).toBe(WEBAUTHN_CHALLENGE_LIFETIME_SECONDS);
		});

		it("refuses a passkey challenge presented as a second factor and the other way round", async () => {
			const passkeyChallenge = await challenges.issue({ purpose: "authenticate", userId: null });
			const secondFactorChallenge = await challenges.issue({
				purpose: "authenticate",
				userId: actor,
			});

			expect(
				await challenges.consume({ ...passkeyChallenge, purpose: "authenticate", userId: actor }),
			).toBe(false);
			expect(
				await challenges.consume({
					...secondFactorChallenge,
					purpose: "authenticate",
					userId: null,
				}),
			).toBe(false);
		});

		it("leaves no row behind once a challenge has been spent", async () => {
			const account = await createAccount(fixture);
			const issued = await challenges.issue({ purpose: "register", userId: account });

			await challenges.consume({ ...issued, purpose: "register", userId: account });
			const [remaining] = await fixture.connection.query<{ rows: number }>(
				`SELECT count(*)::int AS rows FROM ${fixture.schema}.webauthn_challenge
				 WHERE user_id = $1`,
				[account],
			);

			expect(remaining?.rows).toBe(0);
		});
	});
});
