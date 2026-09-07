const UNQUOTED_IDENTIFIER = /^[a-z_][a-z0-9_$]*$/;
const MAXIMUM_IDENTIFIER_BYTES = 63;

// PostgreSQL appendix C, the reserved and function-or-type-name-reserved key words.
// A name from this list is only legal after a dot, so it can never be a schema name.
const RESERVED_KEY_WORDS = new Set([
	"all",
	"analyse",
	"analyze",
	"and",
	"any",
	"array",
	"as",
	"asc",
	"asymmetric",
	"authorization",
	"binary",
	"both",
	"case",
	"cast",
	"check",
	"collate",
	"collation",
	"column",
	"concurrently",
	"constraint",
	"create",
	"cross",
	"current_catalog",
	"current_date",
	"current_role",
	"current_schema",
	"current_time",
	"current_timestamp",
	"current_user",
	"default",
	"deferrable",
	"desc",
	"distinct",
	"do",
	"else",
	"end",
	"except",
	"false",
	"fetch",
	"for",
	"foreign",
	"freeze",
	"from",
	"full",
	"grant",
	"group",
	"having",
	"ilike",
	"in",
	"initially",
	"inner",
	"intersect",
	"into",
	"is",
	"isnull",
	"join",
	"lateral",
	"leading",
	"left",
	"like",
	"limit",
	"localtime",
	"localtimestamp",
	"natural",
	"not",
	"notnull",
	"null",
	"offset",
	"on",
	"only",
	"or",
	"order",
	"outer",
	"overlaps",
	"placing",
	"primary",
	"references",
	"returning",
	"right",
	"select",
	"session_user",
	"similar",
	"some",
	"symmetric",
	"system_user",
	"table",
	"tablesample",
	"then",
	"to",
	"trailing",
	"true",
	"union",
	"unique",
	"user",
	"using",
	"variadic",
	"verbose",
	"when",
	"where",
	"window",
	"with",
]);

export class InvalidIdentifierError extends Error {
	readonly code = "invalid_identifier";

	constructor(identifier: string, reason: string) {
		super(`"${identifier}" is not a usable PostgreSQL identifier: ${reason}`);
		this.name = "InvalidIdentifierError";
	}
}

export function assertIdentifier(identifier: string): string {
	if (!UNQUOTED_IDENTIFIER.test(identifier)) {
		throw new InvalidIdentifierError(
			identifier,
			`expected a lowercase name matching ${UNQUOTED_IDENTIFIER.source}`,
		);
	}
	if (new TextEncoder().encode(identifier).length > MAXIMUM_IDENTIFIER_BYTES) {
		throw new InvalidIdentifierError(
			identifier,
			`expected at most ${MAXIMUM_IDENTIFIER_BYTES} bytes`,
		);
	}
	return identifier;
}

export function assertSchemaName(schema: string): string {
	assertIdentifier(schema);
	if (RESERVED_KEY_WORDS.has(schema)) {
		throw new InvalidIdentifierError(schema, "a reserved key word cannot name a schema");
	}
	return schema;
}

export function qualifiedTableName(schema: string, table: string): string {
	return `${assertSchemaName(schema)}.${assertIdentifier(table)}`;
}
