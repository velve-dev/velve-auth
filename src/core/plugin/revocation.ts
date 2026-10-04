import type { RevokeReason } from "./config.js";
import type { PluginRuntime } from "./registry.js";

interface RevocationToAnnounce {
	readonly userId: string;
	readonly sessionIds: readonly string[];
	readonly reason: RevokeReason;
}

//one event per session and every one before the first row goes (E-758)
export async function announceEachRevocation(
	runtime: PluginRuntime,
	revocation: RevocationToAnnounce,
): Promise<void> {
	for (const sessionId of revocation.sessionIds) {
		await runtime.hooks.beforeSessionRevoke({
			sessionId,
			userId: revocation.userId,
			reason: revocation.reason,
		});
	}
}
