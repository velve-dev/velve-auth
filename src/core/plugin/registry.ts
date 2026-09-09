import { VelveStartupError } from "../auth/startup.js";
import type { AnyErrorCode } from "../http/error-map.js";
import {
	type AnyRoute,
	defineRoute,
	type RouteDeclaration,
	type RouteMetadata,
} from "../http/route.js";
import type {
	FrozenContext,
	PluginHooks,
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
	type LogSink,
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
	readonly hooks: PluginHookDispatcher;
	contextOf(route: RouteMetadata): FrozenContext;
	/** Whether any plugin listens at a point, so a caller can skip the work an event costs to build. */
	listensTo(point: keyof PluginHooks): boolean;
}

interface RegisteredPlugin {
	readonly plugin: VelvePlugin;
	readonly context: FrozenContext;
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

/** Declared by 3.15 G and read by nothing yet, so the start says so rather than leaving the author to assume (E-748, E-759). */
const DECLARED_AND_UNREAD_FIELDS: readonly string[] = [
	"migrations",
	"errorCodes",
	"rateLimitRules",
];

/**
 * S-CSRF-6 and T-CSRF-6: a plugin from JavaScript can carry any field, and dropping the ones the
 * interface does not enumerate leaves its author believing a middleware of theirs runs ahead of the
 * origin check. The extension points are enumerated (3.11), so an unenumerated one is a start error.
 */
function assertNoFieldOutsideTheInterface(plugins: readonly VelvePlugin[]): void {
	const declared = new Set(DECLARED_PLUGIN_FIELDS);
	const points = new Set<string>(HOOK_POINTS);
	for (const plugin of plugins) {
		for (const field of Object.keys(plugin)) {
			if (!declared.has(field)) {
				throw new VelveStartupError("plugin_field_unknown");
			}
		}
		for (const point of Object.keys(plugin.hooks ?? {})) {
			if (!points.has(point)) {
				throw new VelveStartupError("plugin_field_unknown");
			}
		}
	}
}

function reportEveryFieldNothingReads(plugins: readonly VelvePlugin[], log: LogSink): void {
	for (const plugin of plugins) {
		for (const field of DECLARED_AND_UNREAD_FIELDS) {
			if (Object.hasOwn(plugin, field)) {
				try {
					log("warn", "a plugin declares a field this version does not read", {
						pluginId: plugin.id,
						field,
					});
				} catch {
					return;
				}
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

/** 3.11: a plugin cannot overwrite a core route, and a name collision is a start error. */
export function assertNoCoreRouteIsOverwritten(
	contributed: readonly AnyRoute[],
	core: readonly AnyRoute[],
): void {
	const names = new Set(core.map((route) => route.name));
	const paths = new Set(core.map(foldedPath));
	for (const route of contributed) {
		if (names.has(route.name) || paths.has(foldedPath(route))) {
			throw new VelveStartupError("plugin_route_conflict");
		}
		names.add(route.name);
		paths.add(foldedPath(route));
	}
}

const COOKIE_FIELDS_A_PLUGIN_MAY_NOT_DECLARE: readonly string[] = [
	"pendingCookie",
	"oauthStateCookie",
];

/**
 * The type refuses these three; this is the half that holds for a plugin written in JavaScript,
 * which is where 3.15 G puts the runtime check (E-764).
 */
function assertNoRouteReadsACoreCookie(plugin: VelvePlugin): void {
	for (const declaration of plugin.routes ?? []) {
		const declared = declaration as Readonly<Record<string, unknown>>;
		// `in` and not `Object.hasOwn`, because `defineRoute` reads the field by property access and
		// a prototype-carried `pendingCookie` would otherwise reach the handler with the cookie (E-781).
		const reaches = COOKIE_FIELDS_A_PLUGIN_MAY_NOT_DECLARE.some((field) => field in declared);
		if (reaches || declared.caller === "pending") {
			throw new VelveStartupError("plugin_route_reads_a_core_cookie");
		}
	}
}

function routesOf(plugin: VelvePlugin): readonly AnyRoute[] {
	assertNoRouteReadsACoreCookie(plugin);
	return (plugin.routes ?? []).map((declaration) =>
		defineRoute(declaration as RouteDeclaration<string, string, unknown, unknown, AnyErrorCode>),
	);
}

function dispatcher(registered: readonly RegisteredPlugin[]): PluginHookDispatcher {
	async function run<Event>(
		hook: (
			hooks: PluginHooks,
		) => ((event: Event, context: FrozenContext) => Promise<void>) | undefined,
		event: Event,
	): Promise<void> {
		for (const { plugin, context } of registered) {
			const listener = plugin.hooks === undefined ? undefined : hook(plugin.hooks);
			if (listener !== undefined) {
				await listener(event, context);
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
		beforeSessionRevoke: (event) => run((hooks) => hooks.beforeSessionRevoke, event),
	};
}

export function createPluginRuntime(options: {
	readonly plugins: readonly VelvePlugin[];
	readonly services: FrozenContextServices;
}): PluginRuntime {
	assertNoFieldOutsideTheInterface(options.plugins);
	assertNoIdIsTakenTwice(options.plugins);
	assertEveryDependencyIsRegistered(options.plugins);
	reportEveryFieldNothingReads(options.plugins, options.services.log);
	const ordered = inDependencyOrder(options.plugins);

	const registered: RegisteredPlugin[] = ordered.map((plugin) => ({
		plugin,
		context: createPluginContext(options.services, plugin.id),
	}));
	const coreContext = createCoreContext(options.services);

	// E-740: the context a route gets is recorded against the route object, not read out of its name.
	const contextByRoute = new WeakMap<RouteMetadata, FrozenContext>();
	const routes: AnyRoute[] = [];
	for (const entry of registered) {
		for (const route of routesOf(entry.plugin)) {
			contextByRoute.set(route, entry.context);
			routes.push(route);
		}
	}
	return {
		plugins: ordered,
		routes,
		hooks: dispatcher(registered),
		contextOf: (route) => contextByRoute.get(route) ?? coreContext,
		listensTo: (point) => registered.some((entry) => entry.plugin.hooks?.[point] !== undefined),
	};
}
