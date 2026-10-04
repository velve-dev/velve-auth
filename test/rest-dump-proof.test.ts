import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecoveryCodeSet, normaliseRecoveryCode } from "../src/core/factor/recovery/code.js";
import { decodeBase64Url } from "../src/core/keys/base64url.js";
import { type DrivenUser, driveOneUserThroughEveryFlow, type Secret } from "./rest-fixtures.js";
import { secretBytesOfBase32 } from "./totp-fixtures.js";

let driven: DrivenUser;
let dump: string;

const TEST_DATABASE_URL =
	process.env.VELVE_TEST_DATABASE_URL ?? "postgres://velve:velve@localhost:5432/velve_test";

let instrument: string;

async function serverMajorVersion(): Promise<string> {
	const [row] = await driven.mounted.connection.query<{ major: string }>(
		"SELECT current_setting('server_version_num')::int / 10000 AS major",
		[],
	);
	return String(row?.major ?? "");
}

//the binary of the server's own major is tried too as an older pg_dump refuses a newer server
function pgDumpCandidates(major: string): readonly string[] {
	return [
		"pg_dump",
		`/opt/homebrew/opt/postgresql@${major}/bin/pg_dump`,
		`/usr/lib/postgresql/${major}/bin/pg_dump`,
	];
}

function pgDumpWith(binary: string, schema: string): string | null {
	try {
		return execFileSync(binary, ["--schema", schema, "--no-owner", TEST_DATABASE_URL], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
}

async function everyColumnAsText(schema: string): Promise<string> {
	const tables = await driven.mounted.connection.query<{ table_name: string }>(
		"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
		[schema],
	);
	const parts: string[] = [];
	for (const { table_name } of tables) {
		const rows = await driven.mounted.connection.query<{ rendered: string }>(
			`SELECT t::text AS rendered FROM ${schema}.${table_name} t`,
			[],
		);
		parts.push(`CREATE TABLE ${schema}.${table_name}`, ...rows.map((row) => row.rendered));
	}
	return parts.join("\n");
}

//the instrument S-REST-1 names, with the text fallback refused in CI (S-REST-1)
async function dumpOf(schema: string): Promise<{ text: string; how: string }> {
	for (const binary of pgDumpCandidates(await serverMajorVersion())) {
		const text = pgDumpWith(binary, schema);
		if (text !== null) {
			return { text, how: binary };
		}
	}
	if (process.env.CI !== undefined) {
		throw new Error("CI must take the dump with pg_dump and no usable binary answered");
	}
	return { text: await everyColumnAsText(schema), how: "every column as text" };
}

const PLANTED = `planted-${randomUUID()}`;
const PLANTED_CODE = createRecoveryCodeSet({ count: 1, groupSize: 5 })[0] ?? "";

//a second account carries known values as text and as bytes for the search to find in the same dump
async function plantAKnownValue(): Promise<void> {
	const schema = driven.mounted.schema;
	const [row] = await driven.mounted.connection.query<{ id: string }>(
		`INSERT INTO ${schema}.user (email) VALUES ($1) RETURNING id`,
		[`${PLANTED}@example.com`],
	);
	await driven.mounted.connection.query(
		`INSERT INTO ${schema}.webauthn_credential
		 (user_id, credential_id, public_key, backup_eligible, backup_state, user_verified_at_registration, label)
		 VALUES ($1, $2, $3, false, false, true, $4)`,
		[
			row?.id,
			Buffer.from(PLANTED, "utf8"),
			Buffer.from(`${PLANTED}-key`, "utf8"),
			normaliseRecoveryCode(PLANTED_CODE),
		],
	);
}

//one dump per file is enough and a database crowded with schemas makes each one slow
beforeAll(async () => {
	driven = await driveOneUserThroughEveryFlow("restdump");
	await plantAKnownValue();
	const taken = await dumpOf(driven.mounted.schema);
	dump = taken.text;
	instrument = taken.how;
	process.stderr.write(`rest-dump-proof took the dump with ${instrument}\n`);
}, 180_000);

afterAll(async () => {
	await driven.close();
});

//a base64url token and a TOTP secret stand for bytes that could sit in a bytea column as hex
function underlyingBytes(secret: Secret): Buffer | null {
	if (secret.name === "TOTP secret") {
		return Buffer.from(secretBytesOfBase32(secret.value));
	}
	const decoded = /^[A-Za-z0-9_-]{22,}$/.test(secret.value) ? decodeBase64Url(secret.value) : null;
	return decoded === null ? null : Buffer.from(decoded);
}

//a recovery code is also searched in the canonical form it is compared in
function textFormsOf(secret: Secret): readonly string[] {
	if (!secret.name.startsWith("recovery code")) {
		return [secret.value];
	}
	const canonical = normaliseRecoveryCode(secret.value);
	return canonical === secret.value ? [secret.value] : [secret.value, canonical];
}

function encodingsOf(secret: Secret): readonly string[] {
	const bytes = underlyingBytes(secret);
	return [
		...textFormsOf(secret).flatMap((form) => {
			const text = Buffer.from(form, "utf8");
			return [form, text.toString("base64"), text.toString("base64url"), text.toString("hex")];
		}),
		...(bytes === null ? [] : [bytes.toString("hex"), bytes.toString("base64")]),
	];
}

function hitsIn(text: string, secrets: readonly Secret[]): string[] {
	return secrets.flatMap((secret) =>
		encodingsOf(secret)
			.filter((encoded) => text.includes(encoded))
			.map((encoded) => `${secret.name} as ${encoded.slice(0, 12)}…`),
	);
}

describe("T-REST-1: a pg_dump of the schema holds no secret in any encoding (S-REST-1)", () => {
	it("dumps a schema that holds every artefact the flows leave behind", async () => {
		const counts = await driven.mounted.connection.query<Record<string, number>>(
			`SELECT
			   (SELECT count(*)::int FROM ${driven.mounted.schema}.password_credential) AS password,
			   (SELECT count(*)::int FROM ${driven.mounted.schema}.session) AS session,
			   (SELECT count(*)::int FROM ${driven.mounted.schema}.pending_authentication) AS pending,
			   (SELECT count(*)::int FROM ${driven.mounted.schema}.one_time_token) AS one_time,
			   (SELECT count(*)::int FROM ${driven.mounted.schema}.totp_credential) AS totp,
			   (SELECT count(*)::int FROM ${driven.mounted.schema}.recovery_code) AS recovery,
			   (SELECT count(*)::int FROM ${driven.mounted.schema}.webauthn_challenge) AS challenge,
			   (SELECT count(*)::int FROM ${driven.mounted.schema}.oauth_flow) AS flow,
			   (SELECT count(*)::int FROM ${driven.mounted.schema}.identity
			    WHERE access_token_enc IS NOT NULL AND refresh_token_enc IS NOT NULL) AS stored_tokens`,
			[],
		);

		expect(counts[0]).toStrictEqual({
			password: 1,
			session: 1,
			pending: 1,
			one_time: 4,
			totp: 1,
			recovery: 10,
			challenge: 1,
			flow: 1,
			stored_tokens: 1,
		});
		expect(dump).toContain(`CREATE TABLE ${driven.mounted.schema}.session`);
		expect(instrument).toMatch(
			process.env.CI === undefined ? /pg_dump$|^every column as text$/ : /pg_dump$/,
		);
	});

	it("searches twenty-four values in at least three encodings each and finds none", () => {
		const searches = driven.secrets.flatMap(encodingsOf);

		expect(driven.secrets).toHaveLength(24);
		expect(new Set(driven.secrets.map((secret) => secret.value)).size).toBe(24);
		expect(driven.secrets.every((secret) => encodingsOf(secret).length >= 3)).toBe(true);
		expect(searches.length).toBeGreaterThanOrEqual(72);
		expect(hitsIn(dump, driven.secrets)).toStrictEqual([]);
	});

	it("finds none of the further secrets the flows produced either", () => {
		expect(driven.beyondTheCount).toHaveLength(3);
		expect(hitsIn(dump, driven.beyondTheCount)).toStrictEqual([]);
	});

	it("finds a value that really is in the dump, as text and as bytes", () => {
		expect(hitsIn(dump, [{ name: "planted", value: PLANTED }])).toStrictEqual([
			`planted as ${PLANTED.slice(0, 12)}…`,
			`planted as ${Buffer.from(PLANTED).toString("hex").slice(0, 12)}…`,
		]);
	});

	it("finds a recovery code planted in its canonical form, which the grouped form alone misses", () => {
		const planted = { name: "recovery code planted", value: PLANTED_CODE };
		const canonical = normaliseRecoveryCode(PLANTED_CODE);

		expect(PLANTED_CODE).toContain("-");
		expect(dump).not.toContain(PLANTED_CODE);
		expect(hitsIn(dump, [planted])).toStrictEqual([
			`recovery code planted as ${canonical.slice(0, 12)}…`,
		]);
	});
});
