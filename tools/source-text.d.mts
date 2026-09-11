export declare function chunksOf(
	source: string,
	lineCommentOpener?: string,
): Generator<{ kind: "code" | "comment" | "quoted"; text: string }>;
export declare function withoutComments(source: string, lineCommentOpener?: string): string;
