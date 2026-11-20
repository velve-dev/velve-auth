import type { ProofOfWorkRoute } from "../core/pow/config.js";
import { writtenSolution } from "../core/pow/work.js";
import {
	isProofOfWorkTask,
	type ProofOfWorkSolver,
	type ProofOfWorkTask,
	type ProofOfWorkWorker,
	solveProofOfWork,
} from "./proof-of-work-solver.js";
import type { ClientRoute } from "./routes.js";
import type { RouteCall } from "./transport.js";

/** solves a challenge ahead of the call that will need it, so the work runs while the user types */
export interface ProofOfWorkPreparation {
	prepare(input: { route: ProofOfWorkRoute }): Promise<void>;
}

type WorkerConstructor = new (url: URL, options: { type: "module" }) => ProofOfWorkWorker;

//the literal new URL beside import.meta.url is the form bundlers copy the worker module for (E-3671)
function startShippedWorker(): ProofOfWorkWorker | null {
	const Worker = (globalThis as { Worker?: WorkerConstructor }).Worker;
	if (Worker === undefined) {
		return null;
	}
	return new Worker(new URL("./proof-of-work-worker.mjs", import.meta.url), { type: "module" });
}

function nonceIn(message: unknown): number | null {
	if (typeof message !== "object" || message === null) {
		return null;
	}
	const { solved, nonce } = message as { solved?: unknown; nonce?: unknown };
	return solved === true && typeof nonce === "number" && Number.isSafeInteger(nonce) && nonce >= 0
		? nonce
		: null;
}

function solvedInWorker(worker: ProofOfWorkWorker, task: ProofOfWorkTask): Promise<number> {
	return new Promise((resolve, reject) => {
		worker.addEventListener("message", (event) => {
			worker.terminate();
			const nonce = nonceIn(event.data);
			if (nonce === null) {
				reject(new Error("The proof of work worker did not solve the challenge"));
				return;
			}
			resolve(nonce);
		});
		worker.addEventListener("error", () => {
			worker.terminate();
			reject(new Error("The proof of work worker could not run"));
		});
		worker.postMessage(task);
	});
}

//a worker the page cannot start, as under a policy that refuses it, leaves the solving to this thread (E-3671)
export function createProofOfWorkSolver(
	createWorker: () => ProofOfWorkWorker | null = startShippedWorker,
): ProofOfWorkSolver {
	return async (task) => {
		let worker: ProofOfWorkWorker | null = null;
		try {
			worker = createWorker();
		} catch {
			worker = null;
		}
		if (worker === null) {
			return solveProofOfWork(task);
		}
		return solvedInWorker(worker, task).catch(() => solveProofOfWork(task));
	};
}

interface IssuedChallenge extends ProofOfWorkTask {
	readonly expiresAtMs: number;
}

function issuedChallengeIn(value: unknown): IssuedChallenge | null {
	if (!isProofOfWorkTask(value)) {
		return null;
	}
	const expiresAtMs = Date.parse(String((value as { expiresAt?: unknown }).expiresAt));
	return Number.isNaN(expiresAtMs)
		? null
		: { challenge: value.challenge, difficulty: value.difficulty, expiresAtMs };
}

interface SolvedChallenge {
	readonly solution: string;
	readonly expiresAtMs: number;
}

const PROOF_OF_WORK_REQUIRED = "proof_of_work_required";

/** the route call that solves the challenge a route asks for, and the preparation ahead of it */
export interface ProofOfWorkCalls extends ProofOfWorkPreparation {
	readonly call: (route: ClientRoute, input: unknown) => ReturnType<RouteCall>;
}

//a route that answers proof_of_work_required is asked once more with a fresh solution, never twice (E-3672)
export function createProofOfWorkCalls(
	call: RouteCall,
	challengeRoute: ClientRoute,
	solve: ProofOfWorkSolver,
): ProofOfWorkCalls {
	const prepared = new Map<string, Promise<SolvedChallenge | null>>();

	async function solvedFor(routeName: string): Promise<SolvedChallenge | null> {
		const answered = await call(challengeRoute, { route: routeName }, null);
		const issued = answered.ok ? issuedChallengeIn(answered.value) : null;
		if (issued === null) {
			return null;
		}
		const nonce = await solve(issued);
		return { solution: writtenSolution(issued.challenge, nonce), expiresAtMs: issued.expiresAtMs };
	}

	function solvedQuietly(routeName: string): Promise<SolvedChallenge | null> {
		return solvedFor(routeName).catch(() => null);
	}

	//a prepared solution must never be sent twice nor after the server has stopped accepting it
	async function takePrepared(routeName: string): Promise<string | null> {
		const waiting = prepared.get(routeName);
		if (waiting === undefined) {
			return null;
		}
		prepared.delete(routeName);
		const solved = await waiting;
		return solved !== null && solved.expiresAtMs > Date.now() ? solved.solution : null;
	}

	return {
		async prepare({ route }) {
			const waiting = prepared.get(route);
			const solved = waiting === undefined ? null : await waiting;
			if (solved !== null && solved.expiresAtMs > Date.now()) {
				return;
			}
			const solving = solvedQuietly(route);
			prepared.set(route, solving);
			await solving;
		},

		async call(route, input) {
			const first = await call(route, input, await takePrepared(route.name));
			if (first.ok || first.error.code !== PROOF_OF_WORK_REQUIRED) {
				return first;
			}
			const solved = await solvedQuietly(route.name);
			return solved === null ? first : call(route, input, solved.solution);
		},
	};
}
