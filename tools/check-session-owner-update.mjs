import { scanBuiltPackage, scanTree } from "./session-owner-update.mjs";

const source = scanTree();
const built = scanBuiltPackage();
const offenders = [...source.offenders, ...built.offenders];

if (!built.built) {
	console.error("S-FIX-2: dist/ is missing — run `pnpm build` first, or this check cannot look");
	process.exit(1);
}

if (offenders.length > 0) {
	console.error(
		"S-FIX-2: a session owner is reassigned in SQL. Re-issue is INSERT plus DELETE (E-23).",
	);
	for (const offender of offenders) console.error(`  ${offender}`);
	console.error("If this is prose describing the rule, move it into a comment.");
	process.exit(1);
}

console.log(
	`S-FIX-2: ${source.statementsScanned} source and ${built.statementsScanned} built statements scanned, no session owner reassignment`,
);
