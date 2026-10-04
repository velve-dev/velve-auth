import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The counter sits under the real derivation rather than beside it, so a KDF call the route makes
// outside the semaphore is counted too. The wrapper forwards to the original.
const derivations: string[] = [];

vi.mock("@noble/hashes/argon2.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("@noble/hashes/argon2.js")>();
	return {
		...original,
		argon2idAsync: (...args: Parameters<typeof original.argon2idAsync>) => {
			derivations.push("argon2id");
			return original.argon2idAsync(...args);
		},
	};
});

// The optional accelerator derives in WebAssembly and calls nothing counted above (E-180).
vi.doMock("hash-wasm", () => {
	throw new Error("the accelerator is out of the way for this measurement");
});

const { toWebHandler } = await import("../src/core/http/web-handler.js");
const { createVelveAuth } = await import("../src/index.js");
const { configFor } = await import("./auth-fixtures.js");
const { dropSchema, openMigratedSchema } = await import("./db-fixtures.js");
const { postTo } = await import("./flows-fixtures.js");

type Handler = (request: Request) => Promise<Response>;
type Connection = Awaited<ReturnType<typeof openMigratedSchema>>["connection"];

const ROUTE = "/password/redeem-reset-with-recovery-code";
const ROUTE_NAME = "password.redeemResetWithRecoveryCode";
const ACCOUNT_CAPACITY = 2;
const NEW_PASSWORD = "correct-horse-battery-staple";
const WRONG_CODE = "aaaaa-bbbbb";

/** Three NFKC-equivalent spellings of one address: case, surrounding space and fullwidth forms. */
function spellingsOf(local: string): readonly string[] {
	const fullwidth = [...local]
		.map((character) => String.fromCodePoint((character.codePointAt(0) ?? 0) + 0xfee0))
		.join("");
	return [
		`${local}@example.com`,
		`  ${local.toUpperCase()}@Example.com  `,
		`${fullwidth}@example.com`,
	];
}

/**
 * S-RATE-7 and T-RATE-7 on the recovery-code reset, the one anonymous password route the sign-in
 * suite does not reach. Its account counter was keyed by the identifier as submitted, so each
 * spelling of one address opened a fresh bucket, and the KDF ran before the bucket was asked.
 */
describe("the recovery-code reset counts one account however it is spelled (S-RATE-7)", () => {
	let mount: { connection: Connection; schema: string; handler: Handler };

	beforeAll(async () => {
		const { connection, schema } = await openMigratedSchema("recoveryrate");
		const auth = createVelveAuth(
			configFor({
				database: connection,
				schema,
				rateLimit: {
					perIpAddress: { capacity: 100_000, refillPerSecond: 100_000 },
					perAccount: { capacity: ACCOUNT_CAPACITY, refillPerSecond: 0 },
				},
			}),
		);
		mount = { connection, schema, handler: toWebHandler(auth) };

		const created = await mount.handler(
			postTo("/sign-up", { email: "present@example.com", password: NEW_PASSWORD }),
		);
		expect(created.status).toBe(200);
	});

	afterAll(async () => {
		await dropSchema(mount.connection, mount.schema);
		await mount.connection.close();
	});

	async function codeOf(answer: Response): Promise<string> {
		return ((await answer.json()) as { error: { code: string } }).error.code;
	}

	async function accountBucketsOfRoute(): Promise<number> {
		const rows = await mount.connection.query<{ count: string }>(
			`SELECT count(*) AS count FROM ${mount.schema}.rate_bucket WHERE starts_with(bucket_key, $1)`,
			[`account|${ROUTE_NAME}|`],
		);
		return Number(rows[0]?.count);
	}

	async function attemptsAcross(local: string) {
		const outcomes: { code: string; derived: number }[] = [];
		for (const email of spellingsOf(local)) {
			const before = derivations.length;
			const answer = await mount.handler(
				postTo(ROUTE, { email, recoveryCode: WRONG_CODE, newPassword: NEW_PASSWORD }),
			);
			outcomes.push({ code: await codeOf(answer), derived: derivations.length - before });
		}
		return outcomes;
	}

	it.each([
		["an existing account", "present"],
		["an identifier no account has", "absent"],
	])(
		"refuses the third spelling of %s with rate_limited and derives nothing for it",
		async (_, local) => {
			const bucketsBefore = await accountBucketsOfRoute();

			const outcomes = await attemptsAcross(local);

			expect(outcomes.map((outcome) => outcome.code)).toEqual([
				"invalid_recovery_code",
				"invalid_recovery_code",
				"rate_limited",
			]);
			expect(outcomes.map((outcome) => outcome.derived)).toEqual([1, 1, 0]);
			expect((await accountBucketsOfRoute()) - bucketsBefore).toBe(1);
		},
	);
});
