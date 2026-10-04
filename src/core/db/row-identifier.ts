const UUID_SPELLING = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** whether a submitted identifier is spelled so that a uuid column could hold it */
export function isRowIdentifier(value: string): boolean {
	return UUID_SPELLING.test(value);
}

//null matches no row where a spelling the uuid cast refuses would answer 500 (S-OWNER-8)
export function rowIdentifierOrNull(value: string): string | null {
	return isRowIdentifier(value) ? value : null;
}
