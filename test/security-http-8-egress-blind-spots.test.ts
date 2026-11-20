import { describe, expect, it } from "vitest";
import { egressIn } from "../tools/egress.mjs";

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
