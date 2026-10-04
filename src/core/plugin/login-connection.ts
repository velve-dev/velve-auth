import { VelveStartupError } from "../auth/startup.js";
import type { Driver } from "../db/driver.js";
import { coreTableNameSet } from "../db/migrations/index.js";
import { assertPluginDatabaseRole } from "./database-role.js";

const LOGIN_OF_THE_LIBRARY = "SELECT current_user AS role";

//every role the login can become is asked so a superuser and an inherited grant count too (E-2641)
const WHAT_THE_PLUGIN_LOGIN_REACHES = `
SELECT current_user AS role,
  pg_has_role(current_user, $1::name, 'MEMBER') AS becomes_the_library,
  EXISTS (
    SELECT 1 FROM pg_namespace schema_
    WHERE schema_.nspname = $2 AND pg_has_role(current_user, schema_.nspowner, 'MEMBER')
  ) AS owns_the_schema,
  EXISTS (
    SELECT 1
    FROM pg_roles reachable
    CROSS JOIN pg_class core
    JOIN pg_namespace schema_ ON schema_.oid = core.relnamespace
    WHERE pg_has_role(current_user, reachable.oid, 'MEMBER')
      AND schema_.nspname = $2
      AND core.relname = ANY (string_to_array($3, ','))
      AND has_table_privilege(
        reachable.oid,
        core.oid,
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
      ) /* no owner predicate: S-OWNER-10 names privileges and changes no row */
  ) AS reaches_a_core_table`;

interface PluginLoginReach {
	readonly role: string;
	readonly becomes_the_library: boolean;
	readonly owns_the_schema: boolean;
	readonly reaches_a_core_table: boolean;
}

export interface PluginConnection {
	readonly driver: Driver;
	/** checks the plugin login against the core tables as they stand now, and resolves to its role */
	verifyFrom(library: Driver): Promise<string>;
	/** resolves to the plugin login's role, checking it first unless a check has already passed */
	verifiedFrom(library: Driver): Promise<string>;
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
	]);
	if (
		reach === undefined ||
		reach.becomes_the_library ||
		reach.owns_the_schema ||
		reach.reaches_a_core_table
	) {
		throw new VelveStartupError("plugin_database_reaches_the_core");
	}
	return assertPluginDatabaseRole(reach.role);
}

//a failed check is asked again and never remembered as passed (E-2641)
export function createPluginConnection(options: {
	readonly driver: Driver;
	readonly schema: string;
}): PluginConnection {
	let verified: Promise<string> | undefined;
	const verifyFrom = (library: Driver): Promise<string> => {
		const checking = assertTheLoginIsSeparate(library, options.driver, options.schema);
		verified = checking;
		checking.catch(() => {
			if (verified === checking) {
				verified = undefined;
			}
		});
		return checking;
	};
	return Object.freeze({
		driver: options.driver,
		verifyFrom,
		verifiedFrom: (library: Driver): Promise<string> => verified ?? verifyFrom(library),
	});
}
