import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { actorOfResolvedSession } from "../src/core/db/actor.js";
import type { Driver } from "../src/core/db/driver.js";
import { DEFAULT_SESSION_CONFIG, sessionSettingsOf } from "../src/core/session/config.js";
import type { SessionResolution, SessionServiceOptions } from "../src/core/session/service.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const SESSION_DIRECTORY = `${repositoryRoot}src/core/session/`;
const CORE = `${repositoryRoot}src/core/`;

function coreFiles(): string[] {
	return readdirSync(CORE, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => `${entry.parentPath}/${entry.name}`);
}

function sessionFiles(): string[] {
	return readdirSync(SESSION_DIRECTORY)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => `${SESSION_DIRECTORY}${name}`);
}

describe("E-93, S-OWNER-7: the brand on a resolved session", () => {
	it("refuses a hand-built object at the type level", () => {
		const fromRequest = { userId: "00000000-0000-4000-8000-0000000000ff" };

		// @ts-expect-error S-OWNER-7: only session resolution produces a ResolvedSession.
		const minted = actorOfResolvedSession(fromRequest);

		expect(minted).toBe(fromRequest.userId);
	});

	it("refuses a hand-built resolution where a SessionResolution is expected", () => {
		// @ts-expect-error S-OWNER-7: a plain object carries neither brand.
		const forged: SessionResolution = { userId: "u", session: undefined };

		expect(forged.userId).toBe("u");
	});

	it("is asserted in exactly one place in the library", () => {
		const asserting = coreFiles()
			.filter((path) =>
				/\bas (ResolvedSession|SessionResolution)\b/.test(readFileSync(path, "utf8")),
			)
			.map((path) => path.replace(CORE, ""));

		expect(coreFiles().length).toBeGreaterThan(20);
		expect(asserting).toEqual(["session/service.ts"]);
	});

	it("is asserted only by session resolution, not by any other function in that file", () => {
		const service = readFileSync(`${SESSION_DIRECTORY}service.ts`, "utf8");
		const producers = [...service.matchAll(/as SessionResolution/g)];
		const callers = [...service.matchAll(/\bresolutionOf\(/g)];

		expect(producers).toHaveLength(1);
		expect(service).toMatch(/function resolutionOf\([\s\S]*?as SessionResolution;\n}/);
		expect(callers).toHaveLength(3);
		expect(service.slice(service.indexOf("async function resolveAndExtend"))).toContain(
			"resolutionOf(",
		);
	});

	it("has no second minting function anywhere in the core", () => {
		const minting = coreFiles()
			.filter((path) => /\bas Actor\b/.test(readFileSync(path, "utf8")))
			.map((path) => path.replace(CORE, ""));

		expect(minting).toEqual(["db/actor.ts"]);
	});

	it("cannot be produced from a string by any exported name in the session module", () => {
		const forbidden = sessionFiles().filter((path) =>
			/export function actorOf|export const actorOf/.test(readFileSync(path, "utf8")),
		);

		expect(forbidden).toEqual([]);
	});
});

describe("S-FIX-6, S-DEFAULT-2: revoking the other sessions is not a switch", () => {
	it("offers no configuration key that could turn it off", () => {
		const keys = [
			...Object.keys(DEFAULT_SESSION_CONFIG),
			...Object.keys(sessionSettingsOf()),
			"driver",
			"schema",
			"session",
			"sessionMetadata",
			"clock",
		];

		expect(
			keys.filter((key) => /revoke|keep|preserve|retain|other|skip|disable/i.test(key)),
		).toEqual([]);
	});

	it("accepts no such key on the service options at the type level", () => {
		const driver: Driver = {
			query: async () => [],
			transaction: (fn) => fn(driver),
		};

		const options: SessionServiceOptions = {
			driver,
			clock: { now: () => new Date() },
			// @ts-expect-error S-FIX-6: there is no option that keeps the other sessions.
			revokeOtherSessions: false,
		};

		expect(options.driver).toBe(driver);
	});

	it("names no such option anywhere in the session module or its repository", () => {
		const naming = [...sessionFiles(), `${repositoryRoot}src/core/db/repositories/session.ts`]
			.filter((path) =>
				/revokeOther|keepOtherSessions|revokeSessionsOn|skipRevoke/i.test(
					readFileSync(path, "utf8"),
				),
			)
			.map((path) => path.replace(repositoryRoot, ""));

		expect(naming).toEqual([]);
	});
});

describe("code style the rules make a finding", () => {
	it("carries no any, no ts-ignore, no console and no default export", () => {
		const offenders: string[] = [];
		for (const path of [
			...sessionFiles(),
			`${repositoryRoot}src/core/db/repositories/session.ts`,
		]) {
			const text = readFileSync(path, "utf8");
			for (const pattern of [
				/(?<![A-Za-z0-9_$])any(?![A-Za-z0-9_$])/,
				/@ts-ignore/,
				/@ts-expect-error/,
				/console\./,
				/export default/,
			]) {
				if (pattern.test(text)) {
					offenders.push(`${path.replace(repositoryRoot, "")}: ${pattern.source}`);
				}
			}
		}

		expect(offenders).toEqual([]);
	});

	/**
	 * `knip` treats every test file as an entry point, so an export whose only caller is a test
	 * counts as used. This pins the exports the library itself never calls, so the list is a
	 * decision rather than an accident.
	 */
	it("has these exports and no others that no source file outside their own calls", () => {
		const sources = coreFiles().map((path) => [path, readFileSync(path, "utf8")] as const);
		const unused: string[] = [];

		for (const [path, text] of sources) {
			if (!path.startsWith(SESSION_DIRECTORY)) {
				continue;
			}
			for (const match of text.matchAll(/^export (?:function|const|class) ([A-Za-z_][\w$]*)/gm)) {
				const name = match[1] ?? "";
				const used = sources.some(
					([other, body]) => other !== path && new RegExp(`\\b${name}\\b`).test(body),
				);
				if (!used) {
					unused.push(`${path.replace(CORE, "")}: ${name}`);
				}
			}
		}

		expect(unused.sort()).toEqual([
			// The module's own factory; the feature that assembles the instance does not exist yet.
			"session/config.ts: DEFAULT_SESSION_CONFIG",
			"session/config.ts: InvalidSessionConfigError",
			"session/freshness.ts: isSessionFresh",
			"session/service.ts: createSessionService",
		]);
	});
});

describe("DOCUMENTATION.md covers every method the session service offers", () => {
	it("names each one", () => {
		const documentation = readFileSync(`${repositoryRoot}DOCUMENTATION.md`, "utf8");
		const service = readFileSync(`${SESSION_DIRECTORY}service.ts`, "utf8");
		const declaration = /export interface SessionService \{([\s\S]*?)\n\}/.exec(service)?.[1] ?? "";
		const methods = [...declaration.matchAll(/^\t([a-z][\w]*)[(:]/gm)]
			.map((match) => match[1] ?? "")
			.filter((name) => name !== "settings");

		expect(methods.length).toBeGreaterThan(8);
		expect(methods.filter((name) => !documentation.includes(`\`${name}(`))).toEqual([]);
	});
});
