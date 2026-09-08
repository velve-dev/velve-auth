import { describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { InvalidIdentifierError } from "../src/core/db/identifier.js";
import {
	createOneTimeTokenRepository,
	OneTimeTokenError,
} from "../src/core/db/repositories/token.js";
import {
	ONE_TIME_TOKEN_LIFETIME_SECONDS,
	type OneTimeTokenPurpose,
} from "../src/core/token/index.js";

interface Call {
	readonly sql: string;
	readonly params: readonly unknown[];
}

const OWNER_FOUND = [{ locked: 1 }];

function driverReturning(
	rows: readonly unknown[],
	ownerRows: readonly unknown[] = OWNER_FOUND,
): { driver: Driver; calls: Call[] } {
	const calls: Call[] = [];
	const driver: Driver = {
		query<T>(sql: string, params: unknown[]): Promise<T[]> {
			calls.push({ sql, params });
			return Promise.resolve((/FOR UPDATE/.test(sql) ? ownerRows : rows) as T[]);
		},
		transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
			return fn(driver);
		},
	};
	return { driver, calls };
}

function repositoryReturning(rows: readonly unknown[], ownerRows?: readonly unknown[]) {
	const { driver, calls } = driverReturning(rows, ownerRows);
	return { repository: createOneTimeTokenRepository({ driver, schema: "velve" }), calls };
}

const HASH = new Uint8Array(32).fill(7);

describe("the parameters the repository sends", () => {
	it("binds owner, purpose, hash, payload and the purpose's own deadline, in that order", async () => {
		const { repository, calls } = repositoryReturning([{ expires_at: "2026-09-08T00:00:00.000Z" }]);

		const issued = await repository.replaceOneTimeToken({
			tokenSha256: HASH,
			purpose: "password_reset",
			userId: "0d1b6c8e-0000-4000-8000-000000000001",
			payload: { newEmail: "next@example.com" },
		});

		expect(calls).toHaveLength(2);
		expect(calls[0]?.sql).toContain("FOR UPDATE");
		expect(calls[0]?.params).toStrictEqual(["0d1b6c8e-0000-4000-8000-000000000001"]);
		expect(calls[1]?.params).toStrictEqual([
			"0d1b6c8e-0000-4000-8000-000000000001",
			"password_reset",
			HASH,
			'{"newEmail":"next@example.com"}',
			ONE_TIME_TOKEN_LIFETIME_SECONDS.password_reset,
		]);
		expect(issued.expiresAt).toBe("2026-09-08T00:00:00.000Z");
	});

	it("sends a null payload as null rather than as the text null", async () => {
		const { repository, calls } = repositoryReturning([{ expires_at: "2026-09-08T00:00:00.000Z" }]);

		await repository.replaceOneTimeToken({
			tokenSha256: HASH,
			purpose: "magic_link",
			userId: "0d1b6c8e-0000-4000-8000-000000000001",
			payload: null,
		});

		expect(calls[1]?.params[3]).toBeNull();
	});

	it("locks the owner row before it replaces anything (S-TOKEN-3, E-259)", async () => {
		const { repository, calls } = repositoryReturning([{ expires_at: "2026-09-08T00:00:00.000Z" }]);

		await repository.replaceOneTimeToken({
			tokenSha256: HASH,
			purpose: "magic_link",
			userId: "0d1b6c8e-0000-4000-8000-000000000001",
			payload: null,
		});

		expect(calls.map((call) => call.sql.split("\n")[0])).toStrictEqual([
			"SELECT 1 FROM velve.user WHERE id = $1 FOR UPDATE",
			"WITH superseded AS (",
		]);
	});

	it("sends the hash and the purpose together for a lookup", async () => {
		const { repository, calls } = repositoryReturning([]);

		await repository.consumeOneTimeToken({ tokenSha256: HASH, purpose: "email_verify" });

		expect(calls[0]?.params).toStrictEqual([HASH, "email_verify"]);
	});
});

describe("the payload a driver hands back", () => {
	it("is taken as it is when the driver decoded the jsonb", async () => {
		const { repository } = repositoryReturning([
			{ user_id: "a", payload: { newEmail: "next@example.com" } },
		]);

		const stored = await repository.consumeOneTimeToken({
			tokenSha256: HASH,
			purpose: "email_change",
		});

		expect(stored).toStrictEqual({ userId: "a", payload: { newEmail: "next@example.com" } });
	});

	it("is parsed when the driver handed back the text PostgreSQL sent", async () => {
		const { repository } = repositoryReturning([
			{ user_id: "a", payload: '{"newEmail":"next@example.com"}' },
		]);

		const stored = await repository.consumeOneTimeToken({
			tokenSha256: HASH,
			purpose: "email_change",
		});

		expect(stored).toStrictEqual({ userId: "a", payload: { newEmail: "next@example.com" } });
	});

	it("is null for a row without one", async () => {
		const { repository } = repositoryReturning([{ user_id: "a", payload: null }]);

		expect(
			await repository.consumeOneTimeToken({ tokenSha256: HASH, purpose: "email_change" }),
		).toStrictEqual({ userId: "a", payload: null });
	});

	it("is null for a driver that omits the column altogether", async () => {
		const { repository } = repositoryReturning([{ user_id: "a" }]);

		expect(
			await repository.consumeOneTimeToken({ tokenSha256: HASH, purpose: "email_change" }),
		).toStrictEqual({ userId: "a", payload: null });
	});
});

describe("what the repository refuses", () => {
	it("raises when the insert reports no row, and names no secret while doing it", async () => {
		const { repository } = repositoryReturning([]);

		await expect(
			repository.replaceOneTimeToken({
				tokenSha256: HASH,
				purpose: "magic_link",
				userId: "0d1b6c8e-0000-4000-8000-000000000001",
				payload: null,
			}),
		).rejects.toThrow(OneTimeTokenError);
	});

	it("codes the three refusals and lets none of them carry an input", async () => {
		const raise = async (
			rows: readonly unknown[],
			ownerRows: readonly unknown[],
			purpose: OneTimeTokenPurpose,
		) => {
			const { repository } = repositoryReturning(rows, ownerRows);
			return (await repository
				.replaceOneTimeToken({
					tokenSha256: HASH,
					purpose,
					userId: "0d1b6c8e-0000-4000-8000-000000000001",
					payload: { secret: "must-not-appear" },
				})
				.catch((error: unknown) => error)) as OneTimeTokenError;
		};

		const written = [{ expires_at: "2026-09-08T00:00:00.000Z" }];
		const unknownPurpose = "totp_step" as unknown as OneTimeTokenPurpose;
		const raised = [
			await raise(written, [], "magic_link"),
			await raise(written, OWNER_FOUND, unknownPurpose),
			await raise([], OWNER_FOUND, "magic_link"),
		];

		expect(raised.map((error) => error.code)).toStrictEqual([
			"one_time_token_owner_unknown",
			"one_time_token_purpose_unknown",
			"one_time_token_not_written",
		]);
		for (const error of raised) {
			expect(error).toBeInstanceOf(OneTimeTokenError);
			expect(`${error.message} ${error.stack ?? ""}`).not.toContain("must-not-appear");
		}
	});

	it("writes nothing when the account is gone", async () => {
		const { repository, calls } = repositoryReturning([], []);

		await repository
			.replaceOneTimeToken({
				tokenSha256: HASH,
				purpose: "magic_link",
				userId: "0d1b6c8e-0000-4000-8000-000000000001",
				payload: null,
			})
			.catch(() => undefined);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.sql).toContain("FOR UPDATE");
	});

	it("reaches no driver at all for a purpose it does not know", async () => {
		const { repository, calls } = repositoryReturning([]);

		await repository
			.replaceOneTimeToken({
				tokenSha256: HASH,
				purpose: "totp_step" as unknown as OneTimeTokenPurpose,
				userId: "0d1b6c8e-0000-4000-8000-000000000001",
				payload: null,
			})
			.catch(() => undefined);

		expect(calls).toStrictEqual([]);
	});

	it("refuses a schema name that is not an identifier", () => {
		const { driver } = driverReturning([]);

		expect(() => createOneTimeTokenRepository({ driver, schema: "velve; drop" })).toThrow(
			InvalidIdentifierError,
		);
	});
});
