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
	/** The seven points as they were read at the start, so no accessor answers twice (E-900). */
	readonly hooks: PluginHooks;
	readonly context: FrozenContext;
	/** What a `beforeSessionRevoke` hook is handed: the same context without the re-announcement. */
	readonly contextInsideARevocation: FrozenContext;
}

/** The seven fields 3.15 G enumerates, and the seven hook points of 3.11. Nothing else is read. */
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

/**
 * Every property name the object answers to: its own, enumerable or not, and every one it inherits
 * short of `Object.prototype`. `Object.keys` sees neither, and a plugin authored as a class carries
 * its methods on a prototype — which is the most ordinary way to write one and was accepted (E-901).
 */
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
	// Every prototype carries it, and nothing here reads it.
	names.delete("constructor");
	return [...names];
}

/**
 * S-CSRF-6 and T-CSRF-6: a plugin from JavaScript can carry any field, and dropping the ones the
 * interface does not enumerate leaves its author believing a middleware of theirs runs ahead of the
 * origin check. The extension points are enumerated (3.11), so an unenumerated one is a start error.
 */
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

/**
 * S-DEFAULT-5: two distinct ids can still claim one table. `a` and `a_b` both own `a_b_thing` —
 * the first by its prefix, the second by its own — and each would reach the other's rows through
 * `ownTables.query` (E-642).
 */
function assertNoTablePrefixContainsAnother(plugins: readonly VelvePlugin[]): void {
	for (const plugin of plugins) {
		for (const other of plugins) {
			if (other.id !== plugin.id && other.id.startsWith(`${plugin.id}_`)) {
				throw new VelveStartupError("plugin_table_prefix_conflict");
			}
		}
	}
}

/** E-742: 3.11 makes only a cycle a start error; a dependency on a plugin nobody configured is one here too. */
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

/** 3.11: `dependsOn` is sorted topologically and a cycle is a start error, not a warning. */
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

/** T-OWNER-11: the side that already held the claim is one contributor and the one arriving is the other. */
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

/** 3.11: a plugin cannot overwrite a core route, and a name collision is a start error. */
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

/**
 * The type refuses these three; this is the half that holds for a plugin written in JavaScript,
 * which is where 3.15 G puts the runtime check (E-764). The caller requirement is passed in rather
 * than read here, because reading it twice is the fault this whole pass exists to remove (E-900).
 */
function assertNoRouteReadsACoreCookie(declaration: ContributedDeclaration, caller: unknown): void {
	const declared = declaration as unknown as Readonly<Record<string, unknown>>;
	// `in` beside the value, because a plugin from JavaScript may carry the field on a prototype and
	// the reading below is what a prototype would otherwise reach the handler through (E-781, E-666).
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

/**
 * Every field of a plugin's route declaration, read **once**, into a plain object nothing else can
 * change. The declaration is a JavaScript object a plugin wrote, so a property of it may be an
 * accessor: the checks below read it and `defineRoute` read it again, and nothing obliged the two
 * reads to answer the same way — a getter returning `"checked"` and then `"exempt"` mounted a route
 * the origin check skipped (E-900). Reading by property access rather than copying own properties
 * is what keeps a field a plugin carries on a prototype reaching `defineRoute` (E-666, E-781).
 */
function asOneReading(
	declaration: ContributedDeclaration,
	rules: Readonly<Record<string, RateLimitRule>>,
): ContributedDeclaration {
	const caller = declaration.caller;
	const input = declaration.input;
	// `name` was the tenth field and the one exception: read once to look the rule up and once to
	// copy it, so a route could mount under one name carrying the bucket declared for another (E-910).
	const name = declaration.name;
	const rule = rules[name];
	// The reading carries no cookie field, so this is the last place the declaration's own is visible.
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

/** The keys of a record a plugin wrote, its prototype included, so the map is read the way it is applied (E-902). */
function plainRecordOf<Value>(source: Readonly<Record<string, Value>>): Record<string, Value> {
	const plain: Record<string, Value> = {};
	for (const key of everyReachableName(source)) {
		if (typeof key === "string") {
			plain[key] = source[key] as Value;
		}
	}
	return plain;
}

/** The seven hook points, read once each, so what the dispatcher runs is what the start looked at. */
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

/**
 * The whole plugin as plain data: every field read once, every structure the library reads twice
 * copied. Everything past this line — the checks, the routes, the migrations, the dispatcher —
 * reads this and never the object the application handed over (E-900).
 */
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

/**
 * S-CSRF-6, S-CSRF-1: the OAuth callback is the one route without the origin check, and a plugin
 * route is not it. A declaration that says anything else — `"exempt"`, or nothing at all, which the
 * pipeline reads as not checked — is a start error and not a route (E-639).
 */
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

/**
 * S-DEFAULT-5: an error code carries the id of the plugin that owns it, so two plugins cannot
 * answer for one code. The namespace is a type in 3.15 G; this is the half a JavaScript plugin
 * meets (E-643).
 */
function assertEveryErrorCodeIsItsOwn(plugin: VelvePlugin): void {
	for (const code of plugin.errorCodes ?? []) {
		if (!code.startsWith(`${plugin.id}.`)) {
			throw new VelveStartupError("plugin_error_code_not_namespaced");
		}
	}
}

/**
 * 3.15 D.1 makes `errors` a contract, and a code the plugin never declared answers `internal_error`
 * with none of the route's meaning left in it — so the contract is checked at the start rather than
 * discovered by the caller (E-644).
 */
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

/**
 * 3.15 G keys a rule on a route name and 3.15 D.1 puts a rule in the route's own declaration; the
 * map wins, and it may only name a route the plugin contributes — so no rule of a plugin's reaches
 * a core route's bucket, and a mistyped key is refused rather than silently limiting nothing (E-645).
 */
function assertEveryRateLimitRuleNamesAContributedRoute(plugin: VelvePlugin): void {
	const contributed = new Set<string>((plugin.routes ?? []).map((route) => route.name));
	for (const name of Object.keys(plugin.rateLimitRules ?? {})) {
		if (!contributed.has(name)) {
			throw new VelveStartupError("plugin_rate_limit_rule_unmatched");
		}
	}
}

/**
 * S-DEFAULT-5: a table a plugin declares carries the plugin's own prefix. What the migration
 * actually created is measured by the runner; this refuses the declaration before a statement runs.
 */
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
	// The list is a value the application wrote too, and indexing it twice let one index answer a
	// clean plugin to the field check and one carrying a middleware to the reading (E-910).
	const declared = [...options.plugins];
	assertNoFieldOutsideTheInterface(declared);
	// E-900: from here on the declaration is data, and every check below reads the same value the
	// route table, the runner and the dispatcher will.
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
	// The array is filled below and read only when a hook runs, so the announcement can name the
	// dispatcher that will run the plugins the announcement is being built for.
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

	// E-740: the context a route gets is recorded against the route object, not read out of its name.
	const contextByRoute = new WeakMap<RouteMetadata, FrozenContext>();
	// E-740 again, for T-OWNER-11: a conflicting route's contributor is recorded here rather than
	// read back out of its name, which a plugin written in JavaScript need not have namespaced yet.
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
