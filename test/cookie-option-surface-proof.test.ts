import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import type { IdentityMode } from "../src/core/db/migrations/identity-mode.js";
import type { SessionConfig } from "../src/core/session/config.js";
import { withoutComments } from "../tools/source-text.mjs";

type Depth = readonly unknown[];

/** An index signature's key is `string`, which would swallow every literal key beside it. */
type NamedKey<Key> = string extends Key ? never : number extends Key ? never : Key;

/**
 * Every property name reachable from an options object, descending through nested objects and
 * arrays and stopping at functions, which are callbacks and not options. The depth bound only
 * keeps the compiler from following a self-referencing type forever.
 */
type OptionKeys<T, Seen extends Depth = []> = Seen["length"] extends 8
	? never
	: T extends (...args: never[]) => unknown
		? never
		: T extends readonly (infer Element)[]
			? OptionKeys<Element, [...Seen, 0]>
			: T extends object
				? {
						[Key in keyof T]-?: NamedKey<Key> | OptionKeys<NonNullable<T[Key]>, [...Seen, 0]>;
					}[keyof T]
				: never;

type CookieAttributeKey = "httponly" | "secure" | "domain" | "path";

/** The keys of `T`, at any depth, that name a cookie attribute in any capitalisation. */
type CookieAttributeKeysIn<T> = Extract<
	Lowercase<Extract<OptionKeys<T>, string>>,
	CookieAttributeKey
>;

/**
 * A plugin's route declaration has a `path`, which is a URL and not a cookie attribute; the
 * plugin is code the application writes, not an option it sets, so it is held apart here.
 */
type ConfigurationOptions<M extends IdentityMode> = Omit<VelveAuthConfig<M>, "plugins">;

describe("no option reaches a cookie attribute (S-COOKIE-2, T-COOKIE-2 type check)", () => {
	it("gives the session cookie exactly one option, sameSite", () => {
		expectTypeOf<keyof SessionConfig["cookie"]>().toEqualTypeOf<"sameSite">();
		expectTypeOf<SessionConfig["cookie"]["sameSite"]>().toEqualTypeOf<"lax" | "strict">();
	});

	it("names no HttpOnly, Secure, Domain or Path anywhere in the options of any mode", () => {
		expectTypeOf<CookieAttributeKeysIn<ConfigurationOptions<"email">>>().toBeNever();
		expectTypeOf<CookieAttributeKeysIn<ConfigurationOptions<"username">>>().toBeNever();
		expectTypeOf<CookieAttributeKeysIn<ConfigurationOptions<"username_email">>>().toBeNever();
	});

	it("reaches deep enough to find the one option it does allow", () => {
		expectTypeOf<"sameSite">().toExtend<OptionKeys<ConfigurationOptions<"email">>>();
		expectTypeOf<"cookieName">().toExtend<OptionKeys<ConfigurationOptions<"email">>>();
		expectTypeOf<"clientSecret">().toExtend<OptionKeys<ConfigurationOptions<"email">>>();
	});

	it("finds only the plugin route's URL path once the plugins are included", () => {
		expectTypeOf<
			CookieAttributeKeysIn<VelveAuthConfig<"username_email">>
		>().toEqualTypeOf<"path">();
	});

	it("finds a planted attribute option, so a never above means something", () => {
		type Planted = ConfigurationOptions<"email"> & {
			readonly session: { readonly cookie: { readonly sameSite: "lax"; readonly httpOnly: false } };
			readonly oauth: { readonly stateCookie: readonly { readonly Domain: string }[] };
		};

		expectTypeOf<CookieAttributeKeysIn<Planted>>().toEqualTypeOf<"httponly" | "domain">();
	});
});

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
const COOKIE_MODULE = "core/http/cookies.ts";

interface Source {
	readonly path: string;
	readonly text: string;
}

function everySource(): readonly Source[] {
	return readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
		.filter((path) => path.endsWith(".ts"))
		.sort()
		.map((path) => ({
			path,
			text: withoutComments(readFileSync(`${sourceRoot}/${path}`, "utf8")),
		}));
}

const ATTRIBUTE_SET_LITERAL = /HttpOnly;\s*Secure;\s*SameSite=/;
const ATTRIBUTE_CONSTANT =
	/^const ([A-Z_]+_ATTRIBUTES) = "HttpOnly; Secure; SameSite=[A-Za-z]+; Path=\/";$/;

/**
 * An extension is the attribute set with something written after it: spread into a larger value,
 * concatenated with `+`, or interpolated into a template that goes on after it.
 */
const EXTENSIONS: readonly RegExp[] = [
	/\.\.\.\s*[A-Za-z_.]*attributes\b/i,
	/[A-Za-z_.]*attributes\s*\+/i,
	/\+\s*[A-Za-z_.]*attributes\b/i,
	/\$\{\s*[A-Za-z_.]*attributes\s*\}[^`]/i,
	/\bDomain=/,
];

function extensionsIn(sources: readonly Source[]): readonly string[] {
	return sources.flatMap((source) =>
		source.text
			.split("\n")
			.filter((line) => EXTENSIONS.some((pattern) => pattern.test(line)))
			.map((line) => `${source.path}: ${line.trim()}`),
	);
}

describe("the attribute set is written in one place and never extended (S-COOKIE-2, T-COOKIE-2 scan)", () => {
	const sources = everySource();

	it("reads the whole source tree", () => {
		expect(sources.length).toBeGreaterThan(50);
		expect(sources.map((source) => source.path)).toContain(COOKIE_MODULE);
	});

	it("constructs the attribute set in src/core/http/cookies.ts and nowhere else", () => {
		const constructing = sources
			.filter((source) => ATTRIBUTE_SET_LITERAL.test(source.text))
			.map((source) => source.path);

		expect(constructing).toStrictEqual([COOKIE_MODULE]);
	});

	it("writes it there only as the declared constants and the type that admits them", () => {
		const cookieModule = sources.find((source) => source.path === COOKIE_MODULE)?.text ?? "";
		const lines = cookieModule.split("\n").filter((line) => ATTRIBUTE_SET_LITERAL.test(line));
		const constants = lines.filter((line) => ATTRIBUTE_CONSTANT.test(line.trim()));
		const typeMembers = lines.filter((line) => /^\|\s*"HttpOnly; Secure;/.test(line.trim()));

		expect(constants.map((line) => ATTRIBUTE_CONSTANT.exec(line.trim())?.[1])).toStrictEqual([
			"LAX_ATTRIBUTES",
			"STRICT_ATTRIBUTES",
			"CROSS_SITE_ATTRIBUTES",
		]);
		expect(lines).toHaveLength(constants.length + typeMembers.length);
	});

	it("extends it nowhere by a spread, a concatenation, a trailing interpolation or a Domain", () => {
		expect(extensionsIn(sources)).toStrictEqual([]);
	});

	it("finds each planted extension, so an empty list above means something", () => {
		const planted = [
			"const extended = { ...attributes, domain: host };",
			"const extended = [...LAX_ATTRIBUTES];",
			'const extended = LAX_ATTRIBUTES + "; Domain=.example.com";',
			["const header = `$", "{instruction.attributes}; Partitioned`;"].join(""),
			'const header = "HttpOnly; Secure; SameSite=Lax; Path=/; Domain=example.com";',
		].map((text, index) => ({ path: `planted-${index}.ts`, text }));

		expect(extensionsIn(planted)).toHaveLength(planted.length);
	});
});
