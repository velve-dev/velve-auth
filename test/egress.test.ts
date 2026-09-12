import { describe, expect, it } from "vitest";
import { egressIn, scanEgress } from "../tools/egress.mjs";

const ELSEWHERE = "src/core/auth/instance.ts";

/**
 * `README.md`'s first promise is that the only traffic leaving an operator's infrastructure goes
 * to the OAuth providers they chose to enable, and that enabling none sends none. It was a
 * sentence and nothing enforced it; a telemetry call added later is one line in a diff (E-1844).
 */
describe("nothing leaves the operator's infrastructure (E-1844)", () => {
	it("passes the shipped tree, where one seam calls out and nothing else does", () => {
		const { offenders, filesScanned, callsScanned } = scanEgress();

		expect(offenders).toStrictEqual([]);
		expect(filesScanned).toBeGreaterThan(100);
		expect(callsScanned).toBeGreaterThan(0);
	});

	it.each([
		['await fetch("https://telemetry.example-vendor.io/e");', "fetch"],
		['navigator.sendBeacon("https://metrics.acme-analytics.com/x");', "navigator.sendBeacon"],
		['const ws = new WebSocket("wss://live.exfil-host.org/s");', "new WebSocket"],
		[
			'new XMLHttpRequest().open("POST", "https://collector.somewhere-else.net/i");',
			"XMLHttpRequest",
		],
	])("refuses %s", (planted, named) => {
		expect(egressIn(ELSEWHERE, planted).join(" ")).toContain(`reaches the network with ${named}`);
	});

	/** A host written down with no call beside it is the shape a later commit turns into one. */
	it("refuses a bare external host even where nothing calls it", () => {
		const planted = 'const ANALYTICS = "https://stats.someone-else.net/collect";';

		expect(egressIn(ELSEWHERE, planted)).toStrictEqual([
			`${ELSEWHERE}: names the external host https://stats.someone-else.net`,
		]);
	});

	it("permits the seam itself, which is where the provider request belongs", () => {
		const call = 'await fetchImplementation(request.url, { method: "POST" });';

		expect(egressIn("src/core/oauth/outbound.ts", `await fetch(x);${call}`)).toStrictEqual([]);
	});

	/**
	 * Three shapes that read like destinations and are not: a provisioning URI handed to an
	 * authenticator, the single-label base `new URL(path, base)` normalises against, and loopback.
	 */
	it.each([
		"const uri = `otpauth://totp/${label}`;",
		'const PATH_NORMALISATION_PROBE = "https://velve-auth";',
		'const local = "http://127.0.0.1:5432";',
	])("does not read %s as a destination", (written) => {
		expect(egressIn(ELSEWHERE, written)).toStrictEqual([]);
	});

	it("reads neither a comment nor the providers file as a finding", () => {
		expect(egressIn(ELSEWHERE, "// we never call https://example-vendor.io here")).toStrictEqual(
			[],
		);
		expect(
			egressIn("src/core/oauth/providers.ts", 'const github = "https://github.com/login";'),
		).toStrictEqual([]);
	});
});
