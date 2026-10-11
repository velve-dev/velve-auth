import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

//the release notes, the readme and both specifications must say what the code ships (S-INTEG-5)

function read(path: string): string {
	return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const notes = read("docs/releases/2.0.0.md");
const readme = read("README.md");
const startup = read("src/core/auth/startup.ts");
const errorMap = read("src/core/http/error-map.ts");

function startupCodes(): string[] {
	const union = startup.slice(
		startup.indexOf("type StartupErrorCode"),
		startup.indexOf(";", startup.indexOf("type StartupErrorCode")),
	);
	return [...union.matchAll(/"([a-z_]+)"/g)].map((match) => match[1] ?? "");
}

describe("the 2.0.0 release notes against StartupErrorCode", () => {
	it("names every start code this release adds, security_state_sealing_unknown included", () => {
		expect(startupCodes()).toContain("security_state_sealing_unknown");
		expect(notes).toContain("security_state_sealing_unknown");
		expect(readme).toContain("security_state_sealing_unknown");
	});

	it("does not count five new members when the security state adds three more", () => {
		expect(notes).not.toContain("`StartupErrorCode` gains five members");
		expect(notes).not.toContain("### Five new `VelveStartupError` codes");
	});
});

describe("the readme against the maintenance step", () => {
	it("does not say sealSecurityState refuses with security_state_envelope_unreadable, which only the reseal throws", () => {
		expect(readme).not.toMatch(
			/maintenance step can refuse with\s*>?\s*`security_state_envelope_unreadable`/,
		);
	});
});

describe("F.1 lists every inner cause the error map merges, in both languages", () => {
	const inner = [...errorMap.matchAll(/^\t(broken_state_on_[a-z_]+):/gm)].map(
		(match) => match[1] ?? "",
	);

	it.each(["VELVE-AUTH-ARCHITEKTUR.md", "VELVE-AUTH-ARCHITECTURE.md"])("%s", (file) => {
		const text = read(file);
		const start = text.search(/##### F\.1 /);
		const table = text.slice(start, text.indexOf("\n---", start));
		expect(inner.length).toBe(9);
		expect(inner.filter((code) => !table.includes(code))).toStrictEqual([]);
	});
});

describe("the maintenance refusal can be caught by class", () => {
	it("exports SecurityStateMaintenanceError as a value, as VelveStartupError is", () => {
		expect(typeof (api as Record<string, unknown>).VelveStartupError).toBe("function");
		expect(typeof (api as Record<string, unknown>).SecurityStateMaintenanceError).toBe("function");
	});
});
