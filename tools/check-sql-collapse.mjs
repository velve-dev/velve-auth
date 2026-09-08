import { SOURCE_ROOT, scanSqlCollapse } from "./sql-collapse.mjs";

const { offenders, statementsScanned, filesScanned } = scanSqlCollapse();

if (statementsScanned === 0) {
	console.error(`no SQL statement was found under ${SOURCE_ROOT}/, so this run proves nothing.`);
	process.exit(1);
}

if (offenders.length > 0) {
	console.error(
		"a line comment takes the rest of its statement once the newlines are normalised away.",
	);
	console.error("Use a block comment, whose end is in the text (E-266):");
	for (const offender of offenders) console.error(`  ${offender}`);
	process.exit(1);
}

console.log(
	`sql collapse: ${statementsScanned} statements in ${filesScanned} files survive normalisation`,
);
