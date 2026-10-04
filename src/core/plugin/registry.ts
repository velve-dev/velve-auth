import { type RouteConflict, THE_CORE, VelveStartupError } from "../auth/startup.js";
import { createUserRepository } from "../auth/user.js";
import type { Driver } from "../db/driver.js";
import { assertIdentifier, InvalidIdentifierError } from "../db/identifier.js";
import type { OwnedMigration } from "../db/migration.js";
import { namesTableOfPlugin } from "../db/migrations/index.js";
import { createSessionRepository } from "../db/repositories/session.js";
import { type AnyErrorCode, type PluginErrorCode, VELVE_ERROR_CODES } from "../http/error-map.js";
import { type BucketRule, isUsableBucketRule, type RateLimitRule } from "../http/rate-limit.js";
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

/** runs each hook point over every plugin in dependency order, a hook refusing by throwing */
export interface PluginHookDispatcher {
	beforeSignIn(event: SignInEvent): Promise<void>;
	afterSignIn(event: SignInCompletedEvent): Promise<void>;
	beforeSessionCreate(event: SessionCreateEvent): Promise<void>;
	afterSessionCreate(event: SessionCreatedEvent): Promise<void>;
	beforeUserCreate(event: UserCreateEvent): Promise<void>;
	afterUserCreate(event: UserCreatedEvent): Promise<void>;
	/** a `transaction` runs every hook on that transaction's connection and not on the pool's */
	beforeSessionRevoke(event: SessionRevokeEvent, transaction?: Driver): Promise<void>;
}

export interface PluginRuntime {
	/** the configured plugins in dependency order, the order every hook point runs them in */
	readonly plugins: readonly VelvePlugin[];
	readonly routes: readonly AnyRoute[];
	/** each plugin's migrations, run in dependency order under its own id */
	readonly migrations: readonly OwnedMigration[];
	/** the error codes every configured plugin declares */
	readonly declaredErrorCodes: readonly PluginErrorCode[];
	readonly hooks: PluginHookDispatcher;
	contextOf(route: RouteMetadata): FrozenContext;
	/** which plugin contributed a route */
	ownerOf(route: RouteMetadata): string;
	/** whether any plugin listens at a point, to skip building an event nobody hears */
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

//a plugin route must never leave the address bucket out of its rule (S-DEFAULT-3)
function assertEveryRouteIsLimitedByAddress(plugin: VelvePlugin): void {
	for (const route of plugin.routes ?? []) {
		if (!isUsableBucketRule(route.rateLimit.perIpAddress)) {
			throw new VelveStartupError("plugin_route_without_address_rate_limit");
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

//a declared name is a plain identifier before its prefix is read (E-2481)
function assertIsAPlainTableName(table: unknown): void {
	//a string object converts to text for every check and still carries its own methods (E-2482)
	if (typeof table !== "string") {
		throw new VelveStartupError("plugin_migration_table_not_an_identifier");
	}
	try {
		assertIdentifier(table);
	} catch (cause) {
		if (cause instanceof InvalidIdentifierError) {
			throw new VelveStartupError("plugin_migration_table_not_an_identifier");
		}
		throw cause;
	}
}

//a table a plugin declares must carry the plugin's own prefix (S-DEFAULT-5)
function assertEveryDeclaredTableIsItsOwn(plugin: VelvePlugin): void {
	for (const migration of plugin.migrations ?? []) {
		for (const table of migration.createsTables) {
			assertIsAPlainTableName(table);
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

class LentConnectionReturnedError extends Error {
	readonly code = "plugin_lent_connection_returned";

	constructor() {
		super("a context lent to a revoke hook inside a transaction ends when that hook returns");
		this.name = "LentConnectionReturnedError";
	}
}

interface LentConnection {
	readonly driver: Driver;
	giveBack(): void;
}

//every statement is checked when it is issued so a chain the hook left running is stopped too (E-2586)
function lend(transaction: Driver): LentConnection {
	let returned = false;
	const driver: Driver = {
		query: <T>(sql: string, params: unknown[]): Promise<T[]> =>
			returned
				? Promise.reject(new LentConnectionReturnedError())
				: transaction.query<T>(sql, params),
		transaction: <T>(work: (tx: Driver) => Promise<T>): Promise<T> =>
			returned ? Promise.reject(new LentConnectionReturnedError()) : work(driver),
	};
	return {
		driver,
		giveBack: () => {
			returned = true;
		},
	};
}

//a hook told inside a transaction must not ask the pool for a second connection (E-2584)
function servicesBoundTo(services: FrozenContextServices, lent: Driver): FrozenContextServices {
	return {
		...services,
		driver: lent,
		users: createUserRepository({ driver: lent, schema: services.schema }),
		sessions: createSessionRepository({ driver: lent, schema: services.schema }),
		insideATransaction: true,
	};
}

async function runOnALentConnection(
	transaction: Driver,
	run: (lent: Driver) => Promise<void>,
): Promise<void> {
	const lent = lend(transaction);
	try {
		await run(lent.driver);
	} finally {
		lent.giveBack();
	}
}

type HookPoint<Event> = (
	hooks: PluginHooks,
) => ((event: Event, context: FrozenContext) => Promise<void>) | undefined;

interface Dispatchers {
	readonly onThePool: PluginHookDispatcher;
	onTheTransaction(transaction: Driver): PluginHookDispatcher;
}

function dispatcher(
	registered: readonly RegisteredPlugin[],
	services: FrozenContextServices,
): Dispatchers {
	async function run<Event>(
		hook: HookPoint<Event>,
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

	function runOnTheTransaction<Event>(
		transaction: Driver,
		hook: HookPoint<Event>,
		event: Event,
		revocationOn: (lent: Driver) => RevocationAnnouncement,
	): Promise<void> {
		return runOnALentConnection(transaction, (lent) =>
			run(hook, event, (entry) =>
				createPluginContext(servicesBoundTo(services, lent), entry.plugin.id, revocationOn(lent)),
			),
		);
	}

	const onThePool: PluginHookDispatcher = {
		beforeSignIn: (event) => run((hooks) => hooks.beforeSignIn, event),
		afterSignIn: (event) => run((hooks) => hooks.afterSignIn, event),
		beforeSessionCreate: (event) => run((hooks) => hooks.beforeSessionCreate, event),
		afterSessionCreate: (event) => run((hooks) => hooks.afterSessionCreate, event),
		beforeUserCreate: (event) => run((hooks) => hooks.beforeUserCreate, event),
		afterUserCreate: (event) => run((hooks) => hooks.afterUserCreate, event),
		beforeSessionRevoke: (event, transaction) =>
			transaction === undefined
				? run(
						(hooks) => hooks.beforeSessionRevoke,
						event,
						(entry) => entry.contextInsideARevocation,
					)
				: runOnTheTransaction(
						transaction,
						(hooks) => hooks.beforeSessionRevoke,
						event,
						() => SILENT_REVOCATION,
					),
	};

	//a revocation from a lent context is announced on the same transaction (E-2584)
	const announcedOn = (lent: Driver): RevocationAnnouncement => ({
		announce: (event) => onThePool.beforeSessionRevoke(event, lent),
		get listened() {
			return registered.some((entry) => entry.hooks.beforeSessionRevoke !== undefined);
		},
	});

	const onTheTransaction = (transaction: Driver): PluginHookDispatcher => ({
		beforeSignIn: (event) =>
			runOnTheTransaction(transaction, (hooks) => hooks.beforeSignIn, event, announcedOn),
		afterSignIn: (event) =>
			runOnTheTransaction(transaction, (hooks) => hooks.afterSignIn, event, announcedOn),
		beforeSessionCreate: (event) =>
			runOnTheTransaction(transaction, (hooks) => hooks.beforeSessionCreate, event, announcedOn),
		afterSessionCreate: (event) =>
			runOnTheTransaction(transaction, (hooks) => hooks.afterSessionCreate, event, announcedOn),
		beforeUserCreate: (event) =>
			runOnTheTransaction(transaction, (hooks) => hooks.beforeUserCreate, event, announcedOn),
		afterUserCreate: (event) =>
			runOnTheTransaction(transaction, (hooks) => hooks.afterUserCreate, event, announcedOn),
		beforeSessionRevoke: (event, lent) => onThePool.beforeSessionRevoke(event, lent ?? transaction),
	});

	return { onThePool, onTheTransaction };
}

//the shipped dispatcher type stays as it is and its transaction form is found beside it (E-2795)
const transactionFormOf = new WeakMap<
	PluginHookDispatcher,
	(transaction: Driver) => PluginHookDispatcher
>();

class UnregisteredDispatcherError extends Error {
	readonly code = "plugin_dispatcher_unregistered";

	constructor() {
		super("only a dispatcher a plugin runtime created can run its hooks on a transaction");
		this.name = "UnregisteredDispatcherError";
	}
}

/** the same hooks, each run on a connection lent from the transaction and never on the pool */
export function hooksOnTheTransaction(
	hooks: PluginHookDispatcher,
	transaction: Driver,
): PluginHookDispatcher {
	const onTheTransaction = transactionFormOf.get(hooks);
	if (onTheTransaction === undefined) {
		throw new UnregisteredDispatcherError();
	}
	return onTheTransaction(transaction);
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
		assertEveryRouteIsLimitedByAddress(plugin);
		assertEveryDeclaredTableIsItsOwn(plugin);
	}
	const ordered = inDependencyOrder(plugins);

	const registered: RegisteredPlugin[] = [];
	const dispatchers = dispatcher(registered, options.services);
	const hooks = dispatchers.onThePool;
	transactionFormOf.set(hooks, dispatchers.onTheTransaction);
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
