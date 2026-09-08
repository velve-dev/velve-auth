import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/core/db/migration-runner.js";
import { coreMigrations } from "../src/core/db/migrations/index.js";
import {
	DEFAULT_USERNAME_RULES,
	resolveIdentityConfiguration,
	type UsernameRules,
} from "../src/core/identity/configuration.js";
import { normaliseEmail, normaliseUsername } from "../src/core/identity/normalise.js";
import {
	openTestConnection,
	PostgresServerError,
	type TestConnection,
} from "./db-postgres-connection.js";

const schema = `velve_identity_folds_${randomBytes(4).toString("hex")}`;
const LAST_CODE_POINT = 0x10ffff;
const FIRST_SURROGATE = 0xd800;
const LAST_SURROGATE = 0xdfff;
const UNUSABLE_IN_A_LINE = /[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}]/u;
const CHECK_VIOLATION = "23514";

let connection: TestConnection;

beforeAll(async () => {
	connection = await openTestConnection();
	await runMigrations({ driver: connection, schema, migrations: coreMigrations("username_email") });
});

afterAll(async () => {
	await connection.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`, []);
	await connection.close();
});

function foldedCharacters(): string[] {
	const folded = new Set<string>();
	for (const point of everyCodePoint()) {
		const character = String.fromCodePoint(point);
		const compatibility = character.normalize("NFKC");
		if (compatibility === character && compatibility.toLowerCase() === compatibility) {
			continue;
		}
		const form = compatibility.toLowerCase();
		if (form !== "" && !UNUSABLE_IN_A_LINE.test(form)) {
			folded.add(form);
		}
	}
	return [...folded];
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

function usernameKeyIsStable(point: number, rules: UsernameRules): boolean {
	const normalised = normaliseUsername(String.fromCodePoint(point).repeat(3), rules);
	if (!normalised.accepted) {
		return true;
	}
	const again = normaliseUsername(normalised.value.usernameKey, rules);
	return again.accepted && again.value.usernameKey === normalised.value.usernameKey;
}

function unstableUsernameKeys(rules: UsernameRules): string[] {
	return everyCodePoint()
		.filter((point) => !usernameKeyIsStable(point, rules))
		.map((point) => `U+${point.toString(16).toUpperCase()}`);
}

function emailIsStable(point: number): boolean {
	const normalised = normaliseEmail(`${String.fromCodePoint(point)}@example.test`);
	if (!normalised.accepted) {
		return true;
	}
	const again = normaliseEmail(normalised.value);
	return again.accepted && again.value === normalised.value;
}

async function formsPostgresWouldFoldFurther(forms: readonly string[]): Promise<string[]> {
	const rows = await connection.query<{ readonly form: string }>(
		`SELECT form FROM string_to_table($1::text, chr(10)) AS form
		 WHERE form IS DISTINCT FROM lower(form)`,
		[forms.join("\n")],
	);
	return rows.map((row) => row.form);
}

describe("the JavaScript fold and lower() in PostgreSQL", () => {
	const forms = foldedCharacters();

	it("has a corpus wide enough to be worth running", () => {
		expect(forms.length).toBeGreaterThan(3500);
	});

	it("catches a form PostgreSQL folds further, so a clean run means something", async () => {
		expect(await formsPostgresWouldFoldFurther(["Alice", "alice"])).toEqual(["Alice"]);
	});

	it("agrees on every compatibility or cased character in Unicode", async () => {
		expect(await formsPostgresWouldFoldFurther(forms)).toEqual([]);
	});

	it("agrees on the whole-string cases where JavaScript folds by context", async () => {
		const contextual = ["ΟΔΟΣ", "ΑΣ", "ΣΣ", "İSTANBUL", "STRAẞE", "ǄUNGLA", "ẞ"].map((entered) =>
			entered.normalize("NFKC").toLowerCase(),
		);
		expect(await formsPostgresWouldFoldFurther(contextual)).toEqual([]);
	});
});

const EVERYTHING_ALLOWED = resolveIdentityConfiguration({
	mode: "username",
	username: { allowedCharacters: /^[\s\S]+$/u, minimumLength: 1, maximumLength: 64 },
}).username;

const BATCH = 20_000;

async function foldedFurtherInBatches(forms: readonly string[]): Promise<string[]> {
	const found: string[] = [];
	for (let start = 0; start < forms.length; start += BATCH) {
		found.push(...(await formsPostgresWouldFoldFurther(forms.slice(start, start + BATCH))));
	}
	return found;
}

function describeCodePoints(value: string): string {
	return [...value]
		.map((character) => `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}`)
		.join(" ");
}

describe("the comparison form the shipped normalisers actually produce", () => {
	it("does not lowercase the whole string, so Final_Sigma never reaches the key", () => {
		const entered = "abcΟΔΟΣ";
		const name = normaliseUsername(entered, EVERYTHING_ALLOWED);
		expect(name.accepted).toBe(true);
		const key = name.accepted ? name.value.usernameKey : "";
		expect(describeCodePoints(key.slice(-1))).toBe("U+3C3");
		expect(describeCodePoints(entered.toLowerCase().slice(-1))).toBe("U+3C2");
	});

	it("folds an address the same way, which is where the same defect sat", () => {
		const address = normaliseEmail("abcΟΔΟΣ@example.test");
		expect(address.accepted).toBe(true);
		expect(address.accepted ? address.value : "").toBe("abcοδοσ@example.test");
	});

	it("disagrees with lower() on exactly one code point in the whole of Unicode", async () => {
		const seen = new Set<string>();
		const keys: string[] = [];
		const origin = new Map<string, number>();
		for (const point of everyCodePoint()) {
			const name = normaliseUsername(String.fromCodePoint(point).repeat(3), EVERYTHING_ALLOWED);
			if (!name.accepted) {
				continue;
			}
			const key = name.value.usernameKey;
			if (UNUSABLE_IN_A_LINE.test(key) || seen.has(key)) {
				continue;
			}
			seen.add(key);
			origin.set(key, point);
			keys.push(key);
		}
		expect(keys.length).toBeGreaterThan(1_000_000);
		const disagreeing = await foldedFurtherInBatches(keys);
		expect(
			disagreeing.map((key) => `U+${(origin.get(key) ?? 0).toString(16).toUpperCase()}`),
		).toEqual(["U+38D"]);
	}, 120_000);

	it("carries that one disagreement into addresses as well", async () => {
		const addresses: string[] = [];
		for (const point of everyCodePoint()) {
			const address = normaliseEmail(`${String.fromCodePoint(point)}@example.test`);
			if (address.accepted) {
				addresses.push(address.value);
			}
		}
		expect(await foldedFurtherInBatches(addresses)).toEqual(["΍@example.test"]);
	}, 120_000);

	/**
	 * The reference says the schema CHECK "is not a safety net" and that "there is no input for
	 * which it fires". It fires for exactly this one, which is also the one fold disagreement.
	 */
	it("hands the schema CHECK the one row it can refuse", async () => {
		const refusal = await connection
			.query(`INSERT INTO ${schema}.user (email, username, username_key) VALUES ($1, $2, $2)`, [
				`${randomBytes(6).toString("hex")}@example.test`,
				"΍΍΍",
			])
			.then(
				() => "accepted",
				(cause: unknown) => (cause instanceof PostgresServerError ? cause.sqlState : "unexpected"),
			);
		expect(refusal).toBe(CHECK_VIOLATION);
	});
});

describe("what the normalisers hand to the database", () => {
	it("produces an address the user_email_normalized CHECK accepts", async () => {
		const refused: string[] = [];
		for (const entered of [
			"Alice@Example.COM",
			"ＡＬＩＣＥ＠a.test",
			"İstanbul@example.test",
			"STRAẞE@example.test",
			"ΟΔΟΣ@example.test",
			"Ǆ@example.test",
			"ⓐⓛⓘⓒⓔ@example.test",
			"\u{1d400}@example.test",
			"Ⅷ@example.test",
			"ﬁ@example.test",
		]) {
			const normalised = normaliseEmail(entered);
			expect([entered, normalised.accepted]).toEqual([entered, true]);
			if (!normalised.accepted) {
				continue;
			}
			try {
				await connection.query(
					`INSERT INTO ${schema}.user (email, username, username_key) VALUES ($1, $2, $2)`,
					[`${randomBytes(6).toString("hex")}+${normalised.value}`, randomBytes(8).toString("hex")],
				);
			} catch (cause) {
				refused.push(`${entered}: ${cause instanceof Error ? cause.message : String(cause)}`);
			}
		}
		expect(refused).toEqual([]);
	});

	it("produces an address that is already its own normal form", () => {
		expect(
			everyCodePoint()
				.filter((point) => !emailIsStable(point))
				.map((point) => `U+${point.toString(16).toUpperCase()}`),
		).toEqual([]);
	});

	it("produces a username key that is already its own normal form", () => {
		const widened = resolveIdentityConfiguration({
			mode: "username",
			username: { allowedCharacters: /^[\p{L}\p{N}\p{M}_-]+$/u, minimumLength: 1 },
		}).username;
		expect(unstableUsernameKeys(DEFAULT_USERNAME_RULES)).toEqual([]);
		expect(unstableUsernameKeys(widened)).toEqual([]);
	});
});
