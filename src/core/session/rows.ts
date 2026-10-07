import type { Actor } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import type { SessionService } from "./service.js";

/** the session rows a flow announces or revokes in its own transaction, each one checked first */
export interface SessionRows {
	listEverySessionIdOwnedBy(input: { readonly actor: Actor }): Promise<string[]>;
	deleteEverySessionOwnedBy(input: { readonly actor: Actor }): Promise<number>;
	deleteEverySessionOwnedByReturningIds(input: { readonly actor: Actor }): Promise<string[]>;
}

const LENT_ROWS = Symbol("velve.sessionRows");

type RowsOn = (driver: Driver) => SessionRows;

//the service carries its own lending so this module keeps nothing between calls
export function lendSessionRows(service: SessionService, rowsOn: RowsOn): void {
	Object.defineProperty(service, LENT_ROWS, { value: rowsOn });
}

//a flow reaches session rows only with the keys and sealing mode of the service it holds (S-INTEG-9)
export function sessionRowsOn(service: SessionService, driver: Driver): SessionRows {
	const rowsOn: unknown = Reflect.get(service, LENT_ROWS);
	if (typeof rowsOn !== "function") {
		throw new TypeError("session rows are lent only by a service createSessionService built");
	}
	return (rowsOn as RowsOn)(driver);
}
