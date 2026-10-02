//folding per code point skips Final_Sigma and matches PostgreSQL lower (E-202)
export function caseFolded(value: string): string {
	return [...value].map((character) => character.toLowerCase()).join("");
}

export function codePointCount(value: string): number {
	return [...value].length;
}

export function comparisonFormOf(name: string): string {
	return caseFolded(name.trim().normalize("NFKC"));
}
