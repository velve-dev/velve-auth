/**
 * Lowercasing a whole string applies the Final_Sigma rule, so `ΟΔΟΣ` becomes `οδος` where
 * PostgreSQL's `lower()` gives `οδοσ`; per code point there is no context for that rule to
 * read. Every comparison form in this module comes from here, so no two of them can disagree.
 */
export function caseFolded(value: string): string {
	return [...value].map((character) => character.toLowerCase()).join("");
}

export function codePointCount(value: string): number {
	return [...value].length;
}

export function comparisonFormOf(name: string): string {
	return caseFolded(name.trim().normalize("NFKC"));
}
