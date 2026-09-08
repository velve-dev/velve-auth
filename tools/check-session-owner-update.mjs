import { scanTree } from "./session-owner-update.mjs";

const { offenders, statementsScanned } = scanTree(["src", "migrations"]);

if (offenders.length > 0) {
	console.error(
		"S-FIX-2: a session owner is reassigned in SQL. Re-issue is INSERT plus DELETE (E-23).",
	);
	for (const offender of offenders) console.error(`  ${offender}`);
	process.exit(1);
}

console.log(`S-FIX-2: ${statementsScanned} statements scanned, no session owner reassignment`);
