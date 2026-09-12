import { scanTokenAfterLock } from "./token-after-lock.mjs";

const { offenders, filesScanned, locksScanned } = scanTokenAfterLock();

/** A scan that read nothing, and a tree that takes no account lock at all, both look like a clean
 * result and are not one — the distinction CLAUDE.md §5 asks every check to be able to make. */
if (filesScanned === 0) {
	console.error("The token ordering cannot be checked: no source file was read.");
	process.exit(1);
}
if (locksScanned === 0) {
	console.error(
		"The token ordering cannot be checked: no account lock was found in the tree, so there is nothing for a token write to come after.",
	);
	process.exit(1);
}

if (offenders.length > 0) {
	console.error(
		"velve.one_time_token is ordered before velve.user, and these reach it afterwards:",
	);
	for (const offender of offenders) console.error(`  ${offender}`);
	console.error(
		"A transaction that takes the account row and then writes one_time_token closes a cycle with every redemption in the library (CLAUDE.md section 7, E-1616).",
	);
	process.exit(1);
}

console.log(
	`token ordering: ${locksScanned} account locks over ${filesScanned} files, none followed by a reach for one_time_token`,
);
