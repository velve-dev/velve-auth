import { scanEgress } from "./egress.mjs";

const { offenders, filesScanned, callsScanned } = scanEgress();

/** A scan that read nothing, and a tree where the one outbound seam calls nothing, both look like
 * a clean result and are not one — the distinction CLAUDE.md §5 asks every check to make. */
if (filesScanned === 0) {
	console.error("Egress cannot be checked: no source file was read.");
	process.exit(1);
}
if (callsScanned === 0) {
	console.error(
		"Egress cannot be checked: the declared outbound seam makes no call, so a call elsewhere would be the only one and this scan proves nothing.",
	);
	process.exit(1);
}

if (offenders.length > 0) {
	console.error("The library reaches outside the operator's infrastructure here:");
	for (const offender of offenders) console.error(`  ${offender}`);
	console.error(
		"Only src/core/oauth/outbound.ts may call out, through the injectable config.fetch, and only src/core/oauth/providers.ts may name a provider host (README.md, E-1844).",
	);
	process.exit(1);
}

console.log(
	`egress: ${callsScanned} outbound calls, all inside the declared seam, over ${filesScanned} files; no other module reaches the network or names a host`,
);
