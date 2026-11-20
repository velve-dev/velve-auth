import { HIGHEST_PROOF_OF_WORK_DIFFICULTY } from "../core/pow/config.js";
import { isSolvedAt, proofOfWorkInput } from "../core/pow/work.js";

/** what the worker is asked to solve */
export interface ProofOfWorkTask {
	readonly challenge: string;
	readonly difficulty: number;
}

/** the worker a client solves in, which a `Worker` started from the shipped module satisfies */
export interface ProofOfWorkWorker {
	postMessage(task: ProofOfWorkTask): void;
	addEventListener(
		type: "message" | "error",
		listener: (event: { readonly data?: unknown }) => void,
	): void;
	terminate(): void;
}

/** finds the nonce for one challenge, wherever it runs */
export type ProofOfWorkSolver = (task: ProofOfWorkTask) => Promise<number>;

const DIGESTS_PER_ROUND = 256;

//a challenge of at most 20 bits is left unsolved by 2^32 nonces with a chance below e^-4096
const MOST_NONCES_TRIED = 2 ** 32;

/** whether a value is a task this client can solve, which a worker reads from an untyped message */
export function isProofOfWorkTask(value: unknown): value is ProofOfWorkTask {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const { challenge, difficulty } = value as Partial<Record<keyof ProofOfWorkTask, unknown>>;
	return (
		typeof challenge === "string" &&
		typeof difficulty === "number" &&
		Number.isInteger(difficulty) &&
		difficulty >= 0 &&
		difficulty <= HIGHEST_PROOF_OF_WORK_DIFFICULTY
	);
}

async function solvedNonceIn(task: ProofOfWorkTask, firstNonce: number): Promise<number | null> {
	const digests = await Promise.all(
		Array.from({ length: DIGESTS_PER_ROUND }, (_unused, offset) =>
			crypto.subtle.digest("SHA-256", proofOfWorkInput(task.challenge, firstNonce + offset)),
		),
	);
	const solved = digests.findIndex((digest) => isSolvedAt(new Uint8Array(digest), task.difficulty));
	return solved === -1 ? null : firstNonce + solved;
}

//the digests of one round are asked together so the browser can run them while the last is awaited (E-3671)
export async function solveProofOfWork(task: ProofOfWorkTask): Promise<number> {
	for (let firstNonce = 0; firstNonce < MOST_NONCES_TRIED; firstNonce += DIGESTS_PER_ROUND) {
		const solved = await solvedNonceIn(task, firstNonce);
		if (solved !== null) {
			return solved;
		}
	}
	throw new Error("No nonce below 2^32 solved the challenge");
}
