import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { equalsInConstantTime, KEY_PURPOSES } from "../src/core/keys/index.js";

const coreDirectory = fileURLToPath(new URL("../src/core", import.meta.url));
const keysDirectory = `${coreDirectory}/keys`;

function sourceFilesUnder(directory: string): readonly string[] {
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => `${entry.parentPath}/${entry.name}`)
		.sort();
}

const coreSources = sourceFilesUnder(coreDirectory).map((path) => ({
	path,
	text: readFileSync(path, "utf8"),
}));

const keysSources = coreSources.filter((source) => source.path.startsWith(keysDirectory));

function filesMatching(pattern: RegExp): readonly string[] {
	return coreSources.filter((source) => pattern.test(source.text)).map((source) => source.path);
}

describe("the core takes no key from the environment (section 2.6)", () => {
	it("never reads process.env", () => {
		expect(filesMatching(/process\s*\.\s*env|process\s*\[/)).toStrictEqual([]);
	});

	it("never touches `process` at all", () => {
		expect(filesMatching(/\bprocess\b/)).toStrictEqual([]);
	});

	it("has more than nothing to scan", () => {
		expect(keysSources.length).toBeGreaterThanOrEqual(11);
	});
});

describe("the core imports no Node built-in (section 2.6, repository rules section 7)", () => {
	it.each(["node:crypto", "node:fs", "node:wasi", "node:worker_threads", "node:child_process"])(
		"never imports %s",
		(builtin) => {
			expect(filesMatching(new RegExp(builtin.replaceAll(":", "\\:")))).toStrictEqual([]);
		},
	);

	it("imports nothing from the `node:` namespace", () => {
		expect(filesMatching(/["']node:/)).toStrictEqual([]);
	});

	it("uses no CommonJS require and no Buffer", () => {
		expect(filesMatching(/\brequire\s*\(|\bBuffer\b|\b__dirname\b/)).toStrictEqual([]);
	});
});

describe("secrets come from one place (S-RAND-1, S-RAND-5)", () => {
	it("calls crypto.getRandomValues in exactly one module", () => {
		expect(filesMatching(/getRandomValues/)).toStrictEqual([`${keysDirectory}/random.ts`]);
	});

	it("never derives a secret from Math.random or a clock", () => {
		expect(filesMatching(/Math\s*\.\s*random|Date\s*\.\s*now|new Date\(/)).toStrictEqual([]);
	});
});

describe("the code style rules of repository rules section 3", () => {
	it("uses no `any`", () => {
		expect(filesMatching(/(?::\s*|<|\|\s*|&\s*|\bas\s+)any(?![A-Za-z0-9_$])/)).toStrictEqual([]);
	});

	it("suppresses no type error", () => {
		expect(filesMatching(/@ts-ignore|@ts-expect-error|@ts-nocheck/)).toStrictEqual([]);
	});

	it("logs nothing", () => {
		expect(filesMatching(/console\s*\./)).toStrictEqual([]);
	});

	it("has no default export", () => {
		expect(filesMatching(/export\s+default/)).toStrictEqual([]);
	});

	it("leaves no marker of unfinished work", () => {
		expect(filesMatching(/\bTODO\b|\bFIXME\b|\bXXX\b/)).toStrictEqual([]);
	});
});

// S-KEY-2 relies on Web Crypto refusing the wrong key type, which only holds while the two
// signing purposes are imported as HMAC keys and the four encryption purposes as AES-GCM keys.
describe("the purpose set is closed and split the way section 3.8 splits it", () => {
	const purposeSource = readFileSync(`${keysDirectory}/purpose.ts`, "utf8");
	const providerSource = readFileSync(`${keysDirectory}/root-key-provider.ts`, "utf8");

	it("declares the six purposes as a frozen tuple", () => {
		expect(purposeSource).toContain("as const");
		expect([...purposeSource.matchAll(/"([a-z-]+)"/g)].map((match) => match[1])).toStrictEqual([
			"cookie-sig",
			"token-pepper",
			"totp-enc",
			"oauth-token-enc",
			"pkce-enc",
			"password-enc",
		]);
	});

	it("derives the purpose type from the tuple instead of restating it", () => {
		expect(purposeSource).toMatch(/typeof KEY_PURPOSES\)\[number\]/);
	});

	it("splits the six names the way the type splits them, by the -enc suffix", () => {
		expect(KEY_PURPOSES.filter((purpose) => purpose.endsWith("-enc"))).toStrictEqual([
			"totp-enc",
			"oauth-token-enc",
			"pkce-enc",
			"password-enc",
		]);
		expect(KEY_PURPOSES.filter((purpose) => !purpose.endsWith("-enc"))).toStrictEqual([
			"cookie-sig",
			"token-pepper",
		]);
	});

	it("answers whether a purpose encrypts in exactly one place", () => {
		expect(filesMatching(/function isEncryptionPurpose/)).toStrictEqual([
			`${keysDirectory}/purpose.ts`,
		]);
	});

	it("has the key ring and the envelope ask that one place", () => {
		expect(filesMatching(/isEncryptionPurpose\(/)).toStrictEqual([
			`${keysDirectory}/envelope.ts`,
			`${keysDirectory}/purpose.ts`,
			`${keysDirectory}/root-key-provider.ts`,
		]);
		expect(providerSource).not.toMatch(/"(totp|oauth-token|pkce|password)-enc"/);
	});
});

// The comparison has to be constant in structure, not merely in intent: no early exit inside the
// loop, and no branch on the contents after the length has been checked.
describe("the constant-time comparison is constant in structure (section 2.7)", () => {
	const source = readFileSync(`${keysDirectory}/constant-time.ts`, "utf8");
	const loopBody = source.slice(source.indexOf("for ("), source.lastIndexOf("return"));

	it("checks the length exactly once, before the loop", () => {
		expect(source.slice(0, source.indexOf("for (")).match(/\.length/g)).toHaveLength(2);
	});

	it("leaves the loop by no other route than running out of bytes", () => {
		expect(loopBody).not.toMatch(/\breturn\b|\bbreak\b|\bcontinue\b|\bthrow\b/);
	});

	it("branches on nothing inside the loop", () => {
		// `?? 0` is the guard `noUncheckedIndexedAccess` demands for an in-bounds read; its outcome
		// is the same on every iteration and for every input, so it is not a branch on the bytes.
		expect(loopBody.replaceAll("?? 0", "")).not.toMatch(/\bif\b|\?|&&|\|\|/);
	});

	it("accumulates with a bitwise or over a bitwise exclusive or", () => {
		expect(loopBody).toMatch(/\|=/);
		expect(loopBody).toMatch(/\^/);
	});
});

// The structural scan says the loop has no exit; this counts the reads to show it, because a
// comparison that stops at the first differing byte tells the caller where the difference is.
describe("the constant-time comparison reads every byte (section 2.7)", () => {
	function countingView(bytes: Uint8Array<ArrayBuffer>): {
		view: Uint8Array<ArrayBuffer>;
		reads: () => number;
	} {
		let reads = 0;
		const view = new Proxy(bytes, {
			get(target, property) {
				if (typeof property === "string" && /^\d+$/.test(property)) {
					reads += 1;
				}
				return Reflect.get(target, property, target);
			},
		});

		return { view, reads: () => reads };
	}

	function readsWhenComparing(left: Uint8Array<ArrayBuffer>, right: Uint8Array<ArrayBuffer>) {
		const counted = countingView(left);
		const equal = equalsInConstantTime(counted.view, right);
		return { equal, reads: counted.reads() };
	}

	const length = 64;
	const base = new Uint8Array(length).fill(0xa5);

	it("reads the same number of bytes whether the first byte differs or none does", () => {
		const differsFirst = Uint8Array.from(base);
		differsFirst[0] = 0x00;

		const identical = readsWhenComparing(base, Uint8Array.from(base));
		const early = readsWhenComparing(base, differsFirst);

		expect(identical.equal).toBe(true);
		expect(early.equal).toBe(false);
		expect(identical.reads).toBe(length);
		expect(early.reads).toBe(length);
	});

	it("reads the same number of bytes wherever the difference sits", () => {
		const counts = new Set<number>();

		for (let index = 0; index < length; index += 1) {
			const differing = Uint8Array.from(base);
			differing[index] = 0x5a;
			const { equal, reads } = readsWhenComparing(base, differing);

			expect(equal).toBe(false);
			counts.add(reads);
		}

		expect(counts).toStrictEqual(new Set([length]));
	});
});
