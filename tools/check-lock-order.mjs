import { scanLockOrder } from "./lock-order.mjs";

const { offenders, filesScanned, locksScanned } = scanLockOrder();

/* A scan that matched no file, or a tree with no row lock left in it, is not the same answer as a
   clean one — and the previous version of this step reported both as success (E-1609). */
if (filesScanned === 0 || locksScanned === 0) {
	console.error(
		`lock order: refusing to report. ${filesScanned} files scanned, ${locksScanned} row locks found; the account lock of src/core/db/lock.ts is expected among them.`,
	);
	process.exit(1);
}

if (offenders.length > 0) {
	console.error(
		"a row lock is written in src/core/db/lock.ts, taken FOR NO KEY UPDATE, and declares velve.user (CLAUDE.md §7).",
	);
	for (const offender of offenders) console.error(`  ${offender}`);
	process.exit(1);
}

/* What this step decides and what it does not. It reads modes and declarations, which are properties
   of one statement; the order two transactions take their locks in is a property of a program and is
   decided by test/lock-order-race.test.ts, not here (E-1609). */
console.log(
	`lock order: ${locksScanned} row locks in ${filesScanned} files, all FOR NO KEY UPDATE on velve.user.`,
);
console.log(
	"lock order: no ordering is checked here. An implicit acquisition — a foreign key's key share, an ON CONFLICT index wait — is not a statement and is not read.",
);
