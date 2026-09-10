import { describe, expect, it } from "vitest";
import { createVelveClient } from "../src/client/index.js";
import { type ClientRoute, VELVE_CLIENT_ROUTES } from "../src/client/routes.js";
import { createRouteCall } from "../src/client/transport.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { TEST_ORIGIN } from "./auth-fixtures.js";
import { widestVelveAuth } from "./client-fixtures.js";

const BASE_URL = "https://api.example.com";
const NOT_FOUND = 404;

interface MountedHandler {
	readonly fetch: typeof globalThis.fetch;
	readonly statuses: readonly number[];
}

function mountHandler(options: { readonly origin: string | null } = { origin: TEST_ORIGIN }) {
	const handler = toWebHandler(widestVelveAuth());
	const statuses: number[] = [];
	const mounted: MountedHandler = {
		fetch: async (url, init) => {
			const headers = new Headers(init?.headers);
			// The browser writes the header S-CSRF-1 compares, so the stand-in for the browser writes it too.
			if (options.origin !== null) {
				headers.set("Origin", options.origin);
			}
			const response = await handler(new Request(String(url), { ...init, headers }));
			statuses.push(response.status);
			return response;
		},
		get statuses() {
			return statuses;
		},
	};
	return mounted;
}

/** The two callback rows address a path segment; nothing else in the table needs a field to be sent at all. */
function inputFor(route: ClientRoute): Record<string, string> {
	return route.path.includes("/:provider") ? { provider: "github" } : {};
}

describe("the client against the handler the library mounts (architecture 3.15 E)", () => {
	it("reaches a matching route for every row of its table", async () => {
		const mounted = mountHandler();
		const call = createRouteCall({ baseURL: BASE_URL, fetch: mounted.fetch });

		for (const route of VELVE_CLIENT_ROUTES) {
			await call(route, inputFor(route)).catch(() => undefined);
		}

		expect(mounted.statuses).toHaveLength(VELVE_CLIENT_ROUTES.length);
		expect(mounted.statuses.filter((status) => status === NOT_FOUND)).toStrictEqual([]);
	});

	it("reads a route that answers null as a successful result", async () => {
		const client = createVelveClient({ baseURL: BASE_URL, fetch: mountHandler().fetch });

		expect(await client.session.read({})).toStrictEqual({ ok: true, value: null });
		expect(await client.pending.read({})).toStrictEqual({ ok: true, value: null });
	});

	it("reads the library's own refusal as a failed result with the library's own message", async () => {
		const client = createVelveClient({
			baseURL: BASE_URL,
			fetch: mountHandler({ origin: "https://evil.example.com" }).fetch,
		});

		expect(await client.session.read({})).toStrictEqual({
			ok: false,
			error: { code: "origin_not_allowed", message: "The request origin is not allowed." },
		});
	});

	it("is refused everywhere the browser is not, because nothing else writes the origin header", async () => {
		const client = createVelveClient({
			baseURL: BASE_URL,
			fetch: mountHandler({ origin: null }).fetch,
		});

		expect(await client.session.read({})).toStrictEqual({
			ok: false,
			error: { code: "origin_not_allowed", message: "The request origin is not allowed." },
		});
	});
});
