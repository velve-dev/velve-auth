import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnyRoute } from "../src/core/http/route.js";
import {
	exactAnswer,
	jsonPost,
	mountWidest,
	type SignedUpAccount,
	signUpOn,
	type WidestMount,
} from "./widest-mount-fixtures.js";

let mount: WidestMount;
let owner: SignedUpAccount;
let caller: SignedUpAccount;
let ownersObjects: Readonly<Record<string, string>>;

const ID_SHAPED = /Id$/;

//a built route keeps its input validator, which the metadata type does not name
type DeclaredRoute = AnyRoute & { readonly input: { readonly fields: readonly string[] } };

//every route whose input names an object by its identifier, as the widest table declares it
function routesTakingAnId(routes: readonly AnyRoute[]): readonly DeclaredRoute[] {
	return (routes as readonly DeclaredRoute[]).filter((route) =>
		route.input.fields.some((field) => ID_SHAPED.test(field)),
	);
}

const FIELDS_BESIDE_THE_ID: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	"factor.webauthn.rename": { label: "the same label both times" },
};

async function insertedId(sql: string, params: readonly unknown[]): Promise<string> {
	const [row] = await mount.connection.query<{ id: string }>(sql, [...params]);
	if (row === undefined) {
		throw new Error("the owner's object was not created");
	}
	return row.id;
}

function identityOf(userId: string): Promise<string> {
	return insertedId(
		`INSERT INTO ${mount.schema}.identity (user_id, provider, subject, provider_email_verified)
		 VALUES ($1, 'stubby', $2, false) RETURNING id`,
		[userId, randomUUID()],
	);
}

function credentialOf(userId: string): Promise<string> {
	return insertedId(
		`INSERT INTO ${mount.schema}.webauthn_credential
		 (user_id, credential_id, public_key, backup_eligible, backup_state, user_verified_at_registration, label)
		 VALUES ($1, $2, $3, false, false, true, 'a key') RETURNING id`,
		[userId, randomBytes(32), randomBytes(32)],
	);
}

function secondSessionOf(userId: string): Promise<string> {
	return insertedId(
		`INSERT INTO ${mount.schema}.session (user_id, token_sha256, idle_expires_at, absolute_expires_at)
		 VALUES ($1, $2, now() + interval '1 day', now() + interval '7 days') RETURNING id`,
		[userId, randomBytes(32)],
	);
}

beforeAll(async () => {
	mount = await mountWidest("ownerforeign");
	owner = await signUpOn(mount);
	caller = await signUpOn(mount);
	ownersObjects = {
		targetSessionId: owner.sessionId,
		identityId: await identityOf(owner.userId),
		credentialId: await credentialOf(owner.userId),
	};
});

afterAll(async () => {
	await mount.close();
});

function inputFor(
	route: DeclaredRoute,
	ids: Readonly<Record<string, string>>,
): Record<string, string> {
	const beside = FIELDS_BESIDE_THE_ID[route.name] ?? {};
	return Object.fromEntries(
		route.input.fields.map((field) => {
			const value = ID_SHAPED.test(field) ? ids[field] : beside[field];
			if (value === undefined) {
				throw new Error(`${route.name} takes ${field}, which this proof has no value for`);
			}
			return [field, value];
		}),
	);
}

async function rowsOf(userId: string): Promise<string> {
	const rows = await mount.connection.query<{ rendered: string }>(
		`SELECT 'session ' || s::text AS rendered FROM ${mount.schema}.session s WHERE s.user_id = $1
		 UNION ALL SELECT 'identity ' || i::text FROM ${mount.schema}.identity i WHERE i.user_id = $1
		 UNION ALL SELECT 'credential ' || w::text FROM ${mount.schema}.webauthn_credential w WHERE w.user_id = $1
		 ORDER BY 1`,
		[userId],
	);
	return rows.map((row) => row.rendered).join("\n");
}

describe("T-OWNER-8: a foreign identifier and an invented one are one answer (S-OWNER-8)", () => {
	it("finds the routes that take an object identifier in the widest table", () => {
		expect(mount.auth.routes).toHaveLength(47);
		expect(routesTakingAnId(mount.auth.routes).map((route) => route.name)).toStrictEqual([
			"session.revoke",
			"identity.unlink",
			"factor.webauthn.rename",
			"factor.webauthn.remove",
		]);
	});

	it("answers every one of them byte for byte alike, and leaves the owner's rows as they were", async () => {
		const before = await rowsOf(owner.userId);
		const differing: string[] = [];

		for (const route of routesTakingAnId(mount.auth.routes)) {
			const invented = Object.fromEntries(Object.keys(ownersObjects).map((f) => [f, randomUUID()]));
			const foreignAnswer = await mount.handler(
				jsonPost(route.path, inputFor(route, ownersObjects), caller.sessionCookie),
			);
			const inventedAnswer = await mount.handler(
				jsonPost(route.path, inputFor(route, invented), caller.sessionCookie),
			);
			const [foreign, made] = [await exactAnswer(foreignAnswer), await exactAnswer(inventedAnswer)];
			if (foreign !== made) {
				differing.push(`${route.name}\n${foreign}\nagainst\n${made}`);
			}
		}

		expect(differing).toStrictEqual([]);
		expect(await rowsOf(owner.userId)).toBe(before);
		expect(before.split("\n")).toHaveLength(3);
	});

	//the caller's own identifiers are what show each route reaches the row it is given at all
	it("changes the caller's own row when the same route is given the caller's own identifier", async () => {
		const unchanged: string[] = [];
		const own: Readonly<Record<string, Readonly<Record<string, string>>>> = {
			"session.revoke": { targetSessionId: await secondSessionOf(caller.userId) },
			"identity.unlink": { identityId: await identityOf(caller.userId) },
			"factor.webauthn.rename": { credentialId: await credentialOf(caller.userId) },
			"factor.webauthn.remove": { credentialId: await credentialOf(caller.userId) },
		};

		for (const route of routesTakingAnId(mount.auth.routes)) {
			const before = await rowsOf(caller.userId);
			const answer = await mount.handler(
				jsonPost(route.path, inputFor(route, own[route.name] ?? {}), caller.sessionCookie),
			);
			if (answer.status >= 300 || (await rowsOf(caller.userId)) === before) {
				unchanged.push(`${route.name} answered ${answer.status}`);
			}
		}

		expect(unchanged).toStrictEqual([]);
	});
});
