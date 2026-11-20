import { describe, expect, it } from "vitest";
import { egressIn, scanEgress } from "../tools/egress.mjs";

/**
 * Security review, area http: `pnpm check:egress` is the only thing that holds README's promise
 * that nothing outside the provider seam reaches the network. Each planted line below sends a
 * request from an ordinary core module with no literal URL beside it, and the check must name it.
 * A `node:`-prefixed import is refused under src/core by test/keys-static-scan.test.ts; the bare
 * specifier is refused by neither.
 */

const ELSEWHERE = "src/core/auth/instance.ts";

describe("check:egress", () => {
	it.each([
		[
			"the https built-in under its bare name",
			'import { request } from "https";\nrequest({ host: target, path: "/e" }).end(body);',
		],
		[
			"the net built-in under its bare name",
			'import { connect } from "net";\nconnect(443, target).write(body);',
		],
		["an aliased fetch", "const send = globalThis.fetch;\nawait send(target, { body });"],
		["fetch.call", "await fetch.call(globalThis, target, { body });"],
		["a computed member", 'await globalThis["fe" + "tch"](target, { body });'],
	])("names a request made through %s", (_shape, planted) => {
		expect(egressIn(ELSEWHERE, planted)).not.toStrictEqual([]);
	});
});

/**
 * Each rule E-3892 adds, shown to fail on a planted fault in a core module before the tree's clean
 * result is trusted (CLAUDE.md §5), in the spellings the five shapes above do not cover.
 */
describe("check:egress names every spelling of each new rule", () => {
	it.each([
		["the node: spelling", 'import tls from "node:tls";'],
		["require", 'const net = require("net");'],
		["a dynamic import", 'const dns = await import("node:dns/promises");'],
		["a re-export", 'export { get } from "http";'],
		["http2", 'import { connect } from "http2";'],
		["dgram", 'import { createSocket } from "dgram";'],
		["dns", 'import { lookup } from "dns";'],
	])("names a network built-in imported through %s", (_spelling, planted) => {
		expect(egressIn(ELSEWHERE, planted).join(" ")).toContain("imports the network module");
	});

	it.each([
		["a bare alias", "const send = fetch;"],
		["shorthand", "const transport = { fetch };"],
		["a ternary", "const send = ok ? fetch : other;"],
		["fetch.apply", "fetch.apply(null, [target]);"],
		["fetch.bind", "const send = fetch.bind(null);"],
	])("names fetch referred to by name through %s", (_spelling, planted) => {
		expect(egressIn(ELSEWHERE, planted).join(" ")).toContain("refers to fetch by name");
	});

	it("names an injected fetch called indirectly", () => {
		expect(egressIn(ELSEWHERE, "await config.fetch.call(null, target);").join(" ")).toContain(
			"calls fetch indirectly with call",
		);
	});

	it.each([
		["window", "const send = window.fetch;"],
		["self", "const send = self?.fetch;"],
	])("names the global fetch taken as a value through %s", (_name, planted) => {
		expect(egressIn(ELSEWHERE, planted).join(" ")).toContain("takes the global fetch as a value");
	});

	it.each([
		["an optional computed member", "await globalThis?.[name](target);"],
		["Reflect.get", "await Reflect.get(globalThis, name)(target);"],
		["a property descriptor", "Object.getOwnPropertyDescriptor(globalThis, name);"],
	])("names the global object read through %s", (_shape, planted) => {
		expect(egressIn(ELSEWHERE, planted).join(" ")).toContain(
			"reads the global object by a computed or reflective member",
		);
	});

	/** The one place the default fetch is resolved is permitted its exact expression once, and
	 * nothing else in that file is. */
	it("permits the provider service its default once, and nothing beside it", () => {
		const service = "src/core/oauth/service.ts";
		const resolved = "const outbound = services.fetch ?? globalThis.fetch;";

		expect(egressIn(service, resolved)).toStrictEqual([]);
		expect(egressIn(service, `${resolved}\nconst again = globalThis.fetch;`)).toHaveLength(1);
		expect(egressIn(ELSEWHERE, resolved)).toHaveLength(1);
	});
});

/** What the rules must not read as a request: a type, a property key, a member passed along, a
 * word in a string or a pattern, and a module whose name only starts like a built-in. */
describe("check:egress does not read these as a request", () => {
	it.each([
		"type Send = typeof globalThis.fetch;",
		"let send: typeof fetch;",
		"interface Options { readonly fetch?: Send; fetch: Send }",
		"const options = { fetch: config.fetch };",
		"const send = options.fetch;",
		'const message = "fetch was refused";',
		"const KEYWORD = /^(?:where|fetch|window)$/;",
		'import { local } from "./net";',
		'import network from "network";',
		'const site = request.headers.get("sec-fetch-site");',
	])("passes %s", (written) => {
		expect(egressIn(ELSEWHERE, written)).toStrictEqual([]);
	});

	it("passes the shipped tree with every new rule in force", () => {
		expect(scanEgress().offenders).toStrictEqual([]);
	});
});
