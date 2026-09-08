import type { Driver } from "../db/driver.js";
import { qualifiedTableName } from "../db/identifier.js";

/** Architecture 3.15 C. `username_key` is absent by design: it is the comparison form. */
export interface User {
	readonly id: string;
	readonly createdAt: Date;
	readonly updatedAt: Date;
	readonly email: string | null;
	readonly emailVerifiedAt: Date | null;
	readonly username: string | null;
	readonly disabledAt: Date | null;
	readonly hasPassword: boolean;
	readonly importedFrom: ImportSource | null;
}

export type ImportSource = "supabase" | "clerk" | "auth0" | "firebase" | "nextauth";

const IMPORT_SOURCES: readonly ImportSource[] = [
	"supabase",
	"clerk",
	"auth0",
	"firebase",
	"nextauth",
];

export interface UserRepository {
	findUserById(userId: string): Promise<User | null>;
	findUserByEmail(email: string): Promise<User | null>;
	findUserByUsernameKey(usernameKey: string): Promise<User | null>;
	setDisabledAt(input: { readonly userId: string; readonly disabled: boolean }): Promise<void>;
	deleteUser(userId: string): Promise<void>;
}

interface UserRowShape {
	readonly id: string;
	readonly created_at: unknown;
	readonly updated_at: unknown;
	readonly email: string | null;
	readonly email_verified_at: unknown;
	readonly username: string | null;
	readonly disabled_at: unknown;
	readonly imported_from: string | null;
	readonly has_password: boolean;
}

function toDate(value: unknown): Date {
	if (value instanceof Date) {
		return value;
	}
	throw new TypeError("the driver must decode timestamptz into a Date");
}

function toOptionalDate(value: unknown): Date | null {
	return value === null || value === undefined ? null : toDate(value);
}

function toImportSource(value: string | null): ImportSource | null {
	if (value === null) {
		return null;
	}
	if (!(IMPORT_SOURCES as readonly string[]).includes(value)) {
		throw new TypeError("velve.user.imported_from names a source this library does not know");
	}
	return value as ImportSource;
}

/** `hasPassword` is derived from the row's existence, which is why 3.15 C has no `password.isSet`. */
function selection(users: string, credentials: string, predicate: string): string {
	return `SELECT u.id, u.created_at, u.updated_at, u.email, u.email_verified_at, u.username,
		u.disabled_at, u.imported_from,
		EXISTS (SELECT 1 FROM ${credentials} c WHERE c.user_id = u.id) AS has_password
	FROM ${users} u
	WHERE ${predicate}`;
}

function toUser(row: UserRowShape): User {
	return {
		id: row.id,
		createdAt: toDate(row.created_at),
		updatedAt: toDate(row.updated_at),
		email: row.email,
		emailVerifiedAt: toOptionalDate(row.email_verified_at),
		username: row.username,
		disabledAt: toOptionalDate(row.disabled_at),
		hasPassword: row.has_password,
		importedFrom: toImportSource(row.imported_from),
	};
}

export function createUserRepository(options: {
	readonly driver: Driver;
	readonly schema: string;
}): UserRepository {
	const users = qualifiedTableName(options.schema, "user");
	const credentials = qualifiedTableName(options.schema, "password_credential");
	const byId = selection(users, credentials, "u.id = $1");
	const byEmail = selection(users, credentials, "u.email = $1");
	const byUsernameKey = selection(users, credentials, "u.username_key = $1");

	async function findOne(sql: string, parameter: string): Promise<User | null> {
		const [row] = await options.driver.query<UserRowShape>(sql, [parameter]);
		return row === undefined ? null : toUser(row);
	}

	return {
		findUserById: (userId) => findOne(byId, userId),
		findUserByEmail: (email) => findOne(byEmail, email),
		findUserByUsernameKey: (usernameKey) => findOne(byUsernameKey, usernameKey),

		/**
		 * L-4: the sessions stay; each of them ends at its next resolution. There is no owner
		 * predicate because the caller is the application in its own process, after its own
		 * authorization decision (B.3) — no route reaches this.
		 */
		async setDisabledAt({ userId, disabled }) {
			await options.driver.query(
				`UPDATE ${users} /* no owner predicate: S-OWNER-7, the caller is the application itself (B.3) */
				SET disabled_at = ${disabled ? "now()" : "NULL"}, updated_at = now()
				WHERE id = $1`,
				[userId],
			);
		},

		async deleteUser(userId) {
			await options.driver.query(
				`DELETE FROM ${users} /* no owner predicate: S-OWNER-7, the caller is the application itself (B.3) */
				WHERE id = $1`,
				[userId],
			);
		},
	};
}
