import { describe, expect, it } from "vitest";
import {
	createVelveClient,
	unwrap,
	VelveError,
	type VelveResult,
	VelveTransportError,
} from "../src/client/index.js";
import { VELVE_CLIENT_ROUTES } from "../src/client/routes.js";

const BASE_URL = "https://api.example.com/auth";

interface RecordedCall {
	readonly url: string;
	readonly init: RequestInit;
}

interface Recorder {
	readonly fetch: typeof globalThis.fetch;
	readonly calls: readonly RecordedCall[];
	last(): RecordedCall;
}

function recorderAnswering(answer: () => Response | Promise<Response>): Recorder {
	const calls: RecordedCall[] = [];
	return {
		fetch: (url, init) => {
			calls.push({ url: String(url), init: init ?? {} });
			return Promise.resolve(answer());
		},
		get calls() {
			return calls;
		},
		last: () => {
			const call = calls.at(-1);
			if (call === undefined) {
				throw new Error("nothing was sent");
			}
			return call;
		},
	};
}

function jsonAnswer(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** The surface the compiler builds for the library's own table; the calls below are its leaves. */
function clientAnswering(answer: () => Response | Promise<Response>) {
	const recorder = recorderAnswering(answer);
	return { recorder, client: createVelveClient({ baseURL: BASE_URL, fetch: recorder.fetch }) };
}

describe("what the client sends (architecture 3.15 E)", () => {
	it("reads the method and the path of the row it was built from", async () => {
		const { recorder, client } = clientAnswering(() => new Response(null, { status: 204 }));

		await client.session.revokeAll({});

		expect(recorder.last().url).toBe(`${BASE_URL}/session/revoke-all`);
		expect(recorder.last().init.method).toBe("POST");
	});

	it("sends a GET route as a GET with no body, whatever its input", async () => {
		const { recorder, client } = clientAnswering(() => jsonAnswer(200, { available: true }));

		await client.username.isAvailable({ username: "ada lovelace" });

		expect(recorder.last().init.method).toBe("GET");
		expect(recorder.last().init.body).toBeUndefined();
		expect(recorder.last().url).toBe(`${BASE_URL}/username/available?username=ada+lovelace`);
	});

	it("sends a POST route as a POST with a JSON body", async () => {
		const { recorder, client } = clientAnswering(() => new Response(null, { status: 204 }));

		await client.session.revoke({ targetSessionId: "s-1" });

		expect(recorder.last().init.body).toBe(JSON.stringify({ targetSessionId: "s-1" }));
		expect(recorder.last().init.headers).toStrictEqual({ "Content-Type": "application/json" });
	});

	it("addresses a path parameter from the input and does not repeat it in the query", async () => {
		const { recorder, client } = clientAnswering(() => jsonAnswer(200, {}));

		await client.signIn.oauth.callback({ provider: "generic oidc", code: "c", state: "s" });

		expect(recorder.last().url).toBe(
			`${BASE_URL}/sign-in/oauth/callback/generic%20oidc?code=c&state=s`,
		);
	});

	it("refuses a call whose path parameter is not there rather than sending the literal segment", async () => {
		const { recorder, client } = clientAnswering(() => jsonAnswer(200, {}));
		const callable = client.signIn.oauth.callback as (input: unknown) => Promise<unknown>;

		await expect(callable({ code: "c", state: "s" })).rejects.toBeInstanceOf(TypeError);
		expect(recorder.calls).toHaveLength(0);
	});

	it("joins a base URL that ends in a slash without doubling it", async () => {
		const recorder = recorderAnswering(() => new Response(null, { status: 204 }));
		const client = createVelveClient({ baseURL: `${BASE_URL}/`, fetch: recorder.fetch });

		await client.signOut({});

		expect(recorder.last().url).toBe(`${BASE_URL}/sign-out`);
	});

	it("never follows a redirect and never lets a cache answer", async () => {
		const { recorder, client } = clientAnswering(() => new Response(null, { status: 204 }));

		await client.pending.cancel({});

		expect(recorder.last().init.redirect).toBe("manual");
		expect(recorder.last().init.cache).toBe("no-store");
		expect(recorder.last().init.credentials).toBe("include");
	});
});

describe("what the client returns (architecture 3.15 E)", () => {
	it("reads a body-less answer as a successful result with no value", async () => {
		const { client } = clientAnswering(() => new Response(null, { status: 204 }));

		expect(await client.signOut({})).toStrictEqual({ ok: true, value: undefined });
	});

	it("reads a JSON answer as the value of a successful result", async () => {
		const { client } = clientAnswering(() => jsonAnswer(200, { available: false }));

		expect(await client.username.isAvailable({ username: "root" })).toStrictEqual({
			ok: true,
			value: { available: false },
		});
	});

	it("reads null as a value rather than as an absent one", async () => {
		const { client } = clientAnswering(() => jsonAnswer(200, null));

		expect(await client.session.read({})).toStrictEqual({ ok: true, value: null });
	});

	it("reads an error envelope as a failed result instead of throwing", async () => {
		const { client } = clientAnswering(() =>
			jsonAnswer(401, { error: { code: "session_required", message: "A session is required." } }),
		);

		expect(await client.session.list({})).toStrictEqual({
			ok: false,
			error: { code: "session_required", message: "A session is required." },
		});
	});

	it("carries the wait of a rate-limited answer and leaves the key absent otherwise", async () => {
		const limited = clientAnswering(() =>
			jsonAnswer(429, {
				error: { code: "rate_limited", message: "Too many requests.", retryAfterSeconds: 12 },
			}),
		);
		const refused = clientAnswering(() =>
			jsonAnswer(400, { error: { code: "invalid_input", message: "The input was rejected." } }),
		);

		const rateLimited = await limited.client.signOut({});
		const invalid = await refused.client.signOut({});

		expect(rateLimited).toStrictEqual({
			ok: false,
			error: { code: "rate_limited", message: "Too many requests.", retryAfterSeconds: 12 },
		});
		expect(invalid.ok).toBe(false);
		expect(invalid.ok === false && "retryAfterSeconds" in invalid.error).toBe(false);
	});
});

describe("the two failures that can carry no code (architecture 3.15 E)", () => {
	it("throws when the request does not reach the server, and keeps the cause", async () => {
		const refusal = new Error("connection refused");
		const client = createVelveClient({
			baseURL: BASE_URL,
			fetch: () => Promise.reject(refusal),
		});

		const thrown = await client.signOut({}).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(VelveTransportError);
		expect((thrown as VelveTransportError).cause).toBe(refusal);
	});

	it("throws when the answer is not a Velve response", async () => {
		const { client } = clientAnswering(
			() =>
				new Response("<html>502</html>", { status: 502, headers: { "Content-Type": "text/html" } }),
		);

		await expect(client.signOut({})).rejects.toBeInstanceOf(VelveTransportError);
	});

	it("throws when a refusal carries no body at all", async () => {
		const { client } = clientAnswering(() => new Response(null, { status: 302 }));

		await expect(client.signOut({})).rejects.toBeInstanceOf(VelveTransportError);
	});

	it("throws when a successful answer carries something that is not JSON", async () => {
		const { client } = clientAnswering(() => new Response("not json", { status: 200 }));

		await expect(client.session.read({})).rejects.toBeInstanceOf(VelveTransportError);
	});

	it("throws neither of the two for a refusal it can read", async () => {
		const { client } = clientAnswering(() =>
			jsonAnswer(403, {
				error: { code: "origin_not_allowed", message: "The origin is not allowed." },
			}),
		);

		await expect(client.signOut({})).resolves.toMatchObject({ ok: false });
	});
});

describe("unwrap (architecture 3.15 E)", () => {
	it("hands back the value of a successful result", () => {
		expect(unwrap({ ok: true, value: 7 } as VelveResult<number, "invalid_input">)).toBe(7);
	});

	it("throws the server's own error class for a failed one", () => {
		const failed: VelveResult<never, "rate_limited"> = {
			ok: false,
			error: { code: "rate_limited", message: "Too many requests.", retryAfterSeconds: 30 },
		};

		const thrown = ((): unknown => {
			try {
				unwrap(failed);
				return null;
			} catch (error: unknown) {
				return error;
			}
		})();

		expect(thrown).toBeInstanceOf(VelveError);
		expect((thrown as VelveError).code).toBe("rate_limited");
		expect((thrown as VelveError).retryAfterSeconds).toBe(30);
	});
});

describe("the object the client is (architecture 3.15 E)", () => {
	it("holds one function for each row of the table and no other leaf", () => {
		const { client } = clientAnswering(() => new Response(null, { status: 204 }));

		const leaves: string[] = [];
		const walk = (node: Record<string, unknown>, prefix: string): void => {
			for (const [key, value] of Object.entries(node)) {
				const name = prefix === "" ? key : `${prefix}.${key}`;
				if (typeof value === "function") {
					leaves.push(name);
				} else {
					walk(value as Record<string, unknown>, name);
				}
			}
		};
		walk(client as unknown as Record<string, unknown>, "");

		expect(leaves.toSorted()).toStrictEqual(
			VELVE_CLIENT_ROUTES.map((route) => route.name).toSorted(),
		);
	});

	it("answers a call that is not in the table with a TypeError", () => {
		const { client } = clientAnswering(() => new Response(null, { status: 204 }));
		const unmapped = client as unknown as {
			readonly factor: { verify: () => Promise<unknown> };
			readonly session: { destroy: () => Promise<unknown> };
		};

		expect(() => unmapped.factor.verify()).toThrow(TypeError);
		expect(() => unmapped.session.destroy()).toThrow(TypeError);
	});
});
