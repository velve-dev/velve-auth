import type { Driver } from "../db/driver.js";
import { assertSchemaName, qualifiedTableName } from "../db/identifier.js";
import { epochOf, type SecurityStateSealing } from "../db/repositories/session.js";
import type { KeyProvider } from "../keys/provider.js";
import { sessionBinding } from "../session/binding.js";
import {
	bindToken,
	checkTokenBinding,
	reportRefusedTokenRow,
	storedPayloadOf,
	type TokenBinding,
	type TokenBindingRefusalReport,
	type TokenBindingVerdict,
} from "./binding.js";
import type { OneTimeTokenPurpose } from "./purpose.js";

/** the tables whose token MACs maintenance rebinds, a pending row being rebound only by its booking */
export type TokenTable = "session" | "one_time_token";

/** what one rebinding pass over a table did */
interface TokenRebinding {
	readonly rebound: number;
	readonly refused: number;
}

interface StoredTokenRow {
	readonly token_sha256: Uint8Array;
	readonly user_id: string;
	readonly token_mac: Uint8Array;
	readonly token_mac_key_version: number;
	readonly factor_names?: string;
	readonly session_epoch?: string | null;
	readonly created_at_us?: string;
	readonly purpose?: OneTimeTokenPurpose;
	readonly payload?: unknown;
}

const TOKEN_MAC_PURPOSE = "token-mac";

const FIRST_TOKEN_HASH = new Uint8Array(0);

function contentColumns(table: TokenTable, states: string, sealing: SecurityStateSealing): string {
	if (table === "session") {
		return `array_to_json(t.factors)::text AS factor_names,
		(extract(epoch FROM t.created_at) * 1000000)::bigint::text AS created_at_us,
		${epochOf(`(SELECT session_epoch FROM ${states} st WHERE st.user_id = t.user_id)`, sealing)}::text AS session_epoch`;
	}
	return "t.purpose, t.payload";
}

//a row is visited once per pass, in token hash order, whether it could be rebound or not
function staleRowsStatement(table: string, columns: string): string {
	return `SELECT t.token_sha256, t.user_id, t.token_mac, t.token_mac_key_version, ${columns}
	FROM ${table} t
	WHERE t.token_mac_key_version <> $1 AND t.token_sha256 > $2 AND t.user_id IS NOT NULL
	ORDER BY t.token_sha256
	LIMIT $3`;
}

//a row written since it was read keeps what was written (S-KEY-5)
function rebindStatement(table: string): string {
	return `UPDATE ${table} SET token_mac = $4, token_mac_key_version = $5
	WHERE token_sha256 = $1 AND user_id = $2 AND token_mac = $3
	RETURNING token_sha256`;
}

function namesOf(json: string | undefined): readonly string[] | null {
	const names: unknown = json === undefined ? null : JSON.parse(json);
	return Array.isArray(names) && names.every((name) => typeof name === "string") ? names : null;
}

//a row whose content cannot be read has no binding and is refused like a forged one
function bindingOf(table: TokenTable, row: StoredTokenRow): TokenBinding | null {
	const tokenHash = new Uint8Array(row.token_sha256);
	if (table === "one_time_token") {
		const stored = storedPayloadOf(row.payload);
		return row.purpose === undefined || stored === null
			? null
			: {
					purpose: row.purpose,
					ownerId: row.user_id,
					tokenSha256: tokenHash,
					content: { payload: stored.payload },
				};
	}
	const names = namesOf(row.factor_names);
	if (names === null) {
		return null;
	}
	const epoch =
		row.session_epoch === null || row.session_epoch === undefined
			? null
			: Number(row.session_epoch);
	return epoch === null || row.created_at_us === undefined
		? null
		: sessionBinding(row.user_id, tokenHash, names, {
				sessionEpoch: epoch,
				createdAtMicros: Number(row.created_at_us),
			});
}

function verdictOf(
	keys: KeyProvider,
	binding: TokenBinding,
	row: StoredTokenRow,
): Promise<TokenBindingVerdict> {
	return checkTokenBinding(keys, binding, {
		tokenMac: row.token_mac,
		tokenMacKeyVersion: row.token_mac_key_version,
	});
}

interface RebindingPass {
	readonly input: RebindingInput;
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
	const { input } = pass;
	const binding = bindingOf(input.table, row);
	const verdict = binding === null ? "mismatch" : await verdictOf(input.keys, binding, row);
	if (binding === null || verdict !== "valid") {
		reportRefusedTokenRow(input.reportTokenBindingRefusal, {
			userId: row.user_id,
			occasion: "maintenance",
			verdict: verdict === "valid" ? "mismatch" : verdict,
		});
		return "refused";
	}
	const next = await bindToken(input.keys, binding);
	const written = await input.driver.query(pass.updateSql, [
		row.token_sha256,
		row.user_id,
		row.token_mac,
		next.tokenMac,
		next.tokenMacKeyVersion,
	]);
	return written.length === 1 ? "rebound" : "left";
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
	const selectSql = staleRowsStatement(table, contentColumns(input.table, states, input.sealing));
	const pass: RebindingPass = { input, updateSql: rebindStatement(table) };
	const { version } = await input.keys.current(TOKEN_MAC_PURPOSE);
	let after: Uint8Array = FIRST_TOKEN_HASH;
	let rebound = 0;
	let refused = 0;
	for (;;) {
		const rows = await input.driver.query<StoredTokenRow>(selectSql, [
			version,
			after,
			input.batchSize,
		]);
		for (const row of rows) {
			const outcome = await rebindRow(pass, row);
			rebound += outcome === "rebound" ? 1 : 0;
			refused += outcome === "refused" ? 1 : 0;
		}
		const last = rows.at(-1);
		if (last === undefined || rows.length < input.batchSize) {
			return { rebound, refused };
		}
		after = last.token_sha256;
	}
}
