import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const ROW_LOCK = /\bfor\s+(?:no\s+key\s+)?update\b/gi;
const SOURCE = /\.(m?[jt]sx?|c[jt]s|sql)$/;

/** The schema is fixed at sixteen tables, so naming the fifteen that are not `user`
 * catches a wrong lock without a false alarm on an interpolated table name — which
 * a search for the word `user` cannot distinguish from a variable called `owners`.
 * The limit this accepts: a lock whose target is only an interpolation is allowed. */
const NOT_THE_USER_TABLE =
	/\b(password_credential|identity|session|one_time_token|pending_authentication|totp_credential|totp_used_step|recovery_code|webauthn_credential|webauthn_challenge|oauth_flow|rate_bucket|schema_migration|import_mapping|password_reset_required)\b/i;

/** A locking statement names the table it locks between FROM and the lock clause. */
function tableOfLockingStatement(sql, lockIndex) {
	const before = sql.slice(0, lockIndex);
	const from = /\bfrom\b([\s\S]*)$/i.exec(before);
	return from?.[1] ?? "";
}

export function locksSomethingBeforeUser(sql) {
	const offending = [];
	for (const match of sql.matchAll(ROW_LOCK)) {
		const target = tableOfLockingStatement(sql, match.index ?? 0).slice(-200);
		if (NOT_THE_USER_TABLE.test(target)) {
			offending.push(target.trim().replace(/\s+/g, " ").slice(-80));
		}
	}
	return offending;
}

function sourceFiles() {
	const listed = execFileSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		{ cwd: repositoryRoot, encoding: "utf8" },
	);
	return listed
		.split("\0")
		.filter(Boolean)
		.filter((path) => SOURCE.test(path))
		.filter((path) => !path.startsWith("test/"));
}

export function scanLockOrder() {
	const offenders = [];
	let locksScanned = 0;
	for (const path of sourceFiles()) {
		const contents = readFileSync(`${repositoryRoot}/${path}`, "utf8");
		for (const match of contents.matchAll(ROW_LOCK)) {
			locksScanned += 1;
			const target = tableOfLockingStatement(contents, match.index ?? 0);
			if (NOT_THE_USER_TABLE.test(target.slice(-200))) {
				offenders.push(`${path}: locks ${target.trim().replace(/\s+/g, " ").slice(-80) || "?"}`);
			}
		}
	}
	return { offenders, locksScanned };
}
