import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	exactAnswer,
	jsonPost,
	mountWidest,
	plainGet,
	type SignedUpAccount,
	signUpOn,
	type WidestMount,
} from "./widest-mount-fixtures.js";

let mount: WidestMount;
let victim: SignedUpAccount;
let caller: SignedUpAccount;

beforeAll(async () => {
	mount = await mountWidest("ownerrevoke");
	victim = await signUpOn(mount);
	caller = await signUpOn(mount);
});

afterAll(async () => {
	await mount.close();
});

async function sessionTable(): Promise<string> {
	const rows = await mount.connection.query<{ rendered: string }>(
		`SELECT s::text AS rendered FROM ${mount.schema}.session s ORDER BY s.id`,
		[],
	);
	return rows.map((row) => row.rendered).join("\n");
}

describe("T-OWNER-4: revoking another account's session over HTTP (S-OWNER-4)", () => {
	it("answers 204 to a foreign and an invented id, byte for byte alike, and changes no row", async () => {
		const before = await sessionTable();

		const foreign = await mount.handler(
			jsonPost("/session/revoke", { targetSessionId: victim.sessionId }, caller.sessionCookie),
		);
		const invented = await mount.handler(
			jsonPost("/session/revoke", { targetSessionId: randomUUID() }, caller.sessionCookie),
		);

		expect([foreign.status, invented.status]).toStrictEqual([204, 204]);
		expect(await exactAnswer(foreign)).toBe(await exactAnswer(invented));
		expect(await sessionTable()).toBe(before);
		expect(before.split("\n")).toHaveLength(2);
	});

	it("leaves the victim's session resolving afterwards", async () => {
		const resolved = await mount.handler(plainGet("/session", victim.sessionCookie));
		const body = (await resolved.json()) as { session?: { id?: string } } | null;

		expect(resolved.status).toBe(200);
		expect(body?.session?.id).toBe(victim.sessionId);
	});

	//the same request against the caller's own session is what shows the route acts at all
	it("revokes the caller's own session when it names it", async () => {
		const own = await mount.handler(
			jsonPost("/session/revoke", { targetSessionId: caller.sessionId }, caller.sessionCookie),
		);
		const [row] = await mount.connection.query<{ remaining: number }>(
			`SELECT count(*)::int AS remaining FROM ${mount.schema}.session WHERE id = $1`,
			[caller.sessionId],
		);

		expect(own.status).toBe(204);
		expect(row?.remaining).toBe(0);
	});
});
