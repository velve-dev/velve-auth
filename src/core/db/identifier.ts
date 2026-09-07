const UNQUOTED_IDENTIFIER = /^[a-z_][a-z0-9_$]*$/;
const MAXIMUM_IDENTIFIER_BYTES = 63;

export class InvalidIdentifierError extends Error {
	readonly code = "invalid_identifier";

	constructor(identifier: string) {
		super(
			`"${identifier}" is not a usable PostgreSQL identifier: expected up to ${MAXIMUM_IDENTIFIER_BYTES} characters matching ${UNQUOTED_IDENTIFIER.source}`,
		);
		this.name = "InvalidIdentifierError";
	}
}

export function assertIdentifier(identifier: string): string {
	if (
		!UNQUOTED_IDENTIFIER.test(identifier) ||
		new TextEncoder().encode(identifier).length > MAXIMUM_IDENTIFIER_BYTES
	) {
		throw new InvalidIdentifierError(identifier);
	}
	return identifier;
}

export function qualifiedTableName(schema: string, table: string): string {
	return `${assertIdentifier(schema)}.${assertIdentifier(table)}`;
}
