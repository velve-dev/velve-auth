import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import { DEFAULT_COOKIE_NAMES } from "../src/core/http/cookies.js";
import type { PluginHooks, VelvePlugin } from "../src/core/plugin/config.js";
import { type MountedAuth, mountAuth, TEST_ORIGIN } from "./auth-fixtures.js";
import { dropSchema } from "./db-fixtures.js";
import { postTo } from "./flows-fixtures.js";
import { drawTestPassword } from "./password-fixtures.js";

/**
 * T-DEFAULT-2 as a type check over every key reachable from the configuration, nested objects,
 * array elements and union members included. A key is a switch for keeping the other sessions
 * when its lower-cased name contains one of the words below.
 */

type SwitchWord = "revoke" | "keep" | "preserve" | "retain" | "other";

type Depth = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8];
const WALK_DEPTH = 8;

type ElementOf<T> = T extends readonly (infer Element)[] ? Element : T;

//an index signature would widen the union to string and hide every literal key in it
type LiteralKeys<T> = keyof {
	[Key in keyof T & string as string extends Key ? never : Key]: true;
};

type ReachableKeys<T, Remaining extends number = typeof WALK_DEPTH> = [Remaining] extends [never]
	? never
	: T extends (...args: never[]) => unknown
		? never
		: ElementOf<T> extends infer Value
			? Value extends object
				? {
						[Key in LiteralKeys<Value>]-?:
							| Key
							| ReachableKeys<NonNullable<Value[Key]>, Depth[Remaining]>;
					}[LiteralKeys<Value>]
				: never
			: never;

type CaseInsensitiveSwitchKeys<T> = {
	[Key in ReachableKeys<T>]: Lowercase<Key> extends `${string}${SwitchWord}${string}` ? Key : never;
}[ReachableKeys<T>];

const REFUSES_EVERY_REVOCATION: VelvePlugin<"refuser"> = {
	id: "refuser",
	hooks: {
		beforeSessionRevoke: () => Promise.reject(new Error("this plugin keeps every session")),
	},
};

let mounted: MountedAuth;

beforeAll(async () => {
	mounted = await mountAuth("defaultrevoke", {
		plugins: [REFUSES_EVERY_REVOCATION],
		rateLimit: {
			perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
			perAccount: { capacity: 100_000, refillPerSecond: 100_000 },
		},
	});
}, 60_000);

afterAll(async () => {
	await dropSchema(mounted.connection, mounted.schema);
	await mounted.connection.close();
});

function sessionCookieOf(answer: Response): string {
	for (const header of answer.headers.getSetCookie()) {
		const [pair = ""] = header.split(";");
		const separator = pair.indexOf("=");
		if (pair.slice(0, separator) === DEFAULT_COOKIE_NAMES.session) {
			return pair.slice(separator + 1);
		}
	}
	throw new Error(`the answer (${answer.status}) wrote no session cookie`);
}

describe("T-DEFAULT-2 — no option switches off the revocation of other sessions (S-DEFAULT-2)", () => {
	//the one name the words reach is a plugin hook and not a switch, which the last case drives
	it("finds no such key in the configuration of any identity mode but the revocation hook", () => {
		expectTypeOf<
			CaseInsensitiveSwitchKeys<VelveAuthConfig<"email">>
		>().toEqualTypeOf<"beforeSessionRevoke">();
		expectTypeOf<
			CaseInsensitiveSwitchKeys<VelveAuthConfig<"username">>
		>().toEqualTypeOf<"beforeSessionRevoke">();
		expectTypeOf<
			CaseInsensitiveSwitchKeys<VelveAuthConfig<"username_email">>
		>().toEqualTypeOf<"beforeSessionRevoke">();
		expectTypeOf<NonNullable<PluginHooks["beforeSessionRevoke"]>>().toBeFunction();
	});

	it("walks into nested objects, array elements and union members, so the check can fail", () => {
		interface Planted {
			readonly session?: { readonly idle?: number; readonly keepOthers?: boolean };
			readonly plugins?: readonly { readonly onChange?: { readonly retainSessions: true } }[];
			readonly rateLimit?: "none" | { readonly revokeOtherSessions: false };
			readonly hook?: (input: { readonly preserve: boolean }) => void;
		}

		expectTypeOf<CaseInsensitiveSwitchKeys<Planted>>().toEqualTypeOf<
			"keepOthers" | "retainSessions" | "revokeOtherSessions"
		>();
	});

	it("reaches the deepest keys the configuration has, so a clean result is not an empty walk", () => {
		type Reached = ReachableKeys<VelveAuthConfig<"email">>;

		expectTypeOf<"refillPerSecond">().toExtend<Reached>();
		expectTypeOf<"userVerification">().toExtend<Reached>();
		expectTypeOf<"idleTimeout">().toExtend<Reached>();
		expectTypeOf<"memoryKiB">().toExtend<Reached>();
	});

	it("revokes the other sessions on a password change even when that hook refuses every revocation", async () => {
		const password = drawTestPassword();
		const email = "hooked@example.com";
		const signedUp = await mounted.handler(postTo("/sign-up", { email, password }));
		const calling = sessionCookieOf(signedUp);
		const other = await mounted.auth.signIn.password({ email, password, origin: TEST_ORIGIN });
		if (other.status !== "signed_in") {
			throw new Error(`the second sign-in was answered ${other.status}`);
		}

		const changed = await mounted.handler(
			postTo(
				"/password/change",
				{ currentPassword: password, newPassword: drawTestPassword() },
				{ Cookie: `${DEFAULT_COOKIE_NAMES.session}=${calling}` },
			),
		);

		expect(changed.status).toBe(200);
		expect(
			await mounted.auth.session.resolve({
				origin: TEST_ORIGIN,
				sessionToken: other.sessionToken,
			}),
		).toBeNull();
	}, 60_000);
});
