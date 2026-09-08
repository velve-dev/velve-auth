import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import {
	DEFAULT_USERNAME_RULES,
	resolveIdentityConfiguration,
} from "../src/core/identity/configuration.js";
import { normaliseUsername } from "../src/core/identity/normalise.js";
import {
	openTestConnection,
	PostgresServerError,
	type TestConnection,
} from "./db-postgres-connection.js";

const schema = `velve_identity_allowlist_${randomBytes(4).toString("hex")}`;
const UNIQUE_VIOLATION = "23505";
const PLAIN_ASCII_NAME = /^[A-Za-z0-9_-]+$/;
const LAST_CODE_POINT = 0x10ffff;
const FIRST_SURROGATE = 0xd800;
const LAST_SURROGATE = 0xdfff;

let connection: TestConnection;

beforeAll(async () => {
	connection = await openTestConnection();
	await runMigrations({ driver: connection, schema, migrations: coreMigrations("username") });
});

afterAll(async () => {
	await connection.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
	await connection.close();
});

function acceptedName(candidate: string): { display: string; key: string } | null {
	const outcome = normaliseUsername(candidate, DEFAULT_USERNAME_RULES);
	return outcome.accepted
		? { display: outcome.value.username, key: outcome.value.usernameKey }
		: null;
}

const WIDENED_RULES = resolveIdentityConfiguration({
	mode: "username",
	username: { allowedCharacters: /^[\p{L}\p{N}_-]+$/u },
}).username;

const ALPHABET_A = "a".codePointAt(0) ?? 0;
const ALPHABET_UPPER_A = "A".codePointAt(0) ?? 0;

function spelledFrom(capitalBase: number, smallBase: number): string {
	return [..."Alice"]
		.map((letter) => {
			const point = letter.codePointAt(0) ?? 0;
			return letter === letter.toUpperCase()
				? String.fromCodePoint(capitalBase + point - ALPHABET_UPPER_A)
				: String.fromCodePoint(smallBase + point - ALPHABET_A);
		})
		.join("");
}

function everyCodePoint(): number[] {
	const points: number[] = [];
	for (let point = 1; point <= LAST_CODE_POINT; point += 1) {
		if (point < FIRST_SURROGATE || point > LAST_SURROGATE) {
			points.push(point);
		}
	}
	return points;
}

async function insertName(display: string, key: string): Promise<string | null> {
	try {
		await connection.query(`INSERT INTO ${schema}.user (username, username_key) VALUES ($1, $2)`, [
			display,
			key,
		]);
		return null;
	} catch (cause) {
		return cause instanceof PostgresServerError ? cause.sqlState : "unexpected";
	}
}

describe("the default allowlist admits nothing but ASCII", () => {
	it("accepts 1294 code points and gives every one of them an ASCII display form", () => {
		const accepted: number[] = [];
		const nonAscii: string[] = [];
		for (const point of everyCodePoint()) {
			const character = String.fromCodePoint(point);
			const name = acceptedName(character.repeat(3));
			if (name === null) {
				continue;
			}
			accepted.push(point);
			if (!PLAIN_ASCII_NAME.test(name.display)) {
				nonAscii.push(`U+${point.toString(16).toUpperCase()} displays as ${name.display}`);
			}
		}
		expect(nonAscii).toEqual([]);
		expect(accepted.length).toBeGreaterThan(0);
	});

	it("keeps every accepted comparison form equal to its own ASCII lowercase", () => {
		const wrong: string[] = [];
		for (const point of everyCodePoint()) {
			const name = acceptedName(String.fromCodePoint(point).repeat(3));
			if (name !== null && name.key !== name.display.toLowerCase()) {
				wrong.push(`U+${point.toString(16).toUpperCase()}`);
			}
		}
		expect(wrong).toEqual([]);
	});

	it("refuses every confusable, invisible and directional spelling in the corpus", () => {
		const corpus: Record<string, string> = {
			"cyrillic a": "аlice",
			"cyrillic e": "alicе",
			"cyrillic o": "bоb",
			"cyrillic p": "рeter",
			"cyrillic c": "сarol",
			"cyrillic x": "maх",
			"greek omicron": "bοb",
			"greek alpha": "αlice",
			"greek nu": "νictor",
			"greek capital sigma": "Σigma",
			"armenian o": "bօb",
			cherokee: "Ꭰlice",
			"canadian syllabics": "ᑫlice",
			"zero-width joiner": "ali‍ce",
			"zero-width non-joiner": "ali‌ce",
			"zero-width space": "ali​ce",
			"word joiner": "ali⁠ce",
			"soft hyphen": "ali­ce",
			"byte order mark inside": "ali﻿ce",
			"right-to-left override": "‮alice",
			"left-to-right override": "‭alice",
			"pop directional": "alice‬",
			"arabic letter mark": "alice؜",
			"combining acute": "aliće",
			"combining dot above": "alicė",
			"combining grapheme joiner": "ali͏ce",
			"variation selector": "alice︀",
			"tag latin a": "alice\u{e0061}",
			"dotless i": "alıce",
			"dotted capital i": "İstanbul",
			"sharp s": "straße",
			"capital sharp s": "straẞe",
			"latin epsilon": "bɛta",
			"turned a": "ɐlice",
			"greek question mark": "alice;",
			"fullwidth at": "alice＠host",
			"ideographic space": "ali　ce",
			"non-breaking space inside": "ali ce",
			"line separator": "ali ce",
			"full stop": "ali.ce",
			"at sign": "alice@example.test",
			plus: "alice+one",
		};
		const admitted = Object.entries(corpus).filter(([, candidate]) => {
			const name = acceptedName(candidate);
			return name !== null && name.key !== "alice";
		});
		expect(admitted.map(([label]) => label)).toEqual([]);
	});

	it("folds the compatibility spellings that do fold onto plain ASCII", () => {
		const foldsToAlice: Record<string, string> = {
			fullwidth: "ＡＬＩＣＥ",
			"mathematical bold": spelledFrom(0x1d400, 0x1d41a),
			"mathematical monospace": spelledFrom(0x1d670, 0x1d68a),
			"mathematical sans-serif": spelledFrom(0x1d5a0, 0x1d5ba),
			"circled letters": spelledFrom(0x24b6, 0x24d0),
			"squared latin": spelledFrom(0x1f130, 0x1f130),
		};
		for (const [label, candidate] of Object.entries(foldsToAlice)) {
			const name = acceptedName(candidate);
			expect([label, name?.key]).toEqual([label, "alice"]);
			expect([label, PLAIN_ASCII_NAME.test(name?.display ?? "")]).toEqual([label, true]);
		}
	});

	it("counts code points after the compatibility expansion, so a short spelling cannot be short", () => {
		const romanEight = acceptedName("Ⅷ");
		expect(romanEight).toEqual({ display: "VIII", key: "viii" });
		expect(acceptedName("Ⅰ")).toBeNull();
	});
});

describe("two accounts cannot share one comparison form", () => {
	it("refuses the second insert for every spelling that folds onto the same key", async () => {
		const suffix = randomBytes(4).toString("hex");
		const first = acceptedName(`alice${suffix}`);
		expect(first).not.toBeNull();
		expect(await insertName(first?.display ?? "", first?.key ?? "")).toBeNull();

		const rivals = [
			`ALICE${suffix.toUpperCase()}`,
			`ＡＬＩＣＥ${suffix}`,
			`${spelledFrom(0x1d400, 0x1d41a)}${suffix}`,
			`${spelledFrom(0x24b6, 0x24d0)}${suffix}`,
		];
		const outcomes: string[] = [];
		for (const rival of rivals) {
			const name = acceptedName(rival);
			expect([rival, name?.key]).toEqual([rival, `alice${suffix}`]);
			outcomes.push((await insertName(name?.display ?? "", name?.key ?? "")) ?? "accepted");
		}
		expect(outcomes).toEqual(rivals.map(() => UNIQUE_VIOLATION));
	});

	it("stores no name the widened allowlist would let disagree with the database", async () => {
		const refused: string[] = [];
		let stored = 0;
		for (const candidate of ["Grüße", "İstanbul", "ΟΔΟΣ", "Straẞe", "Ǆungla", "ᾈθηνα"]) {
			const normalised = normaliseUsername(
				`${candidate}${randomBytes(4).toString("hex")}`,
				WIDENED_RULES,
			);
			if (!normalised.accepted) {
				continue;
			}
			stored += 1;
			const failure = await insertName(normalised.value.username, normalised.value.usernameKey);
			if (failure !== null) {
				refused.push(`${candidate} was refused with SQLSTATE ${failure}`);
			}
		}
		expect(stored).toBeGreaterThan(3);
		expect(refused).toEqual([]);
	});

	/**
	 * DOCUMENTATION.md promises that where the JavaScript fold and `lower()` disagree "the insert
	 * fails with a constraint violation rather than storing a wrong value". Greek final sigma is
	 * such a disagreement, and the insert succeeds.
	 */
	it("refuses the insert wherever JavaScript and PostgreSQL fold a name differently", async () => {
		const suffix = randomBytes(4).toString("hex");
		const entered = `ΟΔΟΣ${suffix}`;
		const [folds] = await connection.query<{
			readonly by_postgres: string;
		}>(`SELECT lower($1::text) AS by_postgres`, [entered]);
		const byJavaScript = normaliseUsername(entered, WIDENED_RULES);
		expect(byJavaScript.accepted).toBe(true);
		const jsKey = byJavaScript.accepted ? byJavaScript.value.usernameKey : "";
		expect(folds?.by_postgres).not.toBe(jsKey);

		expect(await insertName(entered, folds?.by_postgres ?? "")).toBeNull();
		expect(await insertName(entered, jsKey)).toBe(UNIQUE_VIOLATION);
	});
});
