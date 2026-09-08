import { scanLockOrder } from "./lock-order.mjs";

const { offenders, locksScanned } = scanLockOrder();

if (offenders.length > 0) {
	console.error("velve.user must be locked before any other table (CLAUDE.md section 7).");
	for (const offender of offenders) console.error(`  ${offender}`);
	process.exit(1);
}

console.log(`lock order: ${locksScanned} row locks scanned, all on velve.user`);
