import { describe, expect, it } from "vitest";
import type { Driver } from "../src/core/db/driver.js";
import { InvalidIdentifierError } from "../src/core/db/identifier.js";
import { createOneTimeTokenRepository } from "../src/core/db/repositories/token.js";
import { ONE_TIME_TOKEN_LIFETIME_SECONDS } from "../src/core/token/index.js";

interface Call {
	readonly sql: string;
	readonly params: readonly unknown[];
}

function driverReturning(rows: readonly unknown[]): { driver: Driver; calls: Call[] } {
	const calls: Call[] = [];
	const driver: Driver = {
		query<T>(sql: string, params: unknown[]): Promise<T[]> {
			calls.push({ sql, params });
			return Promise.resolve(rows as T[]);
		},
		transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T> {
			return fn(driver);
		},
	};
	return { driver, calls };
}

function repositoryReturning(rows: readonly unknown[]) {
	const { driver, calls } = driverReturning(rows);
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

		expect(calls).toHaveLength(1);
		expect(calls[0]?.params).toStrictEqual([
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

		expect(calls[0]?.params[3]).toBeNull();
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
		).rejects.toThrow("velve.one_time_token accepted no row for purpose magic_link");
	});

	it("refuses a schema name that is not an identifier", () => {
		const { driver } = driverReturning([]);

		expect(() => createOneTimeTokenRepository({ driver, schema: "velve; drop" })).toThrow(
			InvalidIdentifierError,
		);
	});
});
