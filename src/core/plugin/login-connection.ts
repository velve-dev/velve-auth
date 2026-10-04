import { VelveStartupError } from "../auth/startup.js";
import type { Driver } from "../db/driver.js";
import { PLUGIN_LEDGER_TABLE } from "../db/migration.js";
import { coreTableNameSet } from "../db/migrations/index.js";
import type { Clock } from "../http/environment.js";
import { assertPluginDatabaseRole } from "./database-role.js";

class PluginLoginUncheckedError extends Error {
	readonly code = "plugin_database_unchecked";

	constructor() {
		super(
			"the plugin login cannot be checked before the core tables exist, so plugin SQL waits until migrate() has run",
		);
		this.name = "PluginLoginUncheckedError";
	}
}

const LOGIN_OF_THE_LIBRARY = "SELECT current_user AS role";

//a remembered pass is asked again after this long so a later grant is seen without a restart (E-2647)
const RECHECK_AFTER_MILLISECONDS = 5 * 60 * 1000;

//every role the login can become is asked so a superuser and an inherited grant count too (E-2641)
const WHAT_THE_PLUGIN_LOGIN_REACHES = `
WITH reachable AS (
  SELECT role_.oid, role_.rolcreaterole
  FROM pg_roles role_
  WHERE pg_has_role(current_user, role_.oid, 'MEMBER')
),
core AS (
  SELECT table_.oid, table_.relname
  FROM pg_class table_
  JOIN pg_namespace schema_ ON schema_.oid = table_.relnamespace
  WHERE schema_.nspname = $2 AND table_.relname = ANY (string_to_array($3, ','))
),
creatable AS (
  SELECT schema_.oid FROM pg_namespace schema_ WHERE schema_.nspname IN ($2, 'public')
)
SELECT current_user AS role,
  pg_has_role(current_user, $1::name, 'MEMBER') AS becomes_the_library,
  EXISTS (
    SELECT 1 FROM pg_namespace schema_
    WHERE schema_.nspname = $2 AND pg_has_role(current_user, schema_.nspowner, 'MEMBER')
  ) AS owns_the_schema,
  EXISTS (SELECT 1 FROM reachable WHERE reachable.rolcreaterole) AS creates_roles,
  EXISTS (
    SELECT 1 FROM reachable CROSS JOIN creatable
    WHERE has_schema_privilege(reachable.oid, creatable.oid, 'CREATE')
  ) AS creates_in_a_searched_schema,
  EXISTS (
    SELECT 1 FROM reachable CROSS JOIN core
    WHERE has_table_privilege(
        reachable.oid,
        core.oid,
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
      )
      OR has_any_column_privilege(reachable.oid, core.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
  ) AS reaches_a_core_table,
  (SELECT count(*)::int FROM core WHERE core.relname <> $4) AS core_tables_found`;

interface PluginLoginReach {
	readonly role: string;
	readonly becomes_the_library: boolean;
	readonly owns_the_schema: boolean;
	readonly creates_roles: boolean;
	readonly creates_in_a_searched_schema: boolean;
	readonly reaches_a_core_table: boolean;
	readonly core_tables_found: number;
}

export interface PluginConnection {
	readonly driver: Driver;
	/** checks the plugin login against the core tables as they stand now, and resolves to its role */
	verifyFrom(library: Driver): Promise<string>;
	/** resolves to the plugin login's role, checking it first unless a recent check has passed */
	verifiedFrom(library: Driver): Promise<string>;
}

function reachesTheCore(reach: PluginLoginReach): boolean {
	return (
		reach.becomes_the_library ||
		reach.owns_the_schema ||
		reach.creates_roles ||
		reach.creates_in_a_searched_schema ||
		reach.reaches_a_core_table
	);
}

//the plugin ledger exists only once a plugin migration has run and is not required (E-2646)
function requiredCoreTableCount(): number {
	return [...coreTableNameSet()].filter((table) => table !== PLUGIN_LEDGER_TABLE).length;
}

async function assertTheLoginIsSeparate(
	library: Driver,
	plugin: Driver,
	schema: string,
): Promise<string> {
	const [libraryLogin] = await library.query<{ role: string }>(LOGIN_OF_THE_LIBRARY, []);
	const [reach] = await plugin.query<PluginLoginReach>(WHAT_THE_PLUGIN_LOGIN_REACHES, [
		libraryLogin?.role ?? "",
		schema,
		[...coreTableNameSet()].join(","),
		PLUGIN_LEDGER_TABLE,
	]);
	if (reach === undefined || reachesTheCore(reach)) {
		throw new VelveStartupError("plugin_database_reaches_the_core");
	}
	//a check that found no core table measured nothing and must not pass (E-2646)
	if (reach.core_tables_found < requiredCoreTableCount()) {
		throw new PluginLoginUncheckedError();
	}
	return assertPluginDatabaseRole(reach.role);
}

interface RememberedPass {
	readonly role: Promise<string>;
	readonly askedAt: number;
}

//a failed check is asked again and never remembered as passed (E-2641)
export function createPluginConnection(options: {
	readonly driver: Driver;
	readonly schema: string;
	readonly clock: Clock;
}): PluginConnection {
	let remembered: RememberedPass | undefined;
	const verifyFrom = (library: Driver): Promise<string> => {
		const checking = assertTheLoginIsSeparate(library, options.driver, options.schema);
		const pass = { role: checking, askedAt: options.clock.now().getTime() };
		remembered = pass;
		checking.catch(() => {
			if (remembered === pass) {
				remembered = undefined;
			}
		});
		return checking;
	};
	const isRecent = (pass: RememberedPass): boolean =>
		options.clock.now().getTime() - pass.askedAt < RECHECK_AFTER_MILLISECONDS;
	return Object.freeze({
		driver: options.driver,
		verifyFrom,
		verifiedFrom: (library: Driver): Promise<string> =>
			remembered !== undefined && isRecent(remembered) ? remembered.role : verifyFrom(library),
	});
}
