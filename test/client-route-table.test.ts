import { describe, expectTypeOf, it } from "vitest";
import type { VelveRouteTable } from "../src/client/routes.js";
import type { pendingRoutes, sessionRoutes, usernameRoutes } from "../src/core/auth/routes.js";
import type { FactorRouteTable } from "../src/core/factor/routes.js";
import type { EmailFlowRouteTable } from "../src/core/flows/routes.js";
import type { oauthRoutes } from "../src/core/oauth/routes.js";
import type { passwordRoutes } from "../src/core/password/routes.js";

//the client's route table is written out and must stay the table the server route factories build (E-3488)

type ServerRouteTable = readonly [
	...ReturnType<typeof sessionRoutes>,
	...ReturnType<typeof usernameRoutes>,
	...ReturnType<typeof pendingRoutes>,
	...ReturnType<typeof oauthRoutes>,
	...EmailFlowRouteTable,
	...ReturnType<typeof passwordRoutes>,
	...FactorRouteTable,
];

type EachAssignableToTheOther<Left, Right> = [Left] extends [Right]
	? [Right] extends [Left]
		? true
		: false
	: false;

describe("the client's route table", () => {
	it("is the table the server's route factories build, each assignable to the other", () => {
		expectTypeOf<
			EachAssignableToTheOther<VelveRouteTable, ServerRouteTable>
		>().toEqualTypeOf<true>();
	});
});
