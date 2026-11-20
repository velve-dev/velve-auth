import { afterEach, describe, expect, it } from "vitest";
import { solveProofOfWork } from "../src/client/proof-of-work-solver.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import type { ProofOfWorkRoute } from "../src/core/pow/config.js";
import { PROOF_OF_WORK_HEADER } from "../src/core/pow/work.js";
import { requestTo, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import {
	codeOf,
	mountProofOfWork,
	type ProofOfWorkBench,
	solvedFor,
} from "./proof-of-work-fixtures.js";

/**
 * Password sign-in asks for a proof once the failure counter of its account or of its address
 * reaches the threshold, and passkey sign-in once that of its address does (3.9, S-RATE-11). The
 * counters are keyed like the rate buckets (L-5), so an identifier with no account behind it asks
 * after exactly as many failures as one with an account, and a refusal for a missing proof draws
 * no account token and reaches no KDF.
 */

const PASSWORD = "correct-horse-battery-staple";
const ADDRESS_HEADER = "x-test-connection-address";

interface SignInBench extends ProofOfWorkBench {
	readonly from: (request: Request, address: string) => Promise<Response>;
}

const benches: ProofOfWorkBench[] = [];

afterEach(async () => {
	for (const mounted of benches.splice(0)) {
		await dropSchema(mounted.connection, mounted.schema);
		await mounted.connection.close();
	}
});

async function bench(
	prefix: string,
	overrides: Parameters<typeof mountProofOfWork>[1] = {},
): Promise<SignInBench> {
	const mounted = await mountProofOfWork(prefix, overrides);
	benches.push(mounted);
	const handler = toWebHandler(mounted.auth, {
		connectionAddress: (request) => request.headers.get(ADDRESS_HEADER),
	});
	return Object.assign(mounted, {
		from: (request: Request, address: string) => {
			request.headers.set(ADDRESS_HEADER, address);
			return handler(request);
		},
	});
}

async function serverSolution(mounted: ProofOfWorkBench, route: ProofOfWorkRoute) {
	const issued = await mounted.auth.proofOfWork.challenge({ route, origin: TEST_ORIGIN });
	return { challenge: issued.challenge, nonce: await solveProofOfWork(issued) };
}

async function signUp(mounted: ProofOfWorkBench, email: string): Promise<void> {
	await mounted.auth.signUp.withPassword({
		email,
		password: PASSWORD,
		origin: TEST_ORIGIN,
		proofOfWork: await serverSolution(mounted, "signUp.withPassword"),
	});
}

function signIn(email: string, password: string, solution: string | null = null): Request {
	const request = requestTo("/sign-in/password", { body: { email, password } });
	if (solution !== null) {
		request.headers.set(PROOF_OF_WORK_HEADER, solution);
	}
	return request;
}

async function codesOfFailedAttempts(
	mounted: SignInBench,
	email: string,
	address: string,
	attempts: number,
): Promise<(string | null)[]> {
	const codes: (string | null)[] = [];
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		codes.push(await codeOf(await mounted.from(signIn(email, "wrong-password-xx"), address)));
	}
	return codes;
}

async function accountTokens(mounted: ProofOfWorkBench): Promise<number[]> {
	const rows = await mounted.connection.query<{ tokens: number }>(
		`SELECT tokens FROM ${mounted.schema}.rate_bucket WHERE bucket_key LIKE 'account|%' ORDER BY bucket_key`,
		[],
	);
	return rows.map((row) => Number(row.tokens));
}

describe("password sign-in after failures on one account (S-RATE-11)", () => {
	it("asks after the same number of failures whether or not the account exists", async () => {
		const mounted = await bench("pow_signin_alike");
		await signUp(mounted, "known@example.com");

		const known = await codesOfFailedAttempts(mounted, "known@example.com", "198.51.100.1", 4);
		const unknown = await codesOfFailedAttempts(mounted, "nobody@example.com", "198.51.100.2", 4);

		const expected = [
			"invalid_credentials",
			"invalid_credentials",
			"invalid_credentials",
			"proof_of_work_required",
		];
		expect(known).toStrictEqual(expected);
		expect(unknown).toStrictEqual(expected);
	});

	it("follows the account to another address", async () => {
		const mounted = await bench("pow_signin_account");
		await codesOfFailedAttempts(mounted, "victim@example.com", "198.51.100.1", 3);

		const elsewhere = await mounted.from(
			signIn("victim@example.com", "wrong-password-xx"),
			"203.0.113.9",
		);

		expect(await codeOf(elsewhere)).toBe("proof_of_work_required");
	});

	it("draws no account token for a refusal without a proof, so the KDF is never reached", async () => {
		const mounted = await bench("pow_signin_no_draw");
		await codesOfFailedAttempts(mounted, "victim@example.com", "198.51.100.1", 3);
		const before = await accountTokens(mounted);

		for (let attempt = 0; attempt < 10; attempt += 1) {
			await mounted.from(signIn("victim@example.com", "wrong-password-xx"), "198.51.100.1");
		}

		expect(await accountTokens(mounted)).toStrictEqual(before);
	});

	it("signs the owner in with a solution and the right password", async () => {
		const mounted = await bench("pow_signin_owner");
		await signUp(mounted, "owner@example.com");
		await codesOfFailedAttempts(mounted, "owner@example.com", "198.51.100.1", 3);

		const solution = await solvedFor(mounted.handler, "signIn.password");
		const response = await mounted.from(
			signIn("owner@example.com", PASSWORD, solution),
			"198.51.100.1",
		);

		expect(response.status).toBe(200);
	});

	it("keeps counting a wrong password that came with a solution", async () => {
		const mounted = await bench("pow_signin_counted");
		await codesOfFailedAttempts(mounted, "victim@example.com", "198.51.100.1", 3);

		const solution = await solvedFor(mounted.handler, "signIn.password");
		const solved = await mounted.from(
			signIn("victim@example.com", "wrong-password-xx", solution),
			"198.51.100.1",
		);

		expect(await codeOf(solved)).toBe("invalid_credentials");
		const counters = await mounted.connection.query<{ tokens: number }>(
			`SELECT tokens FROM ${mounted.schema}.rate_bucket WHERE bucket_key LIKE 'failures|account|%'`,
			[],
		);
		expect(counters.map((row) => Math.round(Number(row.tokens)))).toStrictEqual([4]);
	});

	it("keeps the identifier out of the counter's key (S-RATE-7)", async () => {
		const mounted = await bench("pow_signin_key");
		await codesOfFailedAttempts(mounted, "secret-person@example.com", "198.51.100.1", 1);

		const keys = await mounted.connection.query<{ bucket_key: string }>(
			`SELECT bucket_key FROM ${mounted.schema}.rate_bucket WHERE bucket_key LIKE 'failures|%'`,
			[],
		);

		expect(keys).toHaveLength(2);
		expect(keys.some((row) => row.bucket_key.includes("secret-person"))).toBe(false);
	});
});

describe("password sign-in after failures from one address (S-RATE-11)", () => {
	it("asks a fresh identifier once the address has failed often enough", async () => {
		const mounted = await bench("pow_signin_address");
		for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
			await codesOfFailedAttempts(mounted, email, "198.51.100.7", 1);
		}

		const fresh = await mounted.from(signIn("d@example.com", "wrong-password-xx"), "198.51.100.7");
		const otherAddress = await mounted.from(
			signIn("d@example.com", "wrong-password-xx"),
			"198.51.100.8",
		);

		expect(await codeOf(fresh)).toBe("proof_of_work_required");
		expect(await codeOf(otherAddress)).toBe("invalid_credentials");
	});
});

describe("the failure counter forgets (S-RATE-11, S-RATE-7)", () => {
	it("asks no proof once an hour has passed after the threshold was reached", async () => {
		let now = Date.now();
		const mounted = await bench("pow_signin_forgets", { clock: { now: () => new Date(now) } });
		await codesOfFailedAttempts(mounted, "victim@example.com", "198.51.100.1", 3);

		const before = await mounted.from(
			signIn("victim@example.com", "wrong-password-xx"),
			"198.51.100.1",
		);
		now += 3600 * 1000 + 1000;
		const after = await mounted.from(
			signIn("victim@example.com", "wrong-password-xx"),
			"198.51.100.1",
		);

		expect(await codeOf(before)).toBe("proof_of_work_required");
		expect(await codeOf(after)).toBe("invalid_credentials");
	});
});

describe("the threshold the application chooses (S-RATE-12)", () => {
	it("is asked on every request and clamped to at least one failure", async () => {
		const mounted = await bench("pow_signin_threshold");
		mounted.threshold = -5;

		const codes = await codesOfFailedAttempts(mounted, "victim@example.com", "198.51.100.1", 2);

		expect(codes).toStrictEqual(["invalid_credentials", "proof_of_work_required"]);
		expect(mounted.thresholdAskedFor).toStrictEqual(["signIn.password", "signIn.password"]);
	});

	it("asks after the first failure when the answer is no number", async () => {
		const mounted = await bench("pow_signin_threshold_nan");
		mounted.threshold = "five";

		const codes = await codesOfFailedAttempts(mounted, "victim@example.com", "198.51.100.1", 2);

		expect(codes).toStrictEqual(["invalid_credentials", "proof_of_work_required"]);
	});
});

describe("passkey sign-in after failures from one address (S-RATE-11)", () => {
	const webauthn = {
		relyingPartyId: "app.example.com",
		relyingPartyName: "Velve Auth tests",
		origins: [TEST_ORIGIN],
		userVerification: "required" as const,
	};

	function finish(): Request {
		return requestTo("/sign-in/passkey/finish", {
			body: { challengeToken: "no-such-challenge", response: {} },
		});
	}

	it("asks once the address has failed as often as the threshold, and counts no account", async () => {
		const mounted = await bench("pow_passkey", { webauthn });

		const codes: (string | null)[] = [];
		for (let attempt = 0; attempt < 4; attempt += 1) {
			codes.push(await codeOf(await mounted.from(finish(), "198.51.100.3")));
		}
		const elsewhere = await mounted.from(finish(), "198.51.100.4");
		const keys = await mounted.connection.query<{ bucket_key: string }>(
			`SELECT bucket_key FROM ${mounted.schema}.rate_bucket WHERE bucket_key LIKE 'failures|%'`,
			[],
		);

		expect(codes).toStrictEqual([
			"webauthn_challenge_invalid",
			"webauthn_challenge_invalid",
			"webauthn_challenge_invalid",
			"proof_of_work_required",
		]);
		expect(await codeOf(elsewhere)).toBe("webauthn_challenge_invalid");
		expect(keys.every((row) => row.bucket_key.startsWith("failures|ip|"))).toBe(true);
		expect(mounted.thresholdAskedFor.every((route) => route === "signIn.passkey.finish")).toBe(
			true,
		);
	});
});
