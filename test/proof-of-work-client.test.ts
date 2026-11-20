import { afterEach, describe, expect, it, vi } from "vitest";
import { createVelveClient, prepareProofOfWork } from "../src/client/index.js";
import type { ProofOfWorkWorker } from "../src/client/proof-of-work-solver.js";
import { solveProofOfWork } from "../src/client/proof-of-work-solver.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { PROOF_OF_WORK_HEADER } from "../src/core/pow/work.js";
import { type MountedAuth, mountAuth, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { mountProofOfWork } from "./proof-of-work-fixtures.js";

/**
 * The client side of the proof of work (3.15 E, 3.9): a call the server answers
 * `proof_of_work_required` fetches a challenge for its own route from the library's own route,
 * solves it and is sent once more; `prepare` solves ahead of the call; the worker is the one the
 * application or the package starts, and a worker that cannot run leaves the solving to the
 * calling thread. No request leaves for anywhere but the routes the library mounts.
 */

const BASE_URL = "https://api.example.com";
//the default route table joins the fields of every identity mode, and this instance runs in mode email
const SIGN_UP = { email: "client@example.com", password: "correct-horse-battery-staple" } as never;

const mounts: MountedAuth[] = [];

afterEach(async () => {
	for (const mounted of mounts.splice(0)) {
		await dropSchema(mounted.connection, mounted.schema);
		await mounted.connection.close();
	}
});

interface Sent {
	readonly path: string;
	readonly solution: string | null;
}

function browserFor(mounted: MountedAuth) {
	const handler = toWebHandler(mounted.auth);
	const sent: Sent[] = [];
	const fetch: typeof globalThis.fetch = async (url, init) => {
		const headers = new Headers(init?.headers);
		headers.set("Origin", TEST_ORIGIN);
		const request = new Request(String(url), { ...init, headers });
		sent.push({
			path: new URL(request.url).pathname,
			solution: request.headers.get(PROOF_OF_WORK_HEADER),
		});
		return handler(request);
	};
	return { fetch, sent };
}

describe("a call the server asks a proof of (S-RATE-11)", () => {
	it("fetches a challenge for its own route, solves it and is sent once more", async () => {
		const mounted = await mountProofOfWork("pow_client_retry");
		mounts.push(mounted);
		const browser = browserFor(mounted);
		const client = createVelveClient({ baseURL: BASE_URL, fetch: browser.fetch });

		const result = await client.signUp.withPassword(SIGN_UP);

		expect(result.ok).toBe(true);
		expect(browser.sent.map((request) => request.path)).toStrictEqual([
			"/sign-up",
			"/proof-of-work/challenge",
			"/sign-up",
		]);
		expect(browser.sent.map((request) => request.solution !== null)).toStrictEqual([
			false,
			false,
			true,
		]);
	});

	it("sends a prepared solution with the first call and needs no second", async () => {
		const mounted = await mountProofOfWork("pow_client_prepared");
		mounts.push(mounted);
		const browser = browserFor(mounted);
		const client = createVelveClient({ baseURL: BASE_URL, fetch: browser.fetch });

		await prepareProofOfWork(client, { route: "signUp.withPassword" });
		const result = await client.signUp.withPassword(SIGN_UP);

		expect(result.ok).toBe(true);
		expect(browser.sent.map((request) => request.path)).toStrictEqual([
			"/proof-of-work/challenge",
			"/sign-up",
		]);
	});

	it("asks again at most once when the second answer still refuses", async () => {
		const sent: string[] = [];
		const refuse = () =>
			new Response(
				JSON.stringify({ error: { code: "proof_of_work_required", message: "required" } }),
				{ status: 400 },
			);
		const client = createVelveClient({
			baseURL: BASE_URL,
			fetch: async (url) => {
				const path = new URL(String(url)).pathname;
				sent.push(path);
				return path === "/proof-of-work/challenge"
					? new Response(
							JSON.stringify({
								challenge: "1.0.1.x.y",
								difficulty: 0,
								expiresAt: new Date(Date.now() + 60_000).toISOString(),
							}),
							{ status: 200 },
						)
					: refuse();
			},
		});

		const result = await client.password.requestReset({ email: "a@example.com" });

		expect(result.ok).toBe(false);
		expect(sent).toStrictEqual([
			"/password/request-reset",
			"/proof-of-work/challenge",
			"/password/request-reset",
		]);
	});

	it("passes the refusal through where the server mounts no challenge route", async () => {
		const sent: string[] = [];
		const client = createVelveClient({
			baseURL: BASE_URL,
			fetch: async (url) => {
				const path = new URL(String(url)).pathname;
				sent.push(path);
				return path === "/proof-of-work/challenge"
					? new Response(null, { status: 404 })
					: new Response(
							JSON.stringify({ error: { code: "proof_of_work_required", message: "required" } }),
							{ status: 400 },
						);
			},
		});

		const result = await client.signIn.magicLink.request({ email: "a@example.com" });

		expect(result).toStrictEqual({
			ok: false,
			error: { code: "proof_of_work_required", message: "required" },
		});
		expect(sent).toStrictEqual(["/sign-in/magic-link/request", "/proof-of-work/challenge"]);
	});

	it("is sent once and without a solution where the proof of work is not configured (S-RATE-12)", async () => {
		const mounted = await mountAuth("pow_client_off");
		mounts.push(mounted);
		const browser = browserFor(mounted);
		const client = createVelveClient({ baseURL: BASE_URL, fetch: browser.fetch });

		const result = await client.signUp.withPassword(SIGN_UP);
		await prepareProofOfWork(client, { route: "signUp.withPassword" });

		expect(result.ok).toBe(true);
		expect(browser.sent[0]).toStrictEqual({ path: "/sign-up", solution: null });
	});
});

describe("preparing a solution beside the client (E-3672)", () => {
	it("adds no leaf to the client, which stays the route table", () => {
		const client = createVelveClient({ baseURL: BASE_URL, fetch: async () => new Response(null) });

		expect(Object.keys(client.proofOfWork)).toStrictEqual(["challenge"]);
	});

	it("refuses an object no createVelveClient built", () => {
		expect(() => prepareProofOfWork({}, { route: "signUp.withPassword" })).toThrow(TypeError);
	});
});

describe("the worker a client solves in", () => {
	function workerRunning(solve: (task: unknown) => Promise<unknown>): {
		readonly worker: ProofOfWorkWorker;
		readonly tasks: unknown[];
		terminated: number;
	} {
		const listeners = new Map<string, (event: { readonly data?: unknown }) => void>();
		const state = {
			tasks: [] as unknown[],
			terminated: 0,
			worker: {
				postMessage: (task: unknown) => {
					state.tasks.push(task);
					solve(task).then(
						(data) => listeners.get("message")?.({ data }),
						() => listeners.get("error")?.({}),
					);
				},
				addEventListener: (
					type: string,
					listener: (event: { readonly data?: unknown }) => void,
				) => {
					listeners.set(type, listener);
				},
				terminate: () => {
					state.terminated += 1;
				},
			} as ProofOfWorkWorker,
		};
		return state;
	}

	it("is the one the application starts, and is ended after one task", async () => {
		const mounted = await mountProofOfWork("pow_client_worker");
		mounts.push(mounted);
		const browser = browserFor(mounted);
		const running = workerRunning(async (task) => ({
			solved: true,
			nonce: await solveProofOfWork(task as never),
		}));
		const client = createVelveClient({
			baseURL: BASE_URL,
			fetch: browser.fetch,
			createProofOfWorkWorker: () => running.worker,
		});

		const result = await client.signUp.withPassword(SIGN_UP);

		expect(result.ok).toBe(true);
		expect(running.tasks).toHaveLength(1);
		expect(running.terminated).toBe(1);
	});

	it("leaves the solving to the calling thread when it cannot run", async () => {
		const mounted = await mountProofOfWork("pow_client_fallback");
		mounts.push(mounted);
		const browser = browserFor(mounted);
		const failing = workerRunning(() => Promise.reject(new Error("refused by the policy")));
		const client = createVelveClient({
			baseURL: BASE_URL,
			fetch: browser.fetch,
			createProofOfWorkWorker: () => failing.worker,
		});

		const result = await client.signUp.withPassword(SIGN_UP);

		expect(result.ok).toBe(true);
		expect(failing.terminated).toBe(1);
	});

	it("leaves the solving to the calling thread when it cannot even be started", async () => {
		const mounted = await mountProofOfWork("pow_client_unstarted");
		mounts.push(mounted);
		const browser = browserFor(mounted);
		const client = createVelveClient({
			baseURL: BASE_URL,
			fetch: browser.fetch,
			createProofOfWorkWorker: () => {
				throw new Error("a policy refused the worker source");
			},
		});

		expect((await client.signUp.withPassword(SIGN_UP)).ok).toBe(true);
	});
});

describe("the shipped worker module", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it("answers a task with its nonce and an untyped message with a refusal", async () => {
		const posted: unknown[] = [];
		let listener: ((event: { readonly data: unknown }) => void) | undefined;
		vi.stubGlobal("addEventListener", (_type: string, received: typeof listener) => {
			listener = received;
		});
		vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
		await import("../src/client/proof-of-work-worker.js");

		listener?.({ data: { challenge: "worker-test", difficulty: 4 } });
		listener?.({ data: { challenge: "worker-test", difficulty: 99 } });
		await vi.waitFor(() => expect(posted).toHaveLength(2));

		const expected = await solveProofOfWork({ challenge: "worker-test", difficulty: 4 });
		expect(posted).toContainEqual({ solved: true, nonce: expected });
		expect(posted).toContainEqual({ solved: false });
	});
});
