import { isProofOfWorkTask, solveProofOfWork } from "./proof-of-work-solver.js";

interface WorkerScope {
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
	postMessage(message: unknown): void;
}

const scope = globalThis as unknown as WorkerScope;

//the worker answers every message, so a client never waits on a task it sent
scope.addEventListener("message", (event) => {
	if (!isProofOfWorkTask(event.data)) {
		scope.postMessage({ solved: false });
		return;
	}
	solveProofOfWork(event.data).then(
		(nonce) => scope.postMessage({ solved: true, nonce }),
		() => scope.postMessage({ solved: false }),
	);
});
