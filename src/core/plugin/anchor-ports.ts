import { VelveStartupError } from "../auth/startup.js";
import type {
	SecurityStateAnchorPort,
	SecurityStateFloor,
	SecurityStateSealedEvent,
} from "../security-state/anchor.js";
import type { FrozenContext, SecurityStateAnchor, VelvePlugin } from "./config.js";

type AnchorMember = (...args: unknown[]) => unknown;

//an anchor that keeps its own store is called with itself as this (E-3171)
function calledOn(holder: unknown, member: AnchorMember): AnchorMember {
	return (...args: unknown[]) => member.apply(holder, args);
}

function memberOf(anchor: unknown, name: keyof SecurityStateAnchor): AnchorMember {
	const member: unknown = (anchor as Partial<Record<keyof SecurityStateAnchor, unknown>>)[name];
	if (typeof member !== "function") {
		throw new VelveStartupError("plugin_anchor_incomplete");
	}
	return calledOn(anchor, member as AnchorMember);
}

//an anchor that cannot be asked must refuse the start and never be read as one without a floor (E-3174)
export function asOneReadingOfTheAnchor(
	anchor: SecurityStateAnchor | undefined,
): SecurityStateAnchor | undefined {
	if (anchor === undefined) {
		return undefined;
	}
	const holder: unknown = anchor;
	if (holder === null || (typeof holder !== "object" && typeof holder !== "function")) {
		throw new VelveStartupError("plugin_anchor_incomplete");
	}
	return {
		recordSeal: memberOf(holder, "recordSeal") as SecurityStateAnchor["recordSeal"],
		minimumVersion: memberOf(holder, "minimumVersion") as SecurityStateAnchor["minimumVersion"],
	};
}

//every port is handed its own frozen copy of what it is told (E-3172)
function anchorPortOf(
	anchor: SecurityStateAnchor,
	context: FrozenContext,
): SecurityStateAnchorPort {
	return Object.freeze({
		minimumVersion: (input: { readonly userId: string }): Promise<SecurityStateFloor | null> =>
			Promise.resolve().then(() =>
				anchor.minimumVersion(Object.freeze({ userId: input.userId }), context),
			),
		recordSeal: (event: SecurityStateSealedEvent): Promise<void> =>
			Promise.resolve().then(() =>
				anchor.recordSeal(
					Object.freeze({ userId: event.userId, version: event.version, digest: event.digest }),
					context,
				),
			),
	});
}

/** one port per plugin that contributes an anchor, in the order the plugins run, each bound to that plugin's context */
export function securityStateAnchorPortsOf(
	registered: readonly { readonly plugin: VelvePlugin; readonly context: FrozenContext }[],
): readonly SecurityStateAnchorPort[] {
	const ports: SecurityStateAnchorPort[] = [];
	for (const entry of registered) {
		const anchor = entry.plugin.securityStateAnchor;
		if (anchor !== undefined) {
			ports.push(anchorPortOf(anchor, entry.context));
		}
	}
	return Object.freeze(ports);
}
