import { afterEach, describe, expect, it } from "vitest";
import { solveProofOfWork } from "../src/client/proof-of-work-solver.js";
import { createProofOfWorkChallenges } from "../src/core/pow/challenge.js";
import { writtenSolution } from "../src/core/pow/work.js";
import { mountAuth, requestTo, TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import {
	challengeRequest,
	codeOf,
	issuedChallenge,
	mountProofOfWork,
	type ProofOfWorkBench,
	postWithSolution,
	rowCount,
	solvedFor,
	unsolvedNonceFor,
} from "./proof-of-work-fixtures.js";

/**
 * The five request routes ask for a solved challenge on every call while the proof of work is
 * configured (3.9, S-RATE-11), every refusal answers one code (S-RATE-9), and a challenge is
 * spent once (S-RATE-10). The bench is a real PostgreSQL schema and the handler the library
 * mounts, so a refusal is read where the browser reads it.
 */

const benches: ProofOfWorkBench[] = [];

async function bench(prefix: string): Promise<ProofOfWorkBench> {
	const mounted = await mountProofOfWork(prefix);
	benches.push(mounted);
	return mounted;
}

afterEach(async () => {
	for (const mounted of benches.splice(0)) {
		await dropSchema(mounted.connection, mounted.schema);
		await mounted.connection.close();
	}
});

const SIGN_UP = { email: "new@example.com", password: "correct-horse-battery-staple" };

describe("a sign-up without a solved challenge (S-RATE-11, S-RATE-9)", () => {
	it("is refused with proof_of_work_required before any account or mail exists", async () => {
		const mounted = await bench("pow_signup_missing");

		const response = await mounted.handler(postWithSolution("/sign-up", SIGN_UP, null));

		expect(response.status).toBe(400);
		expect(await codeOf(response)).toBe("proof_of_work_required");
		expect(await rowCount(mounted, "user")).toBe(0);
		expect(mounted.email.count).toBe(0);
		expect(await rowCount(mounted, "rate_bucket")).toBe(1);
	});

	it("is answered 200 with a solved challenge for the route", async () => {
		const mounted = await bench("pow_signup_solved");
		const solution = await solvedFor(mounted.handler, "signUp.withPassword");

		const response = await mounted.handler(postWithSolution("/sign-up", SIGN_UP, solution));

		expect(response.status).toBe(200);
		expect(await rowCount(mounted, "user")).toBe(1);
		expect(await rowCount(mounted, "proof_of_work_spent")).toBe(1);
	});
});

describe("every way a solution can be wrong answers the same code (S-RATE-9)", () => {
	it("answers proof_of_work_required with one body for missing, malformed, foreign, unsolved and reused", async () => {
		const mounted = await bench("pow_uniform");
		const forSignIn = await solvedFor(mounted.handler, "signIn.password");
		const issued = await issuedChallenge(mounted.handler, "signUp.withPassword");
		const unsolved = writtenSolution(
			issued.challenge,
			await unsolvedNonceFor(issued.challenge, issued.difficulty),
		);
		const used = await solvedFor(mounted.handler, "signUp.withPassword");
		await mounted.handler(
			postWithSolution("/sign-up", { ...SIGN_UP, email: "a@example.com" }, used),
		);

		const bodies: string[] = [];
		for (const solution of [null, "not-a-solution", forSignIn, unsolved, used]) {
			const response = await mounted.handler(
				postWithSolution("/sign-up", { ...SIGN_UP, email: "b@example.com" }, solution),
			);
			expect(response.status).toBe(400);
			bodies.push(await response.text());
		}

		expect(new Set(bodies).size).toBe(1);
		expect(JSON.parse(bodies[0] ?? "{}")).toStrictEqual({
			error: { code: "proof_of_work_required", message: "A solved proof of work is required." },
		});
		expect(await rowCount(mounted, "user")).toBe(1);
	});

	it("names the inner reason in the log and nowhere else", async () => {
		const mounted = await bench("pow_logged");
		const forSignIn = await solvedFor(mounted.handler, "signIn.password");

		await mounted.handler(postWithSolution("/sign-up", SIGN_UP, null));
		await mounted.handler(postWithSolution("/sign-up", SIGN_UP, "1.2.3"));
		await mounted.handler(postWithSolution("/sign-up", SIGN_UP, forSignIn));

		const reasons = mounted.log.lines
			.filter((line) => line.message === "request rejected")
			.map((line) => line.fields.reason);
		expect(reasons).toStrictEqual([
			"proof_of_work_missing",
			"proof_of_work_malformed",
			"proof_of_work_forged",
		]);
	});

	it("refuses a challenge whose expiry the database clock has passed", async () => {
		const keys = testKeyProvider();
		const past = await mountProofOfWork("pow_expired", { keys });
		benches.push(past);
		const issued = await createProofOfWorkChallenges(keys).issue({
			route: "signUp.withPassword",
			difficulty: 4,
			expiresAt: new Date(Date.now() - 1000),
		});
		const solution = writtenSolution(issued.challenge, await solveProofOfWork(issued));

		const response = await past.handler(postWithSolution("/sign-up", SIGN_UP, solution));

		expect(await codeOf(response)).toBe("proof_of_work_required");
		expect(past.log.lines.at(-1)?.fields.reason).toBe("proof_of_work_expired");
		expect(await rowCount(past, "proof_of_work_spent")).toBe(0);
	});

	it("refuses a challenge another instance's keys issued", async () => {
		const mounted = await bench("pow_foreign_keys");
		const other = await bench("pow_other_keys");
		const solution = await solvedFor(other.handler, "signUp.withPassword");

		const response = await mounted.handler(postWithSolution("/sign-up", SIGN_UP, solution));

		expect(await codeOf(response)).toBe("proof_of_work_required");
		expect(mounted.log.lines.at(-1)?.fields.reason).toBe("proof_of_work_forged");
	});
});

describe("a challenge is spent once (S-RATE-10)", () => {
	it("accepts exactly one of twenty parallel uses of one solution", async () => {
		const mounted = await bench("pow_parallel");
		const solution = await solvedFor(mounted.handler, "password.requestReset");

		const statuses = await Promise.all(
			Array.from({ length: 20 }, () =>
				mounted.handler(
					postWithSolution("/password/request-reset", { email: "x@example.com" }, solution),
				),
			),
		).then((responses) => responses.map((response) => response.status));

		expect(statuses.filter((status) => status === 204)).toHaveLength(1);
		expect(statuses.filter((status) => status === 400)).toHaveLength(19);
		expect(mounted.email.count).toBe(1);
		expect(await rowCount(mounted, "proof_of_work_spent")).toBe(1);
	});

	it("keeps the spent row until the expiry and lets the sweep remove it then", async () => {
		const mounted = await bench("pow_sweep");
		const solution = await solvedFor(mounted.handler, "password.requestReset");
		await mounted.handler(
			postWithSolution("/password/request-reset", { email: "x@example.com" }, solution),
		);

		const kept = await mounted.auth.maintenance.sweep();
		await mounted.connection.query(
			`UPDATE ${mounted.schema}.proof_of_work_spent SET expires_at = now() - interval '1 second'`,
			[],
		);
		const swept = await mounted.auth.maintenance.sweep();

		expect(kept.deletedRowsByTable.proof_of_work_spent).toBe(0);
		expect(swept.deletedRowsByTable.proof_of_work_spent).toBe(1);
		expect(await rowCount(mounted, "proof_of_work_spent")).toBe(0);
	});
});

describe("the request routes that mail an address (S-RATE-11)", () => {
	it("send no mail for the reset and magic-link request without a solution", async () => {
		const mounted = await bench("pow_mail");
		for (const path of ["/password/request-reset", "/sign-in/magic-link/request"]) {
			const response = await mounted.handler(
				postWithSolution(path, { email: "someone@example.com" }, null),
			);
			expect(await codeOf(response)).toBe("proof_of_work_required");
		}

		expect(mounted.email.count).toBe(0);
	});

	it("mail once with a solution for each route", async () => {
		const mounted = await bench("pow_mail_solved");
		const reset = await solvedFor(mounted.handler, "password.requestReset");
		const magic = await solvedFor(mounted.handler, "signIn.magicLink.request");

		const answers = [
			await mounted.handler(
				postWithSolution("/password/request-reset", { email: "a@example.com" }, reset),
			),
			await mounted.handler(
				postWithSolution("/sign-in/magic-link/request", { email: "a@example.com" }, magic),
			),
		];

		expect(answers.map((answer) => answer.status)).toStrictEqual([204, 204]);
		expect(mounted.email.kinds()).toStrictEqual([
			"request_for_unknown_address",
			"request_for_unknown_address",
		]);
	});
});

describe("the challenge route", () => {
	it("hands out a challenge bound to the named route and stores nothing", async () => {
		const mounted = await bench("pow_issue");
		mounted.difficulty = 7;

		const issued = await issuedChallenge(mounted.handler, "signUp.withoutPassword");

		expect(issued.difficulty).toBe(7);
		expect(issued.challenge).toMatch(/^1\.7\.\d+\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
		expect(new Date(issued.expiresAt).getTime() - Date.now()).toBeGreaterThan(590_000);
		expect(new Date(issued.expiresAt).getTime() % 1000).toBe(0);
		expect(mounted.difficultyAskedFor).toStrictEqual(["signUp.withoutPassword"]);
		expect(await rowCount(mounted, "proof_of_work_spent")).toBe(0);
	});

	it("refuses a route the proof of work does not guard", async () => {
		const mounted = await bench("pow_issue_unknown");

		const response = await mounted.handler(challengeRequest("signOut"));

		expect(await codeOf(response)).toBe("invalid_input");
	});

	it("is a reading route a same-origin page may call without an Origin header (S-CSRF-4)", async () => {
		const mounted = await bench("pow_issue_same_origin");
		const request = challengeRequest("signUp.withPassword", null);
		const sameOrigin = new Request(request.url, {
			method: "GET",
			headers: { "Sec-Fetch-Site": "same-origin" },
		});

		expect((await mounted.handler(sameOrigin)).status).toBe(200);
		expect(
			(await mounted.handler(challengeRequest("signUp.withPassword", "https://evil.example.com")))
				.status,
		).toBe(403);
	});

	it("does not exist while the proof of work is not configured (S-RATE-12)", async () => {
		const mounted = await mountAuth("pow_unconfigured");
		try {
			const challenge = await mounted.handler(challengeRequest("signUp.withPassword"));
			const signUp = await mounted.handler(
				requestTo("/sign-up", { body: SIGN_UP, origin: TEST_ORIGIN }),
			);

			expect(challenge.status).toBe(404);
			expect(signUp.status).toBe(200);
			expect("proofOfWork" in mounted.auth).toBe(false);
		} finally {
			await dropSchema(mounted.connection, mounted.schema);
			await mounted.connection.close();
		}
	});
});
