import type {
	SecurityStateAnchorPort,
	SecurityStateFloor,
	SecurityStateSealedEvent,
} from "../security-state/anchor.js";
import type { FrozenContext, SecurityStateAnchor, VelvePlugin } from "./config.js";

class AnchorMemberMissingError extends Error {
	readonly code = "plugin_anchor_member_missing";

	constructor(member: keyof SecurityStateAnchor) {
		super(`a securityStateAnchor carries no function ${member}, so it cannot be asked`);
		this.name = "AnchorMemberMissingError";
	}
}

type AnchorMember = (...args: unknown[]) => unknown;

//an anchor that keeps its own store is called with itself as this (E-3171)
function calledOn(holder: unknown, member: unknown, name: keyof SecurityStateAnchor): AnchorMember {
	return (...args: unknown[]) =>
		typeof member === "function"
			? (member as AnchorMember).apply(holder, args)
			: Promise.reject(new AnchorMemberMissingError(name));
}

//each member is read once at the start and a missing one fails every call closed (E-3171)
export function asOneReadingOfTheAnchor(
	anchor: SecurityStateAnchor | undefined,
): SecurityStateAnchor | undefined {
	if (anchor === undefined) {
		return undefined;
	}
	const holder: unknown = anchor;
	const recordSeal: unknown = (anchor as Partial<SecurityStateAnchor> | null)?.recordSeal;
	const minimumVersion: unknown = (anchor as Partial<SecurityStateAnchor> | null)?.minimumVersion;
	return {
		recordSeal: calledOn(holder, recordSeal, "recordSeal") as SecurityStateAnchor["recordSeal"],
		minimumVersion: calledOn(
			holder,
			minimumVersion,
			"minimumVersion",
		) as SecurityStateAnchor["minimumVersion"],
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
