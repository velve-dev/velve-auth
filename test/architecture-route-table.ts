import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IdentityMode } from "../src/core/db/migrations/identity-mode.js";

interface DeclaredRow {
	readonly method: string;
	readonly path: string;
}

const SPECIFICATION = fileURLToPath(new URL("../VELVE-AUTH-ARCHITEKTUR.md", import.meta.url));

const TABLE_OPENS = "##### D.3 Die Routentabelle";
const TABLE_CLOSES = "Nicht aufgeführt, weil überall möglich";
const ROW = /^\|\s*(GET|POST)\s*\|\s*`([^`]+)`\s*\|/;

/**
 * Fewer rows than any plausible reading of D.3, so a parser that stopped matching answers "could
 * not look" rather than "found nothing". The exact count is not asserted here: it is what the
 * comparison is for, and a second copy of it would be the thing that goes stale.
 */
const FEWEST_ROWS_D3_COULD_HOLD = 30;

/** 3.15 D.3, the binding German. Read at test time so no second copy of the table can drift from it. */
export function everyRowDeclaredByD3(): readonly DeclaredRow[] {
	const specification = readFileSync(SPECIFICATION, "utf8");
	const opens = specification.indexOf(TABLE_OPENS);
	const closes = specification.indexOf(TABLE_CLOSES, opens);
	if (opens < 0 || closes < 0) {
		throw new Error(`${TABLE_OPENS} was not found in the specification; this scan cannot look`);
	}
	const rows = specification
		.slice(opens, closes)
		.split("\n")
		.map((line) => ROW.exec(line))
		.filter((matched): matched is RegExpExecArray => matched !== null)
		.map((matched) => ({ method: matched[1] ?? "", path: matched[2] ?? "" }));
	if (rows.length < FEWEST_ROWS_D3_COULD_HOLD) {
		throw new Error(`D.3 parsed to ${rows.length} rows, which is too few to be the table`);
	}
	return rows;
}

export interface ServedConfiguration {
	readonly mode: IdentityMode;
	readonly webauthn: boolean;
}

/** The nine rows D.3 names as the ones an unconfigured `webauthn` removes. */
function isAWebAuthnRow(path: string): boolean {
	return path.startsWith("/factor/webauthn/") || path.startsWith("/sign-in/passkey/");
}

/** What mode `username` additionally lacks: magic link, the mailed reset, and every `/email/*` row. */
function needsAnAddress(path: string): boolean {
	return (
		path.startsWith("/email/") ||
		path.startsWith("/sign-in/magic-link/") ||
		path === "/password/request-reset" ||
		path === "/password/redeem-reset"
	);
}

/**
 * The filter D.3's closing paragraph states: 47 rows in `username_email`, 45 in `email` without
 * the two `/username/*` rows, 39 in `username` without the eight an address reaches, and nine
 * fewer wherever `webauthn` is unconfigured.
 */
export function rowsServedUnder(configuration: ServedConfiguration): readonly DeclaredRow[] {
	return everyRowDeclaredByD3().filter(({ path }) => {
		if (!configuration.webauthn && isAWebAuthnRow(path)) {
			return false;
		}
		if (configuration.mode === "email" && path.startsWith("/username/")) {
			return false;
		}
		return !(configuration.mode === "username" && needsAnAddress(path));
	});
}

export function addressOf(row: { method: string; path: string }): string {
	return `${row.method} ${row.path}`;
}
