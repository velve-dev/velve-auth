import { solveProofOfWork } from "../src/client/proof-of-work-solver.js";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import type { ProofOfWorkRoute } from "../src/core/pow/config.js";
import { PROOF_OF_WORK_HEADER, writtenSolution } from "../src/core/pow/work.js";
import { type MountedAuth, mountAuth, requestTo, TEST_ORIGIN } from "./auth-fixtures.js";

/**
 * The proof of work over HTTP (3.9, S-RATE-9 to S-RATE-12): an instance with the proof of work
 * configured, whose difficulty and sign-in threshold the test sets and whose every ask is
 * recorded, so a case can see that the application is asked on each request and never once.
 */

export interface ProofOfWorkBench extends MountedAuth {
	/** the answer the difficulty function gives the next time it is asked */
	difficulty: unknown;
	/** the answer the threshold function gives the next time it is asked */
	threshold: unknown;
	readonly difficultyAskedFor: string[];
	readonly thresholdAskedFor: string[];
}

interface IssuedChallenge {
	readonly challenge: string;
	readonly difficulty: number;
	readonly expiresAt: string;
}

export async function mountProofOfWork(
	prefix: string,
	overrides: Omit<Partial<VelveAuthConfig<"email">>, "database" | "schema"> = {},
): Promise<ProofOfWorkBench> {
	const asked = {
		difficulty: 4 as unknown,
		threshold: 3 as unknown,
		difficultyAskedFor: [] as string[],
		thresholdAskedFor: [] as string[],
	};
	const mounted = await mountAuth(prefix, {
		rateLimit: {
			proofOfWork: {
				difficulty: ({ route }) => {
					asked.difficultyAskedFor.push(route);
					return asked.difficulty as number;
				},
				signInFailuresBeforeProof: ({ route }) => {
					asked.thresholdAskedFor.push(route);
					return asked.threshold as number;
				},
			},
		},
		...overrides,
	});
	return Object.assign(asked, mounted);
}

export function challengeRequest(route: string, origin: string | null = TEST_ORIGIN): Request {
	return requestTo(`/proof-of-work/challenge?route=${encodeURIComponent(route)}`, {
		method: "GET",
		origin,
	});
}

export async function issuedChallenge(
	handler: (request: Request) => Promise<Response>,
	route: ProofOfWorkRoute,
): Promise<IssuedChallenge> {
	const response = await handler(challengeRequest(route));
	if (response.status !== 200) {
		throw new Error(`the challenge route answered ${response.status}`);
	}
	return (await response.json()) as IssuedChallenge;
}

export async function solvedFor(
	handler: (request: Request) => Promise<Response>,
	route: ProofOfWorkRoute,
): Promise<string> {
	const issued = await issuedChallenge(handler, route);
	const nonce = await solveProofOfWork(issued);
	return writtenSolution(issued.challenge, nonce);
}

/** a nonce that leaves the challenge unsolved, found by the same hash the server checks */
export async function unsolvedNonceFor(challenge: string, difficulty: number): Promise<number> {
	const { isSolvedAt, proofOfWorkInput } = await import("../src/core/pow/work.js");
	for (let nonce = 0; ; nonce += 1) {
		const digest = new Uint8Array(
			await crypto.subtle.digest("SHA-256", proofOfWorkInput(challenge, nonce)),
		);
		if (!isSolvedAt(digest, difficulty)) {
			return nonce;
		}
	}
}

export function postWithSolution(path: string, body: unknown, solution: string | null): Request {
	const request = requestTo(path, { body });
	if (solution !== null) {
		request.headers.set(PROOF_OF_WORK_HEADER, solution);
	}
	return request;
}

export async function codeOf(response: Response): Promise<string | null> {
	const text = await response.text();
	if (text === "") {
		return null;
	}
	const body = JSON.parse(text) as { error?: { code?: string } };
	return body.error?.code ?? null;
}

export async function rowCount(bench: MountedAuth, table: string): Promise<number> {
	const rows = await bench.connection.query<{ count: string }>(
		`SELECT count(*)::text AS count FROM ${bench.schema}.${table}`,
		[],
	);
	return Number(rows[0]?.count ?? 0);
}
