import type { Driver } from "../src/core/db/driver.js";

/**
 * A driver that can hold one statement of one transaction until it is released, so an interleaving
 * is chosen rather than raced for. A deadlock test that arranges its interleaving with sleeps is the
 * flakiest thing in a tree; this and `waitUntilWaitingForALock` below are what make it a decision.
 */
export class HeldDriver implements Driver {
	private readonly inner: Driver;
	private depth = 0;
	private gate: {
		readonly matches: RegExp;
		readonly reached: () => void;
		readonly open: Promise<void>;
		readonly release: () => void;
		held: boolean;
	} | null = null;

	readonly transactions: string[][] = [];
	readonly statements: string[] = [];
	/** What the server reported, read where it is raised: the HTTP surface answers 500 and keeps the
	 * SQLSTATE to itself, so a test reading the status alone cannot tell a deadlock from anything
	 * else that goes wrong (E-1603). */
	readonly failures: string[] = [];

	constructor(inner: Driver) {
		this.inner = inner;
	}

	/**
	 * Resolves once the next statement matching `matches` has been reached and is being held, and
	 * raises if no statement matches it within the deadline. Raising is the point: a hold that matches
	 * nothing leaves the two requests never overlapping, and without the deadline the case hangs until
	 * the runner's timeout and fails with a message that names neither the file nor the statement
	 * (E-1608).
	 */
	holdBefore(matches: RegExp, within = 15_000): Promise<void> {
		let reached = (): void => {};
		let release = (): void => {};
		const reachedIt = new Promise<void>((resolve, reject) => {
			reached = resolve;
			setTimeout(
				() => reject(new Error(`no statement matched ${String(matches)}. They were:\n${this.statements.join("\n")}`)),
				within,
			).unref();
		});
		const open = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.gate = { matches, reached, open, release, held: false };
		return reachedIt;
	}

	release(): void {
		this.gate?.release();
		this.gate = null;
	}

	forgetFailures(): void {
		this.failures.length = 0;
	}

	async query<T>(sql: string, params: unknown[]): Promise<T[]> {
		this.statements.push(sql);
		this.transactions.at(-1)?.push(sql);
		const gate = this.gate;
		if (gate !== null && !gate.held && gate.matches.test(sql)) {
			gate.held = true;
			gate.reached();
			await gate.open;
		}
		return this.inner.query<T>(sql, params).catch((failure: unknown) => {
			this.failures.push(sqlStateOf(failure));
			throw failure;
		});
	}

	async transaction<T>(run: (tx: Driver) => Promise<T>): Promise<T> {
		if (this.depth > 0) {
			return run(this);
		}
		this.transactions.push([]);
		this.depth += 1;
		try {
			return await this.inner.transaction(() => run(this));
		} finally {
			this.depth -= 1;
		}
	}
}

export async function backendPidOf(driver: Driver): Promise<number> {
	const [row] = await driver.query<{ pid: number }>("SELECT pg_backend_pid() AS pid", []);
	return row?.pid ?? -1;
}

/**
 * The other half of the interleaving: a held statement is released only once the transaction it must
 * deadlock with is itself waiting for a lock. PostgreSQL reports that in `pg_stat_activity`, so the
 * condition is read rather than a duration guessed at.
 */
export async function waitUntilWaitingForALock(
	observer: Driver,
	pid: number,
	diagnose: () => string,
): Promise<void> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		if (Date.now() > deadline) {
			throw new Error(`process ${pid} never waited for a lock. It ran:\n${diagnose()}`);
		}
		const rows = await observer.query<{ waiting: boolean }>(
			"SELECT (wait_event_type = 'Lock') AS waiting FROM pg_stat_activity WHERE pid = $1",
			[pid],
		);
		if (rows[0]?.waiting === true) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function sqlStateOf(failure: unknown): string {
	return typeof failure === "object" && failure !== null && "sqlState" in failure
		? String((failure as { sqlState: unknown }).sqlState)
		: "";
}

const DEADLOCK_DETECTED = "40P01";

export function deadlocksReportedTo(drivers: readonly HeldDriver[]): number {
	return drivers.reduce(
		(total, driver) =>
			total + driver.failures.filter((state) => state === DEADLOCK_DETECTED).length,
		0,
	);
}

/**
 * The three row-lock strengths this library can put on a row, and what each of them waits for.
 * Taken from PostgreSQL's own conflict matrix (13.3.2): `FOR KEY SHARE`, which is what a foreign key
 * takes on `velve.user` for every insert of a user-owned row, waits for nothing but `FOR UPDATE`.
 * That single row of the matrix is why the mode a lock is taken in decides whether an implicit
 * acquisition can be an edge in a wait-for cycle at all (E-1604).
 */
type Mode = "key-share" | "no-key" | "exclusive";

const WAITS_FOR: Record<Mode, ReadonlySet<Mode>> = {
	"key-share": new Set<Mode>(["exclusive"]),
	"no-key": new Set<Mode>(["no-key", "exclusive"]),
	exclusive: new Set<Mode>(["key-share", "no-key", "exclusive"]),
};

const STRENGTH: Record<Mode, number> = { "key-share": 0, "no-key": 1, exclusive: 2 };

const THE_ACCOUNT_ROW = "user";

export interface Acquisition {
	readonly table: string;
	readonly mode: Mode;
}

/**
 * What one statement locks, in the order it locks it. A `DELETE` takes the strength of `FOR UPDATE`
 * on the row it removes; an `UPDATE` that leaves every key column alone takes `FOR NO KEY UPDATE`;
 * an `INSERT` takes a row nobody else can hold, and then the foreign key's `FOR KEY SHARE` on
 * `velve.user`. An `ON CONFLICT … DO UPDATE` can land on an existing row, so it is read as a lock on
 * one. Order inside a single statement is the order the text gives, which the planner does not
 * promise; it is used only where a statement touches two tables at once.
 */
export function acquisitionsIn(sql: string, schema: string, owned: ReadonlySet<string>): Acquisition[] {
	const found: Acquisition[] = [];
	const qualified = `${schema.replaceAll(".", "\\.")}\\.(\\w+)`;
	const explicit = /\bFOR\s+(NO\s+KEY\s+)?UPDATE\b/i.exec(sql);
	if (explicit !== null) {
		const table = new RegExp(`FROM\\s+${qualified}`, "i").exec(sql)?.[1];
		if (table !== undefined) {
			found.push({ table, mode: explicit[1] === undefined ? "exclusive" : "no-key" });
		}
	}
	for (const [, table] of sql.matchAll(new RegExp(`\\bDELETE\\s+FROM\\s+${qualified}`, "gi"))) {
		found.push({ table: String(table), mode: "exclusive" });
	}
	for (const [, table] of sql.matchAll(new RegExp(`\\bUPDATE\\s+${qualified}`, "gi"))) {
		found.push({ table: String(table), mode: "no-key" });
	}
	for (const [, table] of sql.matchAll(new RegExp(`\\bINSERT\\s+INTO\\s+${qualified}`, "gi"))) {
		if (/\bON\s+CONFLICT\b/i.test(sql)) {
			found.push({ table: String(table), mode: "exclusive" });
		}
		if (owned.has(String(table))) {
			found.push({ table: THE_ACCOUNT_ROW, mode: "key-share" });
		}
	}
	return found;
}

export interface HeldLock {
	readonly at: number;
	readonly mode: Mode;
}

/** Every lock one transaction ends up holding: where it first took it, and in the strongest mode it
 * took it in, because a row lock is held to commit and only ever strengthens. */
export function locksHeldBy(
	statements: readonly string[],
	schema: string,
	owned: ReadonlySet<string>,
): Map<string, HeldLock> {
	const held = new Map<string, HeldLock>();
	let position = 0;
	for (const sql of statements) {
		for (const acquisition of acquisitionsIn(sql, schema, owned)) {
			position += 1;
			const standing = held.get(acquisition.table);
			if (standing === undefined) {
				held.set(acquisition.table, { at: position, mode: acquisition.mode });
			} else if (STRENGTH[acquisition.mode] > STRENGTH[standing.mode]) {
				held.set(acquisition.table, { at: standing.at, mode: acquisition.mode });
			}
		}
	}
	return held;
}

/**
 * Whether a lock on **`velve.user`** ordered these two transactions: both took one, in modes that
 * wait for each other, before either of the two tables in question. Only the account row counts.
 * Any other table in common is a coincidence of table names and not a mutex — the four tables whose
 * row is a secret are the case that matters, since two transactions consuming `one_time_token` are
 * almost always consuming different rows of it, and reading that as serialisation hid cycle A from
 * this analysis until a planted run reported one pair where two were expected (E-1606).
 */
function serialisedOnTheAccountRow(
	one: Map<string, HeldLock>,
	other: Map<string, HeldLock>,
	tables: readonly string[],
): boolean {
	const mine = one.get(THE_ACCOUNT_ROW);
	const theirs = other.get(THE_ACCOUNT_ROW);
	if (mine === undefined || theirs === undefined || !WAITS_FOR[mine.mode].has(theirs.mode)) {
		return false;
	}
	return tables.every(
		(table) => mine.at < (one.get(table)?.at ?? 0) && theirs.at < (other.get(table)?.at ?? 0),
	);
}

/**
 * A transaction that inserts the account it then writes cannot contend with another transaction on
 * that account: until it commits, no request can name the account, and every row it locks it created.
 * Registration is the case, and it takes `password_credential` before `one_time_token` where a reset
 * redemption takes them the other way round — a pair this analysis reports as a cycle and which is
 * unreachable for that reason (E-1605).
 */
function createsTheAccount(statements: readonly string[], schema: string): boolean {
	const insertsAnAccount = new RegExp(`INSERT\\s+INTO\\s+${schema}\\.user\\b`, "i");
	return statements.some(
		(sql) => insertsAnAccount.test(sql) && !/\bON\s+CONFLICT\b/i.test(sql),
	);
}

export interface LockCycle {
	readonly tables: readonly [string, string];
	readonly reported: string;
}

/**
 * Every pair of observed transactions that take two tables in opposite orders, in modes that wait
 * for each other, with no earlier lock in common that would have serialised them. That last clause
 * is the whole of what `velve.user` taken first buys, and leaving it out reports the repaired tree as
 * broken (E-1605).
 */
export function cyclesAmong(
	transactions: readonly (readonly string[])[],
	schema: string,
	owned: ReadonlySet<string>,
): LockCycle[] {
	const held = transactions
		.filter((statements) => !createsTheAccount(statements, schema))
		.map((statements) => locksHeldBy(statements, schema, owned));
	const cycles: LockCycle[] = [];
	for (const [index, one] of held.entries()) {
		for (const other of held.slice(index + 1)) {
			for (const [x, oneOnX] of one) {
				for (const [y, oneOnY] of one) {
					const otherOnX = other.get(x);
					const otherOnY = other.get(y);
					if (otherOnX === undefined || otherOnY === undefined || oneOnX.at >= oneOnY.at) {
						continue;
					}
					if (otherOnY.at >= otherOnX.at) {
						continue;
					}
					if (
						!WAITS_FOR[oneOnY.mode].has(otherOnY.mode) ||
						!WAITS_FOR[otherOnX.mode].has(oneOnX.mode)
					) {
						continue;
					}
					if (serialisedOnTheAccountRow(one, other, [x, y])) {
						continue;
					}
					const reported = `${x} then ${y} against ${y} then ${x}`;
					if (!cycles.some((cycle) => cycle.reported === reported)) {
						cycles.push({ tables: [x, y], reported });
					}
				}
			}
		}
	}
	return cycles;
}
