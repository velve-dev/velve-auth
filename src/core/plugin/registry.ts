import { VelveStartupError } from "../auth/startup.js";
import { type AnyRoute, defineRoute, type RouteMetadata } from "../http/route.js";
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
import { createCoreContext, createPluginContext, type FrozenContextServices } from "./context.js";

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
}

interface RegisteredPlugin {
	readonly plugin: VelvePlugin;
	readonly context: FrozenContext;
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
	reservedNamespaces: readonly string[],
): void {
	const names = new Set(core.map((route) => route.name));
	const paths = new Set(core.map(foldedPath));
	const reserved = new Set(reservedNamespaces);
	for (const route of contributed) {
		const namespace = route.name.split(".")[0] ?? "";
		if (names.has(route.name) || paths.has(foldedPath(route)) || reserved.has(namespace)) {
			throw new VelveStartupError("plugin_route_conflict");
		}
		names.add(route.name);
		paths.add(foldedPath(route));
	}
}

function routesOf(plugin: VelvePlugin): readonly AnyRoute[] {
	return (plugin.routes ?? []).map((declaration) => defineRoute(declaration));
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
	assertNoIdIsTakenTwice(options.plugins);
	assertEveryDependencyIsRegistered(options.plugins);
	const ordered = inDependencyOrder(options.plugins);

	const registered: RegisteredPlugin[] = ordered.map((plugin) => ({
		plugin,
		context: createPluginContext(options.services, plugin.id),
	}));
	const coreContext = createCoreContext(options.services);

	// The context a route gets is recorded against the route object, not derived from its name.
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
	};
}
