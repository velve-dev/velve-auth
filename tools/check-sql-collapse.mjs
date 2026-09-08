import { SOURCE_ROOT, scanSqlCollapse } from "./sql-collapse.mjs";

const { offenders, blindSpots, statementsScanned, filesScanned } = scanSqlCollapse();

if (statementsScanned === 0) {
	console.error(`no SQL statement was found under ${SOURCE_ROOT}/, so this run proves nothing.`);
	process.exit(1);
}

if (blindSpots.length > 0) {
	console.error(
		"this scan read less than it reports: a block comment was followed past its own end,",
	);
	console.error("so whatever stood after it was never examined.");
	for (const blindSpot of blindSpots) console.error(`  ${blindSpot}`);
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
