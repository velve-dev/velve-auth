import type { Actor } from "../actor.js";
import type { Driver } from "../driver.js";
import { assertIdentifier, qualifiedTableName } from "../identifier.js";

interface OwnedRowRepositoryOptions {
	readonly driver: Driver;
	readonly schema: string;
	readonly table: string;
	readonly idColumn?: string;
	readonly ownerColumn?: string;
	readonly updatableColumns?: readonly string[];
}

interface OwnedRowRepository<Row> {
	findOwnedRow(input: { id: string; actor: Actor }): Promise<Row | null>;
	listOwnedRows(input: { actor: Actor }): Promise<Row[]>;
	updateOwnedRow(input: {
		id: string;
		actor: Actor;
		values: Readonly<Record<string, unknown>>;
	}): Promise<Row | null>;
	deleteOwnedRow(input: { id: string; actor: Actor }): Promise<Row | null>;
	deleteAllOwnedRows(input: { actor: Actor }): Promise<number>;
}

export class UnknownColumnError extends Error {
	readonly code = "unknown_column";

	constructor(table: string, column: string) {
		super(`${table} has no updatable column named "${column}"`);
		this.name = "UnknownColumnError";
	}
}

export function createOwnedRowRepository<Row>(
	options: OwnedRowRepositoryOptions,
): OwnedRowRepository<Row> {
	const table = qualifiedTableName(options.schema, options.table);
	const idColumn = assertIdentifier(options.idColumn ?? "id");
	const ownerColumn = assertIdentifier(options.ownerColumn ?? "user_id");
	const updatableColumns = new Set(
		(options.updatableColumns ?? []).map((column) => assertIdentifier(column)),
	);

	function assignments(values: Readonly<Record<string, unknown>>): {
		clause: string;
		params: unknown[];
	} {
		const columns = Object.keys(values);
		for (const column of columns) {
			if (!updatableColumns.has(column)) {
				throw new UnknownColumnError(table, column);
			}
		}
		return {
			clause: columns.map((column, index) => `${column} = $${index + 3}`).join(", "),
			params: columns.map((column) => values[column]),
		};
	}

	return {
		async findOwnedRow({ id, actor }) {
			const [row] = await options.driver.query<Row>(
				`SELECT * FROM ${table} WHERE ${idColumn} = $1 AND ${ownerColumn} = $2`,
				[id, actor],
			);
			return row ?? null;
		},

		listOwnedRows({ actor }) {
			return options.driver.query<Row>(
				`SELECT * FROM ${table} WHERE ${ownerColumn} = $1 ORDER BY ${idColumn}`,
				[actor],
			);
		},

		async updateOwnedRow({ id, actor, values }) {
			const { clause, params } = assignments(values);
			if (clause === "") {
				return null;
			}
			const [row] = await options.driver.query<Row>(
				`UPDATE ${table} SET ${clause} WHERE ${idColumn} = $1 AND ${ownerColumn} = $2 RETURNING *`,
				[id, actor, ...params],
			);
			return row ?? null;
		},

		async deleteOwnedRow({ id, actor }) {
			const [row] = await options.driver.query<Row>(
				`DELETE FROM ${table} WHERE ${idColumn} = $1 AND ${ownerColumn} = $2 RETURNING *`,
				[id, actor],
			);
			return row ?? null;
		},

		async deleteAllOwnedRows({ actor }) {
			const rows = await options.driver.query(
				`DELETE FROM ${table} WHERE ${ownerColumn} = $1 RETURNING ${idColumn}`,
				[actor],
			);
			return rows.length;
		},
	};
}
