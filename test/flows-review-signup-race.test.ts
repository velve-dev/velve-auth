import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import type { IdentityMode } from "../src/core/db/migrations/identity-mode.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { createVelveAuth } from "../src/index.js";
import { TEST_ORIGIN, testKeyProvider } from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import { openTestConnection, type TestConnection } from "./db-postgres-connection.js";
import { normalisedAnswer, postTo } from "./flows-fixtures.js";

/** One more than the two a race needs, so a report of "one winner" is not a report of "one pair". */
const RACING_CONNECTIONS = 4;
const PASSWORD = "correct horse battery staple";
/** The username races are decided by scheduling, so one round proves nothing about the next. */
const ROUNDS = 12;

interface Racers {
	readonly connections: readonly TestConnection[];
	readonly handlers: readonly ((request: Request) => Promise<Response>)[];
	readonly schema: string;
}

async function openRacers(
	prefix: string,
	identity: VelveAuthConfig<IdentityMode>["identity"],
): Promise<Racers> {
	const migrated = await openMigratedSchema(prefix, identity.mode);
	const connections: TestConnection[] = [migrated.connection];
	while (connections.length < RACING_CONNECTIONS) {
		connections.push(await openTestConnection());
	}
	const handlers = connections.map((connection) =>
		toWebHandler(
			createVelveAuth({
				identity,
				database: connection,
				schema: migrated.schema,
				keys: testKeyProvider(),
				origins: [TEST_ORIGIN],
				rateLimit: {
					perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
					perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
				},
				email: { send: () => Promise.resolve() },
			} as VelveAuthConfig<IdentityMode>),
		),
	);
	return { connections, handlers, schema: migrated.schema };
}

async function closeRacers(racers: Racers): Promise<void> {
	const [first] = racers.connections;
	if (first !== undefined) {
		await dropSchema(first, racers.schema);
	}
	await Promise.all(racers.connections.map((connection) => connection.close()));
}

let byAddress: Racers;
let byBoth: Racers;

beforeAll(async () => {
	byAddress = await openRacers("signuprace", { mode: "email" });
	byBoth = await openRacers("signuprazeboth", { mode: "username_email" });
}, 120_000);

afterAll(async () => {
	await closeRacers(byAddress);
	await closeRacers(byBoth);
});

/** Every request starts from the same released promise, so the reads all precede the first insert. */
async function simultaneously(
	racers: Racers,
	path: string,
	bodies: readonly Record<string, string>[],
): Promise<Response[]> {
	let release = (): void => undefined;
	const gate = new Promise<void>((resolve) => {
		release = () => resolve();
	});
	const sent = bodies.map((body, index) =>
		gate.then(() =>
			(racers.handlers[index] as (request: Request) => Promise<Response>)(postTo(path, body)),
		),
	);
	release();
	return Promise.all(sent);
}

function withPassword(path: string, body: Record<string, string>): Record<string, string> {
	return path === "/sign-up" ? { ...body, password: PASSWORD } : body;
}

async function accountsHolding(racers: Racers, address: string): Promise<number> {
	const [row] = await (racers.connections[0] as TestConnection).query<{ total: number }>(
		`SELECT count(*)::int AS total FROM ${racers.schema}.user WHERE email = $1`,
		[address],
	);
	return row?.total ?? -1;
}

/**
 * S-ENUM-3 under concurrency. Occupancy is read outside the transaction that inserts, so requests
 * for one free address all read "free" and all but one meet the unique index. A caller that loses
 * that race is a caller registering an address that is now taken, and 3.13 fixes what a taken
 * address is answered with — so the enumeration argument only holds if the loser gets the cover
 * rather than a failure. It got `500 internal_error` (E-930).
 */
describe.each(["/sign-up", "/sign-up/passwordless"])(
	"S-ENUM-3: %s answers a caller that loses the insert race as it answers a taken address",
	(path) => {
		it("answers every racing caller alike, and leaves one account behind", async () => {
			const address = `contended${path.length}.first@example.com`;
			const bodies = Array.from({ length: RACING_CONNECTIONS }, () =>
				withPassword(path, { email: address }),
			);

			const answers = await simultaneously(byAddress, path, bodies);

			expect(
				answers.map((answer) => answer.status),
				"every racing caller is answered as the winner is",
			).toStrictEqual(answers.map(() => 200));
			const shapes = await Promise.all(answers.map(normalisedAnswer));
			expect(shapes).toStrictEqual(shapes.map(() => shapes[0]));
			expect(await accountsHolding(byAddress, address)).toBe(1);
		}, 60_000);

		/**
		 * The same race in the mode that has a second unique index. `coverColumns` replaces the
		 * address and keeps the name, so the cover row carries the caller's username — and every
		 * other case in this file runs in `email`, the one mode where that cannot matter (E-948).
		 */
		it("answers alike in mode username_email, where the cover row carries a name too", async () => {
			const address = `contended${path.length}.both@example.com`;
			const bodies = Array.from({ length: RACING_CONNECTIONS }, (_, index) =>
				withPassword(path, { email: address, username: `racer${path.length}x${index}` }),
			);

			const answers = await simultaneously(byBoth, path, bodies);

			expect(answers.map((answer) => answer.status)).toStrictEqual(answers.map(() => 200));
			// Two registrations cannot send the same name, so the name each answer echoes back is
			// normalised exactly as the address it echoes back already is.
			const shapes = (await Promise.all(answers.map(normalisedAnswer))).map((shape) =>
				shape.replaceAll(/racer\d+x\d+/g, "<name>"),
			);
			expect(shapes).toStrictEqual(shapes.map(() => shapes[0]));
			expect(await accountsHolding(byBoth, address)).toBe(1);
		}, 60_000);

		/**
		 * The attack the address race hides: the caller chooses both requests, so the second one can
		 * take the name the first one's **cover** row will carry. A registered address sent the loser
		 * down the cover branch, whose insert was outside the translation the free branch had, and
		 * the violation escaped as `500 internal_error` — 15 of 25 rounds against 0 of 25 for an
		 * unregistered address (E-947).
		 */
		it("answers a taken address and a free one without a failure when both requests claim one name", async () => {
			const registered = `known${path.length}@example.com`;
			await simultaneously(byBoth, path, [
				withPassword(path, { email: registered, username: `owner${path.length}` }),
			]);

			const seen: Record<string, number[]> = { taken: [], free: [] };
			for (let round = 0; round < ROUNDS; round += 1) {
				for (const [group, first] of [
					["taken", registered],
					["free", `absent${path.length}r${round}@example.com`],
				] as const) {
					const name = `claimed${path.length}${group}${round}`;
					const answers = await simultaneously(byBoth, path, [
						withPassword(path, { email: first, username: name }),
						withPassword(path, {
							email: `fresh${path.length}${group}${round}@example.com`,
							username: name,
						}),
					]);
					seen[group]?.push(...answers.map((answer) => answer.status));
				}
			}

			const unexpected = (group: string): number[] =>
				(seen[group] ?? []).filter((status) => status !== 200 && status !== 409);
			expect(unexpected("taken"), `taken: ${seen.taken?.join(",")}`).toStrictEqual([]);
			expect(unexpected("free"), `free: ${seen.free?.join(",")}`).toStrictEqual([]);
		}, 120_000);

		/**
		 * What is left, pinned rather than closed, and it needs no race at all. The cover of E-627
		 * rolls back, so a registration on a taken address does not durably claim the name it sent —
		 * and a second registration of that name therefore succeeds where it would have been refused
		 * had the first address been free. Two sequential requests, no scheduling, one bit (E-956).
		 */
		it("still tells the two apart by whether the name the first request sent is free afterwards", async () => {
			const registered = `sequential${path.length}@example.com`;
			await simultaneously(byBoth, path, [
				withPassword(path, { email: registered, username: `sequentialowner${path.length}` }),
			]);

			const secondAnswerAfter = async (first: string, name: string): Promise<number> => {
				await simultaneously(byBoth, path, [withPassword(path, { email: first, username: name })]);
				const [second] = await simultaneously(byBoth, path, [
					withPassword(path, { email: `after${name}@example.com`, username: name }),
				]);
				return (second as Response).status;
			};

			const afterTaken = await secondAnswerAfter(registered, `seqtaken${path.length}`);
			const afterFree = await secondAnswerAfter(
				`sequentialabsent${path.length}@example.com`,
				`seqfree${path.length}`,
			);

			expect([afterTaken, afterFree]).toStrictEqual([200, 409]);
		}, 120_000);
	},
);
