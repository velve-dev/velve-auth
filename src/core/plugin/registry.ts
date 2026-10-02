import { type RouteConflict, THE_CORE, VelveStartupError } from "../auth/startup.js";
import type { OwnedMigration } from "../db/migration.js";
import { namesTableOfPlugin } from "../db/migrations/index.js";
import { type AnyErrorCode, type PluginErrorCode, VELVE_ERROR_CODES } from "../http/error-map.js";
import type { BucketRule, RateLimitRule } from "../http/rate-limit.js";
import {
	type AnyRoute,
	defineRoute,
	type RouteDeclaration,
	type RouteMetadata,
} from "../http/route.js";
import type {
	FrozenContext,
	PluginHooks,
	PluginMigration,
	PluginRoute,
	SessionCreatedEvent,
	SessionCreateEvent,
	SessionRevokeEvent,
	SignInCompletedEvent,
	SignInEvent,
	UserCreatedEvent,
	UserCreateEvent,
	VelvePlugin,
} from "./config.js";
import {
	createCoreContext,
	createPluginContext,
	type FrozenContextServices,
	type RevocationAnnouncement,
	SILENT_REVOCATION,
} from "./context.js";

/**
 * 3.11: a hook may refuse by throwing and observe by returning, and it cannot replace the answer
 * because it cannot return one. Each of the seven runs every plugin in dependency order.
 */
export interface PluginHookDispatcher {
	beforeSignIn(event: SignInEvent): Promise<void>;
	afterSignIn(event: SignInCompletedEvent): Promise<void>;
	beforeSessionCreate(event: SessionCreateEvent): Promise<void>;
	afterSessionCreate(event: SessionCreatedEvent): Promise<void>;
	beforeUserCreate(event: UserCreateEvent): Promise<void>;
	afterUserCreate(event: UserCreatedEvent): Promise<void>;
	beforeSessionRevoke(event: SessionRevokeEvent): Promise<void>;
}

export interface PluginRuntime {
	/** The configured plugins in dependency order, which is the order every hook point runs them in. */
	readonly plugins: readonly VelvePlugin[];
	readonly routes: readonly AnyRoute[];
	/** 3.11: the same versioned runner, in the same dependency order, each under its own id (E-635). */
	readonly migrations: readonly OwnedMigration[];
	/**
	 * The codes every configured plugin declares. They are published to the process-wide registry by
	 * the assembly and not here, because a start that refuses after this returns must leave nothing
	 * behind (E-665).
	 */
	readonly declaredErrorCodes: readonly PluginErrorCode[];
	readonly hooks: PluginHookDispatcher;
	contextOf(route: RouteMetadata): FrozenContext;
	/** Which plugin contributed a route, so a start error can name it as a contributor (T-OWNER-11). */
	ownerOf(route: RouteMetadata): string;
	/** Whether any plugin listens at a point, so a caller can skip the work an event costs to build. */
	listensTo(point: keyof PluginHooks): boolean;
}

interface RegisteredPlugin {
	readonly plugin: VelvePlugin;
	//each hook point must be read once at the start and never again (E-900)
	readonly hooks: PluginHooks;
	readonly context: FrozenContext;
	//a revoke hook gets a context that cannot announce its own revocation (E-641)
	readonly contextInsideARevocation: FrozenContext;
}

//nothing outside the enumerated plugin fields and hook points may be read
const DECLARED_PLUGIN_FIELDS: readonly string[] = [
	"id",
	"dependsOn",
	"migrations",
	"routes",
	"hooks",
	"errorCodes",
	"rateLimitRules",
];

const HOOK_POINTS: readonly (keyof PluginHooks)[] = [
	"beforeSignIn",
	"afterSignIn",
	"beforeSessionCreate",
	"afterSessionCreate",
	"beforeUserCreate",
	"afterUserCreate",
	"beforeSessionRevoke",
];

//a plugin written as a class carries its methods on a prototype and must be read (E-901)
function everyReachableName(value: object): readonly (string | symbol)[] {
	const names = new Set<string | symbol>();
	for (
		let current: object | null = value;
		current !== null && current !== Object.prototype;
		current = Object.getPrototypeOf(current) as object | null
	) {
		for (const key of Reflect.ownKeys(current)) {
			names.add(key);
		}
	}
	//every prototype carries a constructor and nothing here reads it
	names.delete("constructor");
	return [...names];
}

//an unenumerated plugin field must be a start error and not silently dropped (S-CSRF-6)
function assertNoFieldOutsideTheInterface(plugins: readonly VelvePlugin[]): void {
	const declared = new Set<string | symbol>(DECLARED_PLUGIN_FIELDS);
	const points = new Set<string | symbol>(HOOK_POINTS);
	for (const plugin of plugins) {
		for (const field of everyReachableName(plugin)) {
			if (!declared.has(field)) {
				throw new VelveStartupError("plugin_field_unknown");
			}
		}
		const hooks: object = plugin.hooks ?? {};
		for (const point of everyReachableName(hooks)) {
			if (!points.has(point)) {
				throw new VelveStartupError("plugin_field_unknown");
			}
		}
	}
}

function assertNoIdIsTakenTwice(plugins: readonly VelvePlugin[]): void {
	const seen = new Set<string>();
	for (const plugin of plugins) {
		if (seen.has(plugin.id)) {
			throw new VelveStartupError("plugin_id_duplicated");
		}
		seen.add(plugin.id);
	}
}

//two plugin ids must not claim one table through overlapping prefixes (E-642)
function assertNoTablePrefixContainsAnother(plugins: readonly VelvePlugin[]): void {
	for (const plugin of plugins) {
		for (const other of plugins) {
			if (other.id !== plugin.id && other.id.startsWith(`${plugin.id}_`)) {
				throw new VelveStartupError("plugin_table_prefix_conflict");
			}
		}
	}
}

//a dependency on a plugin nobody configured must be a start error too (E-742)
function assertEveryDependencyIsRegistered(plugins: readonly VelvePlugin[]): void {
	const registered = new Set(plugins.map((plugin) => plugin.id));
	for (const plugin of plugins) {
		for (const dependency of plugin.dependsOn ?? []) {
			if (!registered.has(dependency)) {
				throw new VelveStartupError("plugin_dependency_missing");
			}
		}
	}
}

//a dependency cycle must be a start error and not a warning
function inDependencyOrder(plugins: readonly VelvePlugin[]): readonly VelvePlugin[] {
	const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
	const settled = new Set<string>();
	const onThePath = new Set<string>();
	const ordered: VelvePlugin[] = [];

	function visit(plugin: VelvePlugin): void {
		if (settled.has(plugin.id)) {
			return;
		}
		if (onThePath.has(plugin.id)) {
			throw new VelveStartupError("plugin_dependency_cycle");
		}
		onThePath.add(plugin.id);
		for (const dependency of plugin.dependsOn ?? []) {
			const required = byId.get(dependency);
			if (required !== undefined) {
				visit(required);
			}
		}
		onThePath.delete(plugin.id);
		settled.add(plugin.id);
		ordered.push(plugin);
	}

	for (const plugin of plugins) {
		visit(plugin);
	}
	return ordered;
}

function foldedPath(route: RouteMetadata): string {
	return `${route.method} ${route.path}`;
}

//a route conflict must name both the side holding the claim and the one arriving
function claimOrRefuseTheStart(
	claimants: Map<string, string>,
	claimed: string,
	arriving: string,
): void {
	const held = claimants.get(claimed);
	if (held !== undefined) {
		const conflict: RouteConflict = { claimed, contributors: [held, arriving] };
		throw new VelveStartupError("plugin_route_conflict", conflict);
	}
	claimants.set(claimed, arriving);
}

//a plugin must not overwrite a core route and a name collision is a start error
export function assertNoCoreRouteIsOverwritten(
	contributed: readonly AnyRoute[],
	core: readonly AnyRoute[],
	ownerOf: (route: RouteMetadata) => string,
): void {
	const names = new Map(core.map((route) => [route.name, THE_CORE]));
	const paths = new Map(core.map((route) => [foldedPath(route), THE_CORE]));
	for (const route of contributed) {
		const arriving = ownerOf(route);
		claimOrRefuseTheStart(names, route.name, arriving);
		claimOrRefuseTheStart(paths, foldedPath(route), arriving);
	}
}

const COOKIE_FIELDS_A_PLUGIN_MAY_NOT_DECLARE: readonly string[] = [
	"pendingCookie",
	"oauthStateCookie",
];

type ContributedDeclaration = RouteDeclaration<string, string, unknown, unknown, AnyErrorCode>;

//a plugin written in javascript must meet the core cookie check at run time (E-764)
function assertNoRouteReadsACoreCookie(declaration: ContributedDeclaration, caller: unknown): void {
	const declared = declaration as unknown as Readonly<Record<string, unknown>>;
	//a cookie field carried on a prototype must be caught as well (E-781)
	const reaches = COOKIE_FIELDS_A_PLUGIN_MAY_NOT_DECLARE.some(
		(field) => field in declared || declared[field] !== undefined,
	);
	if (reaches || caller === "pending") {
		throw new VelveStartupError("plugin_route_reads_a_core_cookie");
	}
}

function bucketRuleOf(rule: BucketRule | "none"): BucketRule | "none" {
	return rule === "none"
		? "none"
		: { capacity: rule?.capacity, refillPerSecond: rule?.refillPerSecond };
}

function rateLimitRuleOf(rule: RateLimitRule): RateLimitRule {
	return {
		perIpAddress: bucketRuleOf(rule?.perIpAddress),
		perAccount: bucketRuleOf(rule?.perAccount),
	};
}

//every route field must be read once as an accessor may answer differently twice (E-900)
function asOneReading(
	declaration: ContributedDeclaration,
	rules: Readonly<Record<string, RateLimitRule>>,
): ContributedDeclaration {
	const caller = declaration.caller;
	const input = declaration.input;
	//the name must be read once or a route can mount with the bucket of another (E-911)
	const name = declaration.name;
	const rule = rules[name];
	//the cookie check must run here as the reading carries no cookie field
	assertNoRouteReadsACoreCookie(declaration, caller);
	return {
		name,
		method: declaration.method,
		path: declaration.path,
		input: { fields: [...input.fields], parse: (raw) => input.parse(raw) },
		errors: [...declaration.errors],
		caller,
		freshness: declaration.freshness,
		originCheck: declaration.originCheck,
		rateLimit: rateLimitRuleOf(rule ?? declaration.rateLimit),
		handler: declaration.handler,
	};
}

//a record a plugin wrote must be read with its prototype the way it is applied (E-902)
function plainRecordOf<Value>(source: Readonly<Record<string, Value>>): Record<string, Value> {
	const plain: Record<string, Value> = {};
	for (const key of everyReachableName(source)) {
		if (typeof key === "string") {
			plain[key] = source[key] as Value;
		}
	}
	return plain;
}

//the dispatcher must run the hooks the start looked at and nothing read later (E-900)
function hooksOf(hooks: PluginHooks | undefined): PluginHooks {
	const plain: Record<string, unknown> = {};
	for (const point of HOOK_POINTS) {
		const listener = hooks?.[point];
		if (listener !== undefined) {
			plain[point] = listener;
		}
	}
	return plain as PluginHooks;
}

//everything past this reads plain data and never the object the application handed over (E-900)
function asOneReadingOfThePlugin(plugin: VelvePlugin): VelvePlugin {
	const rules = plainRecordOf<RateLimitRule>(plugin.rateLimitRules ?? {});
	return {
		id: plugin.id,
		dependsOn: [...(plugin.dependsOn ?? [])],
		migrations: (plugin.migrations ?? []).map((migration) => ({
			version: migration.version,
			name: migration.name,
			sql: migration.sql,
			createsTables: [...migration.createsTables],
		})),
		routes: (plugin.routes ?? []).map((declaration) =>
			asOneReading(declaration as ContributedDeclaration, rules),
		) as readonly PluginRoute<string>[],
		hooks: hooksOf(plugin.hooks),
		errorCodes: [...(plugin.errorCodes ?? [])],
		rateLimitRules: rules,
	};
}

//a plugin route must never exempt itself from the origin check (E-639)
function assertNoRouteExemptsItselfFromTheOriginCheck(plugin: VelvePlugin): void {
	for (const declaration of plugin.routes ?? []) {
		if ((declaration as Readonly<Record<string, unknown>>).originCheck !== "checked") {
			throw new VelveStartupError("plugin_route_exempts_the_origin_check");
		}
	}
}

function isCoreErrorCode(code: AnyErrorCode): boolean {
	return (VELVE_ERROR_CODES as readonly string[]).includes(code);
}

//a plugin error code must carry the id of the plugin that owns it (E-643)
function assertEveryErrorCodeIsItsOwn(plugin: VelvePlugin): void {
	for (const code of plugin.errorCodes ?? []) {
		if (!code.startsWith(`${plugin.id}.`)) {
			throw new VelveStartupError("plugin_error_code_not_namespaced");
		}
	}
}

//an undeclared route error must fail the start rather than surprise the caller (E-644)
function assertEveryRouteErrorIsDeclared(plugin: VelvePlugin): void {
	const declared = new Set<string>(plugin.errorCodes ?? []);
	for (const route of plugin.routes ?? []) {
		for (const code of route.errors) {
			if (!isCoreErrorCode(code) && !declared.has(code)) {
				throw new VelveStartupError("plugin_error_code_undeclared");
			}
		}
	}
}

//a rate limit rule may only name a route the plugin itself contributes (E-645)
function assertEveryRateLimitRuleNamesAContributedRoute(plugin: VelvePlugin): void {
	const contributed = new Set<string>((plugin.routes ?? []).map((route) => route.name));
	for (const name of Object.keys(plugin.rateLimitRules ?? {})) {
		if (!contributed.has(name)) {
			throw new VelveStartupError("plugin_rate_limit_rule_unmatched");
		}
	}
}

//a table a plugin declares must carry the plugin's own prefix (S-DEFAULT-5)
function assertEveryDeclaredTableIsItsOwn(plugin: VelvePlugin): void {
	for (const migration of plugin.migrations ?? []) {
		for (const table of migration.createsTables) {
			if (!namesTableOfPlugin(table, plugin.id)) {
				throw new VelveStartupError("plugin_migration_table_not_prefixed");
			}
		}
	}
}

function ownedMigrationsOf(plugins: readonly VelvePlugin[]): readonly OwnedMigration[] {
	return plugins.flatMap((plugin) =>
		(plugin.migrations ?? []).map((migration: PluginMigration<string>) => ({
			version: migration.version,
			name: migration.name,
			sql: migration.sql,
			owner: plugin.id,
			createsTables: [...migration.createsTables],
		})),
	);
}

function routesOf(plugin: VelvePlugin): readonly AnyRoute[] {
	assertNoRouteExemptsItselfFromTheOriginCheck(plugin);
	return (plugin.routes ?? []).map((declaration) =>
		defineRoute(declaration as ContributedDeclaration),
	);
}

function dispatcher(registered: readonly RegisteredPlugin[]): PluginHookDispatcher {
	async function run<Event>(
		hook: (
			hooks: PluginHooks,
		) => ((event: Event, context: FrozenContext) => Promise<void>) | undefined,
		event: Event,
		contextOf: (entry: RegisteredPlugin) => FrozenContext = (entry) => entry.context,
	): Promise<void> {
		for (const entry of registered) {
			const listener = hook(entry.hooks);
			if (listener !== undefined) {
				await listener(event, contextOf(entry));
			}
		}
	}

	return {
		beforeSignIn: (event) => run((hooks) => hooks.beforeSignIn, event),
		afterSignIn: (event) => run((hooks) => hooks.afterSignIn, event),
		beforeSessionCreate: (event) => run((hooks) => hooks.beforeSessionCreate, event),
		afterSessionCreate: (event) => run((hooks) => hooks.afterSessionCreate, event),
		beforeUserCreate: (event) => run((hooks) => hooks.beforeUserCreate, event),
		afterUserCreate: (event) => run((hooks) => hooks.afterUserCreate, event),
		beforeSessionRevoke: (event) =>
			run(
				(hooks) => hooks.beforeSessionRevoke,
				event,
				(entry) => entry.contextInsideARevocation,
			),
	};
}

export function createPluginRuntime(options: {
	readonly plugins: readonly VelvePlugin[];
	readonly services: FrozenContextServices;
}): PluginRuntime {
	//the plugin list must be copied once or two reads can see different plugins (E-911)
	const declared = [...options.plugins];
	assertNoFieldOutsideTheInterface(declared);
	//every check below must read the same data the routes, runner and dispatcher will (E-900)
	const plugins = declared.map(asOneReadingOfThePlugin);
	assertNoIdIsTakenTwice(plugins);
	assertNoTablePrefixContainsAnother(plugins);
	assertEveryDependencyIsRegistered(plugins);
	for (const plugin of plugins) {
		assertEveryErrorCodeIsItsOwn(plugin);
		assertEveryRouteErrorIsDeclared(plugin);
		assertEveryRateLimitRuleNamesAContributedRoute(plugin);
		assertEveryDeclaredTableIsItsOwn(plugin);
	}
	const ordered = inDependencyOrder(plugins);

	const registered: RegisteredPlugin[] = [];
	const hooks = dispatcher(registered);
	const listensTo = (point: keyof PluginHooks): boolean =>
		registered.some((entry) => entry.hooks[point] !== undefined);
	//the array is read only when a hook runs and may be filled after the announcement exists
	const revocation: RevocationAnnouncement = {
		announce: (event) => hooks.beforeSessionRevoke(event),
		get listened() {
			return listensTo("beforeSessionRevoke");
		},
	};

	for (const plugin of ordered) {
		registered.push({
			plugin,
			hooks: plugin.hooks ?? {},
			context: createPluginContext(options.services, plugin.id, revocation),
			contextInsideARevocation: createPluginContext(options.services, plugin.id, SILENT_REVOCATION),
		});
	}
	const coreContext = createCoreContext(options.services, revocation);

	//a route's context must be recorded against the route object and not its name (E-740)
	const contextByRoute = new WeakMap<RouteMetadata, FrozenContext>();
	//a route's contributor must be recorded and not read back out of its name (E-740)
	const ownerByRoute = new WeakMap<RouteMetadata, string>();
	const routes: AnyRoute[] = [];
	for (const entry of registered) {
		for (const route of routesOf(entry.plugin)) {
			contextByRoute.set(route, entry.context);
			ownerByRoute.set(route, entry.plugin.id);
			routes.push(route);
		}
	}
	return {
		plugins: ordered,
		routes,
		migrations: ownedMigrationsOf(ordered),
		declaredErrorCodes: ordered.flatMap(
			(plugin) => (plugin.errorCodes ?? []) as readonly PluginErrorCode[],
		),
		hooks,
		contextOf: (route) => contextByRoute.get(route) ?? coreContext,
		ownerOf: (route) => ownerByRoute.get(route) ?? THE_CORE,
		listensTo,
	};
}
