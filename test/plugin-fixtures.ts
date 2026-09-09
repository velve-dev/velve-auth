import { randomBytes } from "node:crypto";
import type { Driver } from "../src/core/db/driver.js";
import type { RequestContext } from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import {
	FALLBACK_DATABASE_URL,
	openTestConnection,
	type TestConnection,
} from "./db-postgres-connection.js";

/**
 * A plugin written in JavaScript reaches the registry as a plain object, which is the half of 3.11
 * the type constraint cannot cover. One cast, in one place, so no test needs its own.
 */
export function asJavaScriptPlugin(value: Readonly<Record<string, unknown>>): VelvePlugin {
	return value as unknown as VelvePlugin;
}

export interface ObservedCall {
	readonly route: string;
	readonly context: RequestContext;
}

export interface ContextProbe {
	readonly plugin: VelvePlugin<"demo">;
	readonly calls: readonly ObservedCall[];
	last(): ObservedCall;
	clear(): void;
}

/** A route that records the context it was handed and answers nothing, so the assertion is the context. */
export function createContextProbe(options: { readonly path?: string } = {}): ContextProbe {
	const calls: ObservedCall[] = [];
	const route: PluginRoute<"demo"> = {
		name: "demo.echo",
		method: "POST",
		path: `/x/demo/${options.path ?? "echo"}`,
		input: object({}),
		errors: [] as const,
		caller: "anonymous",
		freshness: "not_required",
		originCheck: "checked",
		rateLimit: { perIpAddress: "none", perAccount: "none" },
		handler: (_input: unknown, context: RequestContext) => {
			calls.push({ route: "demo.echo", context });
			return Promise.resolve({ seen: true });
		},
	};
	return {
		plugin: { id: "demo", routes: [route] },
		get calls() {
			return calls;
		},
		last: () => {
			const call = calls.at(-1);
			if (call === undefined) {
				throw new Error("the probe route was never reached");
			}
			return call;
		},
		clear: () => {
			calls.length = 0;
		},
	};
}

/** Startup refusals are decided before any statement runs, so the tests that provoke them need no server. */
export function unreachableDriver(): Driver {
	const refuse = (): Promise<never> =>
		Promise.reject(new Error("a start error must be decided before any query"));
	return { query: refuse, transaction: refuse };
}

export interface MigrationRole {
	readonly name: string;
	readonly url: string;
}

/**
 * A role that owns the schema and is neither a superuser nor a creator of roles, reached by
 * **connecting as it**. Reaching it by `SET ROLE` from the superuser connection was the one
 * configuration in which the guard cannot be observed at all: `session_user` stays the superuser,
 * one `RESET ROLE` undoes the switch, and a measurement taken there cannot tell a working guard
 * from a bypassed one (E-929).
 *
 * It owns the schema rather than holding privileges on it, and is granted `CREATE` on the database
 * and on `public`, so that what refuses a migration reaching a core table or another schema is the
 * **runner** and not PostgreSQL — a grant that withheld the privilege would refuse first and the
 * test would prove the grant (E-920). Its password is generated per schema and never written down.
 */
export async function createTheMigrationRole(
	owner: TestConnection,
	schema: string,
): Promise<MigrationRole> {
	const name = `${schema}_migrator`;
	const password = randomBytes(24).toString("hex");
	const [database] = await owner.query<{ name: string }>("SELECT current_database() AS name", []);
	await owner.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}'`, []);
	await owner.query(`GRANT CONNECT, CREATE ON DATABASE "${database?.name}" TO ${name}`, []);
	await owner.query(`GRANT CREATE ON SCHEMA public TO ${name}`, []);
	await owner.query(
		`DO $handover$
		DECLARE owned record;
		BEGIN
			EXECUTE format('ALTER SCHEMA %I OWNER TO %I', '${schema}', '${name}');
			FOR owned IN
				SELECT child.oid AS id FROM pg_class child
				JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
				WHERE namespace_.nspname = '${schema}' AND child.relkind IN ('r', 'p')
			LOOP
				EXECUTE format('ALTER TABLE %s OWNER TO %I', owned.id::regclass, '${name}');
			END LOOP;
			FOR owned IN
				SELECT routine.oid AS id FROM pg_proc routine
				JOIN pg_namespace namespace_ ON namespace_.oid = routine.pronamespace
				WHERE namespace_.nspname = '${schema}'
			LOOP
				EXECUTE format('ALTER FUNCTION %s OWNER TO %I', owned.id::regprocedure, '${name}');
			END LOOP;
		END
		$handover$`,
		[],
	);
	const url = new URL(process.env.VELVE_TEST_DATABASE_URL ?? FALLBACK_DATABASE_URL);
	url.username = name;
	url.password = password;
	return { name, url: url.toString() };
}

/** One connection, open only while the migration runs, because the suite shares a connection budget. */
export async function asTheMigrationRole<T>(
	role: MigrationRole,
	run: (driver: TestConnection) => Promise<T>,
): Promise<T> {
	const driver = await openTestConnection(role.url);
	try {
		return await run(driver);
	} finally {
		await driver.close();
	}
}

/** Run after the schema is dropped: the role owns what is left of it. */
export async function dropTheMigrationRole(
	owner: TestConnection,
	role: MigrationRole,
): Promise<void> {
	await owner.query(`DROP OWNED BY ${role.name} CASCADE`, []).catch(() => undefined);
	await owner.query(`DROP ROLE IF EXISTS ${role.name}`, []).catch(() => undefined);
}
