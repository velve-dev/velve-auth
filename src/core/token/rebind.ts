import type { Driver } from "../db/driver.js";
import { assertSchemaName, qualifiedTableName } from "../db/identifier.js";
import { epochOf, microsOf, type SecurityStateSealing } from "../db/repositories/session.js";
import { pendingBinding } from "../factor/pending/binding.js";
import type { KeyProvider } from "../keys/provider.js";
import { sessionBinding } from "../session/binding.js";
import {
	bindToken,
	checkTokenBinding,
	reportRefusedTokenRow,
	storedPayloadOf,
	type TokenBinding,
	type TokenBindingRefusalReport,
} from "./binding.js";
import type { OneTimeTokenPurpose } from "./purpose.js";

/** the tables whose rows carry a token MAC, every one of which the maintenance pass rebinds */
export type TokenTable =
	| "session"
	| "one_time_token"
	| "pending_authentication"
	| "webauthn_challenge";

/** the rows one key version still holds after a pass, the usable apart from the ones it refused */
interface RowsUnderKeyVersion {
	readonly tokens: number;
	/** rows this pass refused and left standing as evidence, which do not hold the version in the ring */
	readonly traces: number;
}

/** what one rebinding pass over a table did, and how many rows each key version still holds after it */
interface TokenRebinding {
	readonly rebound: number;
	readonly refused: number;
	/** a version may leave the ring only once a pass reports no usable token row under it */
	readonly rowsByKeyVersion: Readonly<Record<number, RowsUnderKeyVersion>>;
}

interface StoredTokenRow {
	readonly token_hash: Uint8Array;
	readonly user_id: string | null;
	readonly session_id?: string;
	readonly token_mac: Uint8Array;
	readonly token_mac_key_version: number;
	readonly factor_names?: string;
	readonly session_epoch?: string | null;
	readonly created_at_us?: string;
	readonly attempts?: number;
	readonly purpose?: string;
	readonly payload_text?: string | null;
}

/** how one table stores what its MAC is taken over */
interface TableShape {
	readonly hashColumn: string;
	readonly contentColumns: (states: string, sealing: SecurityStateSealing) => string;
	readonly guardsAttempts: boolean;
	readonly bindingOf: (row: StoredTokenRow, tokenHash: Uint8Array) => TokenBinding | null;
}

const TOKEN_MAC_PURPOSE = "token-mac";

const FIRST_TOKEN_HASH = new Uint8Array(0);

function namesOf(json: string | undefined): readonly string[] | null {
	const names: unknown = json === undefined ? null : JSON.parse(json);
	return Array.isArray(names) && names.every((name) => typeof name === "string") ? names : null;
}

function exactIntegerOf(text: string | null | undefined): number | null {
	const value = text === null || text === undefined ? Number.NaN : Number(text);
	return Number.isSafeInteger(value) ? value : null;
}

function sessionBindingOf(row: StoredTokenRow, tokenHash: Uint8Array): TokenBinding | null {
	const names = namesOf(row.factor_names);
	const sessionEpoch = exactIntegerOf(row.session_epoch);
	const createdAtMicros = exactIntegerOf(row.created_at_us);
	if (
		row.user_id === null ||
		row.session_id === undefined ||
		names === null ||
		sessionEpoch === null ||
		createdAtMicros === null
	) {
		return null;
	}
	return sessionBinding(row.user_id, tokenHash, names, {
		sessionId: row.session_id,
		sessionEpoch,
		createdAtMicros,
	});
}

function pendingBindingOf(row: StoredTokenRow, tokenHash: Uint8Array): TokenBinding | null {
	const names = namesOf(row.factor_names);
	if (row.user_id === null || names === null || row.attempts === undefined) {
		return null;
	}
	return pendingBinding(row.user_id, tokenHash, names, row.attempts);
}

function oneTimeBindingOf(row: StoredTokenRow, tokenHash: Uint8Array): TokenBinding | null {
	const stored = storedPayloadOf(row.payload_text);
	if (row.purpose === undefined || stored === null) {
		return null;
	}
	return {
		purpose: row.purpose as OneTimeTokenPurpose,
		ownerId: row.user_id,
		tokenSha256: tokenHash,
		content: { payload: stored.payload },
	};
}

function challengeBindingOf(row: StoredTokenRow, tokenHash: Uint8Array): TokenBinding | null {
	if (row.purpose === undefined) {
		return null;
	}
	return {
		purpose: "webauthn_challenge",
		ownerId: row.user_id,
		tokenSha256: tokenHash,
		content: { ceremony: row.purpose },
	};
}

const SHAPES: Readonly<Record<TokenTable, TableShape>> = {
	session: {
		hashColumn: "token_sha256",
		contentColumns: (
			states,
			sealing,
		) => `t.id::text AS session_id, array_to_json(t.factors)::text AS factor_names,
		${microsOf("t.created_at")} AS created_at_us,
		${epochOf(`(SELECT session_epoch FROM ${states} st WHERE st.user_id = t.user_id)`, sealing)}::text AS session_epoch`,
		guardsAttempts: false,
		bindingOf: sessionBindingOf,
	},
	one_time_token: {
		hashColumn: "token_sha256",
		contentColumns: () => "t.purpose, t.payload::text AS payload_text",
		guardsAttempts: false,
		bindingOf: oneTimeBindingOf,
	},
	pending_authentication: {
		hashColumn: "token_sha256",
		contentColumns: () => "array_to_json(t.factors_completed)::text AS factor_names, t.attempts",
		guardsAttempts: true,
		bindingOf: pendingBindingOf,
	},
	webauthn_challenge: {
		hashColumn: "challenge_sha256",
		contentColumns: () => "t.purpose",
		guardsAttempts: false,
		bindingOf: challengeBindingOf,
	},
};

function staleRowsStatement(table: string, shape: TableShape, columns: string): string {
	return `SELECT t.${shape.hashColumn} AS token_hash, t.user_id, t.token_mac, t.token_mac_key_version,
		${columns}
	FROM ${table} t
	WHERE t.token_mac_key_version <> $1 AND t.${shape.hashColumn} > $2
	ORDER BY t.${shape.hashColumn}
	LIMIT $3`;
}

//a row written since it was read keeps what was written and a pending counter must not move (S-KEY-5)
function rebindStatement(table: string, shape: TableShape): string {
	return `UPDATE ${table} SET token_mac = $4, token_mac_key_version = $5
	WHERE ${shape.hashColumn} = $1 AND user_id IS NOT DISTINCT FROM $2::uuid AND token_mac = $3
		AND token_mac_key_version = $6
		${shape.guardsAttempts ? "AND attempts = $7" : ""}
	RETURNING ${shape.hashColumn}`;
}

//a trace is the refused row itself so a row rewritten since its refusal counts as a token again (S-KEY-5)
function rowsByKeyVersionStatement(table: string, shape: TableShape): string {
	return `WITH trace AS (
		SELECT decode(refused->>0, 'hex') AS token_hash, decode(refused->>1, 'hex') AS token_mac
		FROM jsonb_array_elements($1::jsonb) AS refused
	)
	SELECT t.token_mac_key_version,
		count(*) FILTER (WHERE trace.token_hash IS NULL)::int AS tokens,
		count(trace.token_hash)::int AS traces
	FROM ${table} t
	LEFT JOIN trace ON trace.token_hash = t.${shape.hashColumn} AND trace.token_mac = t.token_mac
	GROUP BY t.token_mac_key_version ORDER BY t.token_mac_key_version`;
}

interface RebindingPass {
	readonly input: RebindingInput;
	readonly shape: TableShape;
	readonly updateSql: string;
}

/** what a rebinding pass over one table needs */
interface RebindingInput {
	readonly driver: Driver;
	readonly schema: string;
	readonly keys: KeyProvider;
	readonly sealing: SecurityStateSealing;
	readonly table: TokenTable;
	readonly batchSize: number;
	readonly reportTokenBindingRefusal?: TokenBindingRefusalReport;
}

//a row that fails its own version's check is never given the current one (S-INTEG-9)
async function rebindRow(
	pass: RebindingPass,
	row: StoredTokenRow,
): Promise<"rebound" | "refused" | "left"> {
	const { input, shape } = pass;
	const binding = shape.bindingOf(row, new Uint8Array(row.token_hash));
	const verdict =
		binding === null
			? "mismatch"
			: await checkTokenBinding(input.keys, binding, {
					tokenMac: row.token_mac,
					tokenMacKeyVersion: row.token_mac_key_version,
				});
	if (binding === null || verdict !== "valid") {
		reportRefusedTokenRow(input.reportTokenBindingRefusal, {
			userId: row.user_id,
			occasion: "maintenance",
			verdict: verdict === "valid" ? "mismatch" : verdict,
		});
		return "refused";
	}
	const next = await bindToken(input.keys, binding);
	//a compare-and-set whose miss leaves the row must run at read committed whatever the default (E-3481)
	const written = await input.driver.transaction((tx) =>
		tx.query(pass.updateSql, [
			row.token_hash,
			row.user_id,
			row.token_mac,
			next.tokenMac,
			next.tokenMacKeyVersion,
			row.token_mac_key_version,
			...(shape.guardsAttempts ? [row.attempts] : []),
		]),
	);
	return written.length === 1 ? "rebound" : "left";
}

function hexOf(bytes: Uint8Array): string {
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function rowsByKeyVersionOf(
	driver: Driver,
	table: string,
	shape: TableShape,
	traces: readonly StoredTokenRow[],
): Promise<Readonly<Record<number, RowsUnderKeyVersion>>> {
	const refused = JSON.stringify(
		traces.map((row) => [hexOf(row.token_hash), hexOf(row.token_mac)]),
	);
	const rows = await driver.query<{
		token_mac_key_version: number;
		tokens: number;
		traces: number;
	}>(rowsByKeyVersionStatement(table, shape), [refused]);
	return Object.fromEntries(
		rows.map((row) => [row.token_mac_key_version, { tokens: row.tokens, traces: row.traces }]),
	);
}

/**
 * rebinds every token row of one table that is not under the current token-mac version, in
 * batches, after checking it under its own version
 */
export async function rebindTokenRowsUnderCurrentKey(
	input: RebindingInput,
): Promise<TokenRebinding> {
	const schema = assertSchemaName(input.schema);
	const table = qualifiedTableName(schema, input.table);
	const states = qualifiedTableName(schema, "security_state");
	const shape = SHAPES[input.table];
	const selectSql = staleRowsStatement(table, shape, shape.contentColumns(states, input.sealing));
	const pass: RebindingPass = { input, shape, updateSql: rebindStatement(table, shape) };
	const { version } = await input.keys.current(TOKEN_MAC_PURPOSE);
	let after: Uint8Array = FIRST_TOKEN_HASH;
	let rebound = 0;
	const traces: StoredTokenRow[] = [];
	for (;;) {
		const rows = await input.driver.query<StoredTokenRow>(selectSql, [
			version,
			after,
			input.batchSize,
		]);
		for (const row of rows) {
			const outcome = await rebindRow(pass, row);
			rebound += outcome === "rebound" ? 1 : 0;
			if (outcome === "refused") {
				traces.push(row);
			}
		}
		const last = rows.at(-1);
		if (last === undefined || rows.length < input.batchSize) {
			return {
				rebound,
				refused: traces.length,
				rowsByKeyVersion: await rowsByKeyVersionOf(input.driver, table, shape, traces),
			};
		}
		after = last.token_hash;
	}
}
