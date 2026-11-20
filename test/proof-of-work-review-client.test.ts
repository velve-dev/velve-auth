import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVelveClient, prepareProofOfWork } from "../src/client/index.js";
import type { ProofOfWorkWorker } from "../src/client/proof-of-work-solver.js";
import { isSolvedAt, PROOF_OF_WORK_HEADER, proofOfWorkInput } from "../src/core/pow/work.js";

/**
 * Review of the client side of change 2 (3.9, 3.15 E): a client that is handed a challenge it must
 * not solve gives up rather than hang, asks only the library's own routes under its own base URL,
 * never spends one route's prepared solution on another, falls back to its own thread when the
 * worker answers nonsense, and the worker reaches no network.
 */

const BASE_URL = "https://auth.example.com/api";
//the default route table joins the fields of every identity mode
const SIGN_UP = { email: "c@example.com", password: "correct-horse-battery-staple" } as never;

interface Sent {
	readonly url: string;
	readonly method: string;
	readonly solution: string | null;
}

function refusal(): Response {
	return new Response(
		JSON.stringify({
			error: { code: "proof_of_work_required", message: "A solved proof of work is required." },
		}),
		{ status: 400, headers: { "Content-Type": "application/json" } },
	);
}

function scriptedServer(challenge: () => unknown, acceptsSolutions = true) {
	const sent: Sent[] = [];
	const fetch: typeof globalThis.fetch = async (url, init) => {
		const headers = new Headers(init?.headers);
		const solution = headers.get(PROOF_OF_WORK_HEADER);
		sent.push({ url: String(url), method: init?.method ?? "GET", solution });
		if (String(url).includes("/proof-of-work/challenge")) {
			return new Response(JSON.stringify(challenge()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (solution !== null && acceptsSolutions) {
			return new Response(JSON.stringify({ user: { id: "u" }, session: null }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		return refusal();
	};
	return { fetch, sent };
}

function inAnHour(): string {
	return new Date(Date.now() + 3_600_000).toISOString();
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe("a challenge the client must not solve", () => {
	it("is given up at once when the server asks for more than 20 bits, after one challenge request", async () => {
		const server = scriptedServer(() => ({
			challenge: "1.64.4102444800.v.m",
			difficulty: 64,
			expiresAt: inAnHour(),
		}));
		const client = createVelveClient({ baseURL: BASE_URL, fetch: server.fetch });

		const result = await client.signUp.withPassword(SIGN_UP);

		expect(result.ok).toBe(false);
		expect(result.ok ? null : result.error.code).toBe("proof_of_work_required");
		expect(server.sent).toHaveLength(2);
		expect(server.sent[1]?.url).toContain("/proof-of-work/challenge");
	});

	it("is given up for a challenge that is no string, a fractional or negative difficulty, or no expiry", async () => {
		for (const issued of [
			{ challenge: 7, difficulty: 4, expiresAt: inAnHour() },
			{ challenge: "c", difficulty: 4.5, expiresAt: inAnHour() },
			{ challenge: "c", difficulty: -1, expiresAt: inAnHour() },
			{ challenge: "c", difficulty: 4, expiresAt: "never" },
			null,
		]) {
			const server = scriptedServer(() => issued);
			const client = createVelveClient({ baseURL: BASE_URL, fetch: server.fetch });

			const result = await client.signUp.withPassword(SIGN_UP);

			expect(result.ok, JSON.stringify(issued)).toBe(false);
			expect(server.sent, JSON.stringify(issued)).toHaveLength(2);
		}
	});
});

describe("where the client sends what it solved", () => {
	it("asks the challenge of its own route under its own base URL and sends the solution only there", async () => {
		const server = scriptedServer(() => ({
			challenge: "client-review",
			difficulty: 6,
			expiresAt: inAnHour(),
		}));
		const client = createVelveClient({ baseURL: BASE_URL, fetch: server.fetch });

		const result = await client.password.requestReset({ email: "r@example.com" });

		expect(result.ok).toBe(true);
		expect(server.sent.map((sent) => sent.url.startsWith(`${BASE_URL}/`))).toStrictEqual([
			true,
			true,
			true,
		]);
		const challengeUrl = new URL(server.sent[1]?.url ?? "");
		expect(challengeUrl.pathname).toBe("/api/proof-of-work/challenge");
		expect(challengeUrl.searchParams.get("route")).toBe("password.requestReset");
		expect(server.sent[1]?.method).toBe("GET");
		expect(server.sent[1]?.solution).toBeNull();
		const solution = server.sent[2]?.solution ?? "";
		const nonce = Number(solution.slice(solution.lastIndexOf(".") + 1));
		const digest = new Uint8Array(
			await crypto.subtle.digest("SHA-256", proofOfWorkInput("client-review", nonce)),
		);
		expect(solution.startsWith("client-review.")).toBe(true);
		expect(isSolvedAt(digest, 6)).toBe(true);
	});

	it("never sends a solution prepared for one route with a call of another", async () => {
		let issuedFor = 0;
		const server = scriptedServer(() => {
			issuedFor += 1;
			return {
				challenge: `prepared-${issuedFor}`,
				difficulty: 2,
				expiresAt: inAnHour(),
			};
		});
		const client = createVelveClient({ baseURL: BASE_URL, fetch: server.fetch });

		await prepareProofOfWork(client, { route: "signUp.withPassword" });
		await client.password.requestReset({ email: "r@example.com" });

		const reset = server.sent.find((sent) => sent.url.endsWith("/password/request-reset"));
		expect(reset?.solution).toBeNull();
		const signUp = server.sent.filter((sent) => sent.url.endsWith("/sign-up"));
		expect(signUp).toHaveLength(0);
	});

	it("solves on its own thread when the worker answers a nonce that is no nonce", async () => {
		const server = scriptedServer(() => ({
			challenge: "garbage-worker",
			difficulty: 6,
			expiresAt: inAnHour(),
		}));
		let terminated = 0;
		const worker: ProofOfWorkWorker = {
			postMessage: () => {
				queueMicrotask(() => listeners.message?.({ data: { solved: true, nonce: -3 } }));
			},
			addEventListener: (type, listener) => {
				listeners[type] = listener;
			},
			terminate: () => {
				terminated += 1;
			},
		};
		const listeners: Partial<Record<string, (event: { readonly data?: unknown }) => void>> = {};
		const client = createVelveClient({
			baseURL: BASE_URL,
			fetch: server.fetch,
			createProofOfWorkWorker: () => worker,
		});

		const result = await client.signUp.withPassword(SIGN_UP);

		expect(result.ok).toBe(true);
		expect(terminated).toBe(1);
		const solution = server.sent.at(-1)?.solution ?? "";
		const nonce = Number(solution.slice(solution.lastIndexOf(".") + 1));
		const digest = new Uint8Array(
			await crypto.subtle.digest("SHA-256", proofOfWorkInput("garbage-worker", nonce)),
		);
		expect(isSolvedAt(digest, 6)).toBe(true);
	});
});

describe("the worker reaches no network (E-3671)", () => {
	it("solves a task without calling fetch, XMLHttpRequest, WebSocket or importScripts", async () => {
		const reached: string[] = [];
		for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "importScripts", "EventSource"]) {
			vi.stubGlobal(name, () => {
				reached.push(name);
				throw new Error(`${name} is not for the worker`);
			});
		}
		const posted: unknown[] = [];
		let listener: ((event: { readonly data: unknown }) => void) | undefined;
		vi.stubGlobal("addEventListener", (_type: string, received: typeof listener) => {
			listener = received;
		});
		vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
		await import("../src/client/proof-of-work-worker.js");

		listener?.({ data: { challenge: "no-network", difficulty: 8 } });
		await vi.waitFor(() => expect(posted).toHaveLength(1));

		expect(reached).toStrictEqual([]);
		expect(posted[0]).toMatchObject({ solved: true });
	});

	it("names no network primitive in the worker's closure", () => {
		const closure = [
			"src/client/proof-of-work-worker.ts",
			"src/client/proof-of-work-solver.ts",
			"src/core/pow/work.ts",
			"src/core/pow/config.ts",
		].map((path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

		for (const source of closure) {
			expect(source).not.toMatch(
				/\bfetch\b|XMLHttpRequest|WebSocket|importScripts|EventSource|sendBeacon|\bimport\(/,
			);
		}
	});
});
