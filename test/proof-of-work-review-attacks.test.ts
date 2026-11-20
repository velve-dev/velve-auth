import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { solveProofOfWork } from "../src/client/proof-of-work-solver.js";
import type { VelveAuthConfig } from "../src/core/auth/config.js";
import type { Driver } from "../src/core/db/driver.js";
import { object, string } from "../src/core/http/validators.js";
import { toWebHandler } from "../src/core/http/web-handler.js";
import { encodeBase64Url } from "../src/core/keys/base64url.js";
import { rootKeyProvider } from "../src/core/keys/index.js";
import type { KeyProvider } from "../src/core/keys/provider.js";
import type { PluginRoute, VelvePlugin } from "../src/core/plugin/config.js";
import { createProofOfWorkChallenges } from "../src/core/pow/challenge.js";
import type { ProofOfWorkConfig, ProofOfWorkRoute } from "../src/core/pow/config.js";
import {
	isSolvedAt,
	PROOF_OF_WORK_HEADER,
	proofOfWorkInput,
	writtenSolution,
} from "../src/core/pow/work.js";
import { createVelveAuth, type VelveAuth } from "../src/index.js";
import {
	configFor,
	createLogSink,
	type LogSink,
	TEST_ORIGIN,
	testKeyProvider,
} from "./auth-fixtures.js";
import { dropSchema, openMigratedSchema } from "./db-fixtures.js";
import type { TestConnection } from "./db-postgres-connection.js";
import { codeOf, postWithSolution, unsolvedNonceFor } from "./proof-of-work-fixtures.js";

/**
 * Review of change 2, the proof of work (3.9, S-RATE-9 to S-RATE-12), from the side of a mass
 * sign-up and mailed-request flooder, an enumerator and a resource exhauster. Every bench records
 * the statements the library sends, so a refusal can be held to the work it is allowed to do.
 */

const PASSWORD = "correct-horse-battery-staple";
const ADDRESS_HEADER = "x-review-connection-address";

interface Recorded {
	readonly sql: string;
}

interface Bench {
	readonly auth: VelveAuth<"email">;
	readonly handler: (request: Request) => Promise<Response>;
	readonly from: (request: Request, address: string) => Promise<Response>;
	readonly connection: TestConnection;
	readonly schema: string;
	readonly statements: Recorded[];
	readonly mails: string[];
	readonly log: LogSink;
	difficulty: unknown;
	threshold: unknown;
}

const opened: Bench[] = [];

afterEach(async () => {
	for (const bench of opened.splice(0)) {
		await dropSchema(bench.connection, bench.schema);
		await bench.connection.close();
	}
});

function recording(inner: Driver, statements: Recorded[]): Driver {
	return {
		query: (sql, parameters) => {
			statements.push({ sql: sql.replace(/\s+/g, " ").trim() });
			return inner.query(sql, parameters);
		},
		transaction: (run) => {
			statements.push({ sql: "BEGIN" });
			return inner.transaction((transaction) => run(recording(transaction, statements)));
		},
	};
}

async function openBench(
	prefix: string,
	options: {
		readonly keys?: KeyProvider;
		readonly proofOfWork?: ProofOfWorkConfig | null;
		readonly schemaOf?: Bench;
		readonly overrides?: Omit<Partial<VelveAuthConfig<"email">>, "database" | "schema">;
	} = {},
): Promise<Bench> {
	const migrated =
		options.schemaOf === undefined
			? await openMigratedSchema(prefix)
			: { connection: options.schemaOf.connection, schema: options.schemaOf.schema };
	const statements: Recorded[] = [];
	const mails: string[] = [];
	const log = createLogSink();
	const asked = { difficulty: 4 as unknown, threshold: 3 as unknown };
	const proofOfWork: ProofOfWorkConfig | undefined =
		options.proofOfWork === null
			? undefined
			: (options.proofOfWork ?? {
					difficulty: () => asked.difficulty as number,
					signInFailuresBeforeProof: () => asked.threshold as number,
				});
	const created = (() => {
		try {
			return createVelveAuth(
				configFor({
					database: recording(migrated.connection, statements),
					schema: migrated.schema,
					keys: options.keys ?? testKeyProvider(),
					log: log.write,
					email: {
						send: (message) => {
							mails.push(message.to);
							return Promise.resolve();
						},
					},
					rateLimit: {
						perIpAddress: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
						perAccount: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
						...(proofOfWork === undefined ? {} : { proofOfWork }),
					},
					...options.overrides,
				}),
			);
		} catch (error) {
			return error instanceof Error ? error : new Error(String(error));
		}
	})();
	if (created instanceof Error) {
		if (options.schemaOf === undefined) {
			await dropSchema(migrated.connection, migrated.schema);
			await migrated.connection.close();
		}
		throw created;
	}
	const auth = created;
	const addressed = toWebHandler(auth, {
		connectionAddress: (request) => request.headers.get(ADDRESS_HEADER),
	});
	const bench: Bench = Object.assign(asked, {
		auth,
		handler: toWebHandler(auth),
		from: (request: Request, address: string) => {
			request.headers.set(ADDRESS_HEADER, address);
			return addressed(request);
		},
		connection: migrated.connection,
		schema: migrated.schema,
		statements,
		mails,
		log,
	});
	if (options.schemaOf === undefined) {
		opened.push(bench);
	}
	return bench;
}

function challengeRequest(route: ProofOfWorkRoute): Request {
	return new Request(
		`https://api.example.com/proof-of-work/challenge?route=${encodeURIComponent(route)}`,
		{ method: "GET", headers: { Origin: TEST_ORIGIN } },
	);
}

interface Issued {
	readonly challenge: string;
	readonly difficulty: number;
	readonly expiresAt: string;
}

async function issued(bench: Bench, route: ProofOfWorkRoute): Promise<Issued> {
	const response = await bench.handler(challengeRequest(route));
	expect(response.status).toBe(200);
	return (await response.json()) as Issued;
}

async function solved(bench: Bench, route: ProofOfWorkRoute): Promise<string> {
	const challenge = await issued(bench, route);
	return writtenSolution(challenge.challenge, await solveProofOfWork(challenge));
}

async function count(bench: Bench, table: string, where = "TRUE"): Promise<number> {
	const rows = await bench.connection.query<{ n: string }>(
		`SELECT count(*)::text AS n FROM ${bench.schema}.${table} WHERE ${where}`,
		[],
	);
	return Number(rows[0]?.n ?? 0);
}

function touching(bench: Bench, table: string): Recorded[] {
	return bench.statements.filter((statement) => statement.sql.includes(`.${table}`));
}

function signUpBody(email: string) {
	return { email, password: PASSWORD };
}

const RESET = "/password/request-reset";
const MAGIC_LINK = "/sign-in/magic-link/request";
const SIGN_UP = "/sign-up";
const SIGN_UP_PASSWORDLESS = "/sign-up/passwordless";

describe("a flooder reusing one solution (S-RATE-9, S-RATE-10)", () => {
	it("cannot spend a sign-up solution on the passwordless sign-up, the reset or the magic link", async () => {
		const bench = await openBench("powrev_cross_route");
		const forSignUp = await solved(bench, "signUp.withPassword");
		const forReset = await solved(bench, "password.requestReset");

		const answers = [
			await bench.handler(
				postWithSolution(SIGN_UP_PASSWORDLESS, { email: "a@example.com" }, forSignUp),
			),
			await bench.handler(postWithSolution(RESET, { email: "a@example.com" }, forSignUp)),
			await bench.handler(postWithSolution(MAGIC_LINK, { email: "a@example.com" }, forReset)),
		];

		for (const answer of answers) {
			expect(answer.status).toBe(400);
			expect(await codeOf(answer)).toBe("proof_of_work_required");
		}
		expect(await count(bench, "user")).toBe(0);
		expect(bench.mails).toStrictEqual([]);
		expect(await count(bench, "proof_of_work_spent")).toBe(0);
		expect(touching(bench, "proof_of_work_spent")).toStrictEqual([]);
	});

	it("cannot spend one challenge twice under two different nonces", async () => {
		const bench = await openBench("powrev_two_nonces");
		bench.difficulty = 0;
		const challenge = await issued(bench, "signUp.withPassword");

		const first = await bench.handler(
			postWithSolution(
				SIGN_UP,
				signUpBody("one@example.com"),
				writtenSolution(challenge.challenge, 0),
			),
		);
		const second = await bench.handler(
			postWithSolution(
				SIGN_UP,
				signUpBody("two@example.com"),
				writtenSolution(challenge.challenge, 1),
			),
		);

		expect(first.status).toBe(200);
		expect(await codeOf(second)).toBe("proof_of_work_required");
		expect(await count(bench, "user")).toBe(1);
		expect(bench.log.lines.at(-1)?.fields.reason).toBe("proof_of_work_spent");
	});

	it("creates exactly one account from ten parallel sign-ups carrying one solution", async () => {
		const bench = await openBench("powrev_parallel_signup");
		const solution = await solved(bench, "signUp.withPassword");

		const answers = await Promise.all(
			Array.from({ length: 10 }, (_unused, index) =>
				bench.handler(postWithSolution(SIGN_UP, signUpBody(`p${index}@example.com`), solution)),
			),
		);

		expect(answers.filter((answer) => answer.status === 200)).toHaveLength(1);
		expect(answers.filter((answer) => answer.status === 400)).toHaveLength(9);
		expect(await count(bench, "user")).toBe(1);
		expect(await count(bench, "proof_of_work_spent")).toBe(1);
	});

	it("is refused once spent, also after the handler refused the request it was spent on", async () => {
		const bench = await openBench("powrev_spent_on_failure");
		const solution = await solved(bench, "signUp.withPassword");
		await bench.auth.signUp.withPassword({
			...signUpBody("taken@example.com"),
			origin: TEST_ORIGIN,
			proofOfWork: await (async () => {
				const challenge = await bench.auth.proofOfWork.challenge({
					route: "signUp.withPassword",
					origin: TEST_ORIGIN,
				});
				return { challenge: challenge.challenge, nonce: await solveProofOfWork(challenge) };
			})(),
		});

		await bench.handler(postWithSolution(SIGN_UP, signUpBody("taken@example.com"), solution));
		const again = await bench.handler(
			postWithSolution(SIGN_UP, signUpBody("fresh@example.com"), solution),
		);

		expect(await codeOf(again)).toBe("proof_of_work_required");
		expect(await count(bench, "user")).toBe(1);
	});
});

describe("a flooder editing the challenge (S-RATE-9)", () => {
	it("is refused for a lowered difficulty even with a nonce that solves the lowered one", async () => {
		const bench = await openBench("powrev_lower_difficulty");
		bench.difficulty = 20;
		const challenge = await issued(bench, "signUp.withPassword");
		const [version, , expiry, value, mac] = challenge.challenge.split(".");
		const lowered = [version, "0", expiry, value, mac].join(".");

		const answer = await bench.handler(
			postWithSolution(SIGN_UP, signUpBody("low@example.com"), writtenSolution(lowered, 0)),
		);

		expect(challenge.difficulty).toBe(20);
		expect(await codeOf(answer)).toBe("proof_of_work_required");
		expect(bench.log.lines.at(-1)?.fields.reason).toBe("proof_of_work_forged");
		expect(await count(bench, "user")).toBe(0);
	});

	it("is refused for a later expiry and for a value of its own", async () => {
		const bench = await openBench("powrev_edited_fields");
		bench.difficulty = 0;
		const challenge = await issued(bench, "signUp.withPassword");
		const [version, difficulty, expiry, value, mac] = challenge.challenge.split(".");
		const edits = [
			[version, difficulty, String(Number(expiry) + 86_400), value, mac],
			[version, difficulty, expiry, encodeBase64Url(randomBytes(32)), mac],
			[version, difficulty, expiry, value, encodeBase64Url(randomBytes(32))],
			[String(Number(version) + 1), difficulty, expiry, value, mac],
		];

		for (const edited of edits) {
			const answer = await bench.handler(
				postWithSolution(
					SIGN_UP,
					signUpBody("edit@example.com"),
					writtenSolution(edited.join("."), 0),
				),
			);
			expect(await codeOf(answer)).toBe("proof_of_work_required");
		}
		expect(await count(bench, "user")).toBe(0);
		expect(touching(bench, "proof_of_work_spent")).toStrictEqual([]);
	});

	it("is refused for header spellings the challenge route never hands out", async () => {
		const bench = await openBench("powrev_header_spellings");
		bench.difficulty = 0;
		const challenge = (await issued(bench, "signUp.withPassword")).challenge;
		const spellings = [
			`${challenge}.00`,
			`${challenge}.+1`,
			`${challenge}.-1`,
			`${challenge}.1e3`,
			`${challenge}.0x10`,
			`${challenge}.9007199254740992`,
			`${challenge}.99999999999999999999`,
			`${challenge}. 1`,
			`${challenge}.0.0`,
			`${challenge}`,
			`${challenge}.0, ${challenge}.1`,
			`${challenge.toUpperCase()}.0`,
			`${"9".repeat(4096)}`,
		];

		for (const spelling of spellings) {
			const request = postWithSolution(SIGN_UP, signUpBody("spell@example.com"), null);
			request.headers.set(PROOF_OF_WORK_HEADER, spelling);
			const answer = await bench.handler(request);
			expect(answer.status, spelling.slice(-24)).toBe(400);
			expect(await codeOf(answer)).toBe("proof_of_work_required");
		}
		expect(await count(bench, "user")).toBe(0);
		expect(touching(bench, "proof_of_work_spent")).toStrictEqual([]);
	});

	it("is refused, never thrown, for direct-call fields that are no solution", async () => {
		const bench = await openBench("powrev_direct_fields");
		bench.difficulty = 0;
		const challenge = (await issued(bench, "signUp.withPassword")).challenge;
		const fields: unknown[] = [
			null,
			"",
			`${challenge}.0`,
			{},
			[],
			{ challenge },
			{ challenge, nonce: "0" },
			{ challenge, nonce: 0.5 },
			{ challenge, nonce: -1 },
			{ challenge, nonce: 2 ** 53 },
			{ challenge, nonce: Number.NaN },
			{ challenge, nonce: Number.POSITIVE_INFINITY },
			{ challenge: 7, nonce: 0 },
			{ challenge: `${challenge}.0`, nonce: 0 },
		];

		for (const proofOfWork of fields) {
			const answer = await bench.auth.signUp
				.withPassword({
					...signUpBody("direct@example.com"),
					origin: TEST_ORIGIN,
					proofOfWork,
				} as unknown as Parameters<typeof bench.auth.signUp.withPassword>[0])
				.then(
					() => "accepted",
					(error: { code?: string }) => error.code ?? "thrown",
				);
			expect(answer, JSON.stringify(proofOfWork)).toBe("proof_of_work_required");
		}
		expect(await count(bench, "user")).toBe(0);
	});
});

describe("a challenge across a key rotation (S-RATE-9)", () => {
	it("checks under the old version while it stays in the ring and is refused once it left", async () => {
		const first = encodeBase64Url(randomBytes(32));
		const second = encodeBase64Url(randomBytes(32));
		const before = await openBench("powrev_rotation", {
			keys: rootKeyProvider({ currentVersion: 1, keysByVersion: { 1: first } }),
		});
		before.difficulty = 0;
		const oldOne = writtenSolution((await issued(before, "password.requestReset")).challenge, 0);
		const olderOne = writtenSolution((await issued(before, "password.requestReset")).challenge, 0);
		const rotated = await openBench("powrev_rotation", {
			keys: rootKeyProvider({ currentVersion: 2, keysByVersion: { 1: first, 2: second } }),
			schemaOf: before,
		});
		const dropped = await openBench("powrev_rotation", {
			keys: rootKeyProvider({ currentVersion: 2, keysByVersion: { 2: second } }),
			schemaOf: before,
		});

		const kept = await rotated.handler(postWithSolution(RESET, { email: "x@example.com" }, oldOne));
		const refused = await dropped.handler(
			postWithSolution(RESET, { email: "x@example.com" }, olderOne),
		);

		expect(kept.status).toBe(204);
		expect(await codeOf(refused)).toBe("proof_of_work_required");
		expect(dropped.log.lines.at(-1)?.fields.reason).toBe("proof_of_work_forged");
		expect((await issued(rotated, "password.requestReset")).challenge.startsWith("2.")).toBe(true);
	});
});

describe("a resource exhauster (S-RATE-10, S-RATE-11)", () => {
	it("costs no statement beyond the address bucket for a missing, malformed, forged or unsolved solution", async () => {
		const bench = await openBench("powrev_free_refusals");
		const challenge = await issued(bench, "signUp.withPassword");
		const unsolved = writtenSolution(
			challenge.challenge,
			await unsolvedNonceFor(challenge.challenge, challenge.difficulty),
		);
		const foreign = await solved(bench, "password.requestReset");

		for (const solution of [null, "1.2.3", foreign, unsolved]) {
			bench.statements.length = 0;
			const answer = await bench.handler(
				postWithSolution(SIGN_UP, signUpBody("free@example.com"), solution),
			);
			expect(await codeOf(answer)).toBe("proof_of_work_required");
			expect(bench.statements.map((statement) => statement.sql)).toHaveLength(1);
			expect(bench.statements[0]?.sql).toContain(".rate_bucket");
		}
	});

	it("checks an accepted solution with exactly one statement on the spent table and refuses an expired one with that statement alone", async () => {
		const keys = testKeyProvider();
		const bench = await openBench("powrev_one_statement", { keys });
		const fresh = await solved(bench, "password.requestReset");
		const pastChallenge = await createProofOfWorkChallenges(keys).issue({
			route: "password.requestReset",
			difficulty: 2,
			expiresAt: new Date(Date.now() - 60_000),
		});
		const expired = writtenSolution(pastChallenge.challenge, await solveProofOfWork(pastChallenge));

		bench.statements.length = 0;
		const accepted = await bench.handler(
			postWithSolution(RESET, { email: "n@example.com" }, fresh),
		);
		const spentStatementsOnAccept = touching(bench, "proof_of_work_spent").length;
		bench.statements.length = 0;
		const refused = await bench.handler(
			postWithSolution(RESET, { email: "n@example.com" }, expired),
		);

		expect(accepted.status).toBe(204);
		expect(spentStatementsOnAccept).toBe(1);
		expect(await codeOf(refused)).toBe("proof_of_work_required");
		expect(touching(bench, "proof_of_work_spent")).toHaveLength(1);
		expect(bench.statements).toHaveLength(2);
		expect(await count(bench, "proof_of_work_spent")).toBe(1);
	});

	it("keeps no spent row past its expiry once swept, and the swept challenge stays refused", async () => {
		const keys = testKeyProvider();
		const bench = await openBench("powrev_sweep", { keys });
		const shortLived = await createProofOfWorkChallenges(keys).issue({
			route: "password.requestReset",
			difficulty: 2,
			expiresAt: new Date(Date.now() + 2_000),
		});
		const solution = writtenSolution(shortLived.challenge, await solveProofOfWork(shortLived));
		const accepted = await bench.handler(
			postWithSolution(RESET, { email: "s@example.com" }, solution),
		);
		const before = await bench.auth.maintenance.sweep();
		await new Promise((resolve) => setTimeout(resolve, 3_000));

		const report = await bench.auth.maintenance.sweep();
		const replay = await bench.handler(
			postWithSolution(RESET, { email: "s@example.com" }, solution),
		);

		expect(accepted.status).toBe(204);
		expect(before.deletedRowsByTable.proof_of_work_spent).toBe(0);
		expect(report.deletedRowsByTable.proof_of_work_spent).toBe(1);
		expect(await codeOf(replay)).toBe("proof_of_work_required");
		expect(bench.log.lines.at(-1)?.fields.reason).toBe("proof_of_work_expired");
		expect(await count(bench, "proof_of_work_spent")).toBe(0);
		expect(bench.mails).toHaveLength(1);
	});

	it("reaches no recovery row and no mail on the passkey recovery request without a solution", async () => {
		const bench = await openBench("powrev_recovery_request", {
			overrides: {
				webauthn: {
					relyingPartyId: "app.example.com",
					relyingPartyName: "Velve Auth tests",
					origins: [TEST_ORIGIN],
					userVerification: "required",
					recovery: { waitingPeriodInSeconds: () => 0 },
				},
			},
		});
		const forReset = await solved(bench, "password.requestReset");

		const missing = await bench.handler(
			postWithSolution("/passkey-recovery/request", { email: "r@example.com" }, null),
		);
		const foreign = await bench.handler(
			postWithSolution("/passkey-recovery/request", { email: "r@example.com" }, forReset),
		);
		const mailsBeforeTheOwnSolution = [...bench.mails];
		const own = await bench.handler(
			postWithSolution(
				"/passkey-recovery/request",
				{ email: "r@example.com" },
				await solved(bench, "passkeyRecovery.request"),
			),
		);

		expect(await codeOf(missing)).toBe("proof_of_work_required");
		expect(await codeOf(foreign)).toBe("proof_of_work_required");
		expect(own.status).toBe(204);
		expect(mailsBeforeTheOwnSolution).toStrictEqual([]);
	});
});

describe("an enumerator (S-RATE-11, S-TIM-6)", () => {
	async function sequenceOf(bench: Bench, run: () => Promise<Response>) {
		bench.statements.length = 0;
		const answer = await run();
		return {
			status: answer.status,
			body: await answer.text(),
			statements: bench.statements.map((statement) => statement.sql),
		};
	}

	it("sends the same statements and answer for a known and an unknown address on the reset request", async () => {
		const bench = await openBench("powrev_reset_uniform");
		await bench.auth.signUp.withPassword({
			...signUpBody("known@example.com"),
			origin: TEST_ORIGIN,
			proofOfWork: await (async () => {
				const challenge = await bench.auth.proofOfWork.challenge({
					route: "signUp.withPassword",
					origin: TEST_ORIGIN,
				});
				return { challenge: challenge.challenge, nonce: await solveProofOfWork(challenge) };
			})(),
		});
		const forKnown = await solved(bench, "password.requestReset");
		const forUnknown = await solved(bench, "password.requestReset");

		const known = await sequenceOf(bench, () =>
			bench.handler(postWithSolution(RESET, { email: "known@example.com" }, forKnown)),
		);
		const unknown = await sequenceOf(bench, () =>
			bench.handler(postWithSolution(RESET, { email: "nobody@example.com" }, forUnknown)),
		);

		expect(unknown.status).toBe(known.status);
		expect(unknown.body).toBe(known.body);
		expect(unknown.statements).toStrictEqual(known.statements);
	});

	it("asks a known and an unknown identifier for a proof with the same statements and the same answer", async () => {
		const bench = await openBench("powrev_signin_uniform");
		await bench.auth.signUp.withPassword({
			...signUpBody("known@example.com"),
			origin: TEST_ORIGIN,
			proofOfWork: await (async () => {
				const challenge = await bench.auth.proofOfWork.challenge({
					route: "signUp.withPassword",
					origin: TEST_ORIGIN,
				});
				return { challenge: challenge.challenge, nonce: await solveProofOfWork(challenge) };
			})(),
		});
		const signIn = (email: string) =>
			postWithSolution("/sign-in/password", { email, password: "wrong-password-xx" }, null);
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await bench.from(signIn("known@example.com"), "198.51.100.10");
			await bench.from(signIn("nobody@example.com"), "198.51.100.11");
		}

		const known = await sequenceOf(bench, () =>
			bench.from(signIn("known@example.com"), "198.51.100.10"),
		);
		const unknown = await sequenceOf(bench, () =>
			bench.from(signIn("nobody@example.com"), "198.51.100.11"),
		);

		expect(JSON.parse(known.body).error.code).toBe("proof_of_work_required");
		expect(unknown.body).toBe(known.body);
		expect(unknown.statements).toStrictEqual(known.statements);
		expect(known.statements.some((sql) => sql.includes(".user "))).toBe(false);
	});

	it("records the same failure rows for a known and an unknown identifier and none in the clear", async () => {
		const bench = await openBench("powrev_counter_rows");
		bench.threshold = 100;
		await bench.auth.signUp.withPassword({
			...signUpBody("known@example.com"),
			origin: TEST_ORIGIN,
			proofOfWork: await (async () => {
				const challenge = await bench.auth.proofOfWork.challenge({
					route: "signUp.withPassword",
					origin: TEST_ORIGIN,
				});
				return { challenge: challenge.challenge, nonce: await solveProofOfWork(challenge) };
			})(),
		});
		const signIn = (email: string) =>
			postWithSolution("/sign-in/password", { email, password: "wrong-password-xx" }, null);

		await bench.from(signIn("known@example.com"), "198.51.100.20");
		await bench.from(signIn("nobody@example.com"), "198.51.100.21");
		const rows = await bench.connection.query<{ bucket_key: string; tokens: number }>(
			`SELECT bucket_key, tokens FROM ${bench.schema}.rate_bucket WHERE bucket_key LIKE 'failures|%' ORDER BY bucket_key`,
			[],
		);

		expect(rows).toHaveLength(4);
		expect(rows.filter((row) => row.bucket_key.startsWith("failures|account|"))).toHaveLength(2);
		expect(rows.every((row) => Number(row.tokens) === 1)).toBe(true);
		expect(rows.some((row) => /known|nobody|example/.test(row.bucket_key))).toBe(false);
	});
});

describe("the one stable code (S-RATE-9)", () => {
	it("answers the same status, body and headers on every guarded route for every reason", async () => {
		const keys = testKeyProvider();
		const bench = await openBench("powrev_one_code", { keys });
		const pastChallenge = await createProofOfWorkChallenges(keys).issue({
			route: "password.requestReset",
			difficulty: 1,
			expiresAt: new Date(Date.now() - 60_000),
		});
		const expired = writtenSolution(pastChallenge.challenge, await solveProofOfWork(pastChallenge));
		const spent = await solved(bench, "password.requestReset");
		await bench.handler(postWithSolution(RESET, { email: "c@example.com" }, spent));
		const mailsBefore = bench.mails.length;

		const answers = [
			await bench.handler(postWithSolution(RESET, { email: "c@example.com" }, null)),
			await bench.handler(postWithSolution(RESET, { email: "c@example.com" }, expired)),
			await bench.handler(postWithSolution(RESET, { email: "c@example.com" }, spent)),
			await bench.handler(postWithSolution(MAGIC_LINK, { email: "c@example.com" }, "x")),
			await bench.handler(postWithSolution(SIGN_UP, signUpBody("c@example.com"), spent)),
			await bench.handler(postWithSolution(SIGN_UP_PASSWORDLESS, { email: "c@example.com" }, null)),
		];

		const shapes = new Set<string>();
		for (const answer of answers) {
			const headers = [...answer.headers.entries()]
				.filter(([name]) => name !== "date")
				.sort(([a], [b]) => a.localeCompare(b));
			shapes.add(JSON.stringify({ status: answer.status, headers, body: await answer.text() }));
		}
		expect(shapes.size).toBe(1);
		expect(bench.mails).toHaveLength(mailsBefore);
	});
});

describe("the bounds the library holds the application to, read over the challenge route (S-RATE-12)", () => {
	it("clamps every answer the difficulty function gives and asks it on every challenge", async () => {
		let asked = 0;
		let answer: unknown = 0;
		const bench = await openBench("powrev_clamp", {
			proofOfWork: {
				difficulty: () => {
					asked += 1;
					return answer as number;
				},
				signInFailuresBeforeProof: () => 3,
			},
		});
		const cases: readonly (readonly [unknown, number])[] = [
			[1e9, 20],
			[21, 20],
			[20, 20],
			[3.2, 4],
			[0, 0],
			[-3, 0],
			[Number.NEGATIVE_INFINITY, 0],
			[Number.POSITIVE_INFINITY, 20],
			[Number.NaN, 20],
			["16", 20],
			[undefined, 20],
			[null, 20],
		];

		for (const [given, expected] of cases) {
			answer = given;
			const challenge = await issued(bench, "signUp.withPassword");
			expect(challenge.difficulty, String(given)).toBe(expected);
			expect(challenge.challenge.split(".")[1]).toBe(String(expected));
		}
		expect(asked).toBe(cases.length);
	});

	it("asks for a proof after the first failure when the threshold is zero, negative or no number", async () => {
		for (const threshold of [0, -5, Number.NaN, "3"]) {
			const bench = await openBench("powrev_threshold");
			bench.threshold = threshold;
			const signIn = () =>
				postWithSolution(
					"/sign-in/password",
					{ email: "t@example.com", password: "wrong-password-xx" },
					null,
				);

			const first = await bench.from(signIn(), "198.51.100.30");
			const second = await bench.from(signIn(), "198.51.100.30");

			expect(await codeOf(first), String(threshold)).toBe("invalid_credentials");
			expect(await codeOf(second), String(threshold)).toBe("proof_of_work_required");
		}
	});
});

describe("everything is absent without rateLimit.proofOfWork (S-RATE-12)", () => {
	it("mounts no route, no namespace, writes no counter and ignores a solution sent along", async () => {
		const bench = await openBench("powrev_absent", { proofOfWork: null });
		const challenge = await bench.handler(challengeRequest("signUp.withPassword"));
		const withHeader = postWithSolution(SIGN_UP, signUpBody("h@example.com"), "1.2.3");
		const signedUp = await bench.handler(withHeader);
		const direct = await bench.auth.signUp.withPassword({
			...signUpBody("d@example.com"),
			origin: TEST_ORIGIN,
			proofOfWork: { challenge: "nonsense", nonce: 1 },
		});
		for (let attempt = 0; attempt < 5; attempt += 1) {
			await bench.from(
				postWithSolution(
					"/sign-in/password",
					{ email: "h@example.com", password: "wrong-password-xx" },
					null,
				),
				"198.51.100.40",
			);
		}

		expect(challenge.status).toBe(404);
		expect(signedUp.status).toBe(200);
		expect(direct.user.email).toBe("d@example.com");
		expect((bench.auth as unknown as Record<string, unknown>).proofOfWork).toBeUndefined();
		expect(bench.auth.routes.some((route) => route.name === "proofOfWork.challenge")).toBe(false);
		expect(await count(bench, "rate_bucket", "bucket_key LIKE 'failures|%'")).toBe(0);
		expect(touching(bench, "proof_of_work_spent")).toStrictEqual([]);
		expect(bench.statements.some((statement) => statement.sql.includes("failures"))).toBe(false);
	});
});

describe("the key the challenges are signed under (E-3661, E-3662)", () => {
	it("refuses the start when the cookie-sig key cannot take a MAC and the proof of work is configured", async () => {
		const inner = testKeyProvider();
		const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
			"encrypt",
			"decrypt",
		]);
		const keys: KeyProvider = {
			current: async (purpose) =>
				purpose === "cookie-sig" ? { version: 1, key: aes } : inner.current(purpose),
			byVersion: async (purpose, version) =>
				purpose === "cookie-sig" ? (version === 1 ? aes : null) : inner.byVersion(purpose, version),
		};
		const bench = await openBench("powrev_cookie_sig", { keys });

		const started = await bench.auth.migrate().then(
			() => "started",
			() => "refused",
		);
		const signUp = await bench.handler(
			postWithSolution(SIGN_UP, signUpBody("k@example.com"), null),
		);

		expect(await codeOf(signUp)).toBe("proof_of_work_required");
		expect(started).toBe("refused");
	});
});

describe("the hash both sides take (E-3663)", () => {
	it("is SHA-256 over the challenge's UTF-8 and the eight-byte big-endian nonce, checked at the boundary", async () => {
		const challenge = "1.4.2000000000.value.mac";
		const nonce = 2 ** 53 - 1;
		const expected = new Uint8Array(new TextEncoder().encode(challenge).length + 8);
		expected.set(new TextEncoder().encode(challenge), 0);
		new DataView(expected.buffer).setBigUint64(expected.length - 8, BigInt(nonce));

		expect([...proofOfWorkInput(challenge, nonce)]).toStrictEqual([...expected]);
		expect(isSolvedAt(new Uint8Array([0x00, 0x0f, 0xff]), 12)).toBe(true);
		expect(isSolvedAt(new Uint8Array([0x00, 0x1f, 0xff]), 12)).toBe(false);
	});
});

describe("a plugin route of an instance without the proof of work (S-RATE-12)", () => {
	it("keeps an input field named proofOfWork, as it did before the proof of work existed", async () => {
		const plugin: VelvePlugin<"quiz"> = {
			id: "quiz",
			routes: [
				{
					name: "quiz.answer",
					method: "POST",
					path: "/x/quiz/answer",
					input: object({ proofOfWork: string() }),
					errors: ["rate_limited"],
					caller: "anonymous",
					freshness: "not_required",
					originCheck: "checked",
					rateLimit: { perIpAddress: { capacity: 1000, refillPerSecond: 10 }, perAccount: "none" },
					handler: async (input: { proofOfWork: string }) => ({ echoed: input.proofOfWork }),
				} as unknown as PluginRoute<"quiz">,
			],
		};

		const mounted = await openBench("powrev_plugin_field", {
			proofOfWork: null,
			overrides: { plugins: [plugin] },
		}).then(
			(bench) => bench,
			(error: Error) => error,
		);

		expect(mounted instanceof Error ? mounted.message : "mounted").toBe("mounted");
	});
});
