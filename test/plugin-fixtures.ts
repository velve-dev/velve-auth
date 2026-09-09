import type { Driver } from "../src/core/db/driver.js";
import type { RequestContext } from "../src/core/http/route.js";
import { object } from "../src/core/http/validators.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";

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

const MIGRATION_ROLE = "velve_plugin_migrator";

/**
 * The runner refuses a plugin migration on a superuser connection, and the test connection is one.
 * The role is made the **owner** of the schema and of everything in it, which is the deployment
 * shape the refusal assumes: a role that can drop a core index and does not, because the runner
 * refuses it. Granting privileges instead would have PostgreSQL refuse the statement first, and the
 * test would then prove the grant rather than the measurement (E-920).
 */
export async function grantTheMigrationRole(driver: Driver, schema: string): Promise<void> {
	const [existing] = await driver.query<{ present: number }>(
		"SELECT 1 AS present FROM pg_roles WHERE rolname = $1",
		[MIGRATION_ROLE],
	);
	if (existing === undefined) {
		await driver.query(`CREATE ROLE ${MIGRATION_ROLE} NOLOGIN`, []).catch(() => undefined);
	}
	const [database] = await driver.query<{ name: string }>("SELECT current_database() AS name", []);
	await driver.query(`GRANT ${MIGRATION_ROLE} TO CURRENT_USER`, []).catch(() => undefined);
	await driver.query(`GRANT CREATE ON DATABASE "${database?.name}" TO ${MIGRATION_ROLE}`, []);
	// Same reason as the ownership handover: the runner has to be what refuses a table created in
	// another schema, and a role that cannot create one there would refuse it first.
	await driver.query(`GRANT CREATE ON SCHEMA public TO ${MIGRATION_ROLE}`, []);
	await driver.query(
		`DO $handover$
		DECLARE owned record;
		BEGIN
			EXECUTE format('ALTER SCHEMA %I OWNER TO %I', '${schema}', '${MIGRATION_ROLE}');
			FOR owned IN
				SELECT child.oid AS id FROM pg_class child
				JOIN pg_namespace namespace_ ON namespace_.oid = child.relnamespace
				WHERE namespace_.nspname = '${schema}' AND child.relkind IN ('r', 'p')
			LOOP
				EXECUTE format('ALTER TABLE %s OWNER TO %I', owned.id::regclass, '${MIGRATION_ROLE}');
			END LOOP;
			FOR owned IN
				SELECT routine.oid AS id FROM pg_proc routine
				JOIN pg_namespace namespace_ ON namespace_.oid = routine.pronamespace
				WHERE namespace_.nspname = '${schema}'
			LOOP
				EXECUTE format('ALTER FUNCTION %s OWNER TO %I', owned.id::regprocedure, '${MIGRATION_ROLE}');
			END LOOP;
		END
		$handover$`,
		[],
	);
}

/** Holds the role for a whole schema's lifetime, for a file whose assertions the role may make too. */
export async function enterTheMigrationRole(driver: Driver, schema: string): Promise<void> {
	await grantTheMigrationRole(driver, schema);
	await driver.query(`SET ROLE ${MIGRATION_ROLE}`, []);
}

export async function leaveTheMigrationRole(driver: Driver): Promise<void> {
	await driver.query("RESET ROLE", []);
}

/** Runs one migration attempt under that role, so the connection is the shape a deployment has. */
export async function asMigrationRole<T>(driver: Driver, run: () => Promise<T>): Promise<T> {
	await driver.query(`SET ROLE ${MIGRATION_ROLE}`, []);
	try {
		return await run();
	} finally {
		await driver.query("RESET ROLE", []);
	}
}
