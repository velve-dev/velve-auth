import type { RouteServices } from "../auth/routes.js";
import { createPasswordCredentialRepository } from "./credential.js";
import { createKdfSemaphore } from "./semaphore.js";
import { createDummyCredential, type PasswordEnvironment } from "./verify.js";

export type PasswordEnvironmentReader = () => Promise<PasswordEnvironment>;

/**
 * S-TIM-2 wants the absent-account branch to verify against a dummy carrying the configured
 * parameters, and deriving one costs a full Argon2id hash — so it is started when the routes are
 * built and merely awaited on the path the requirement measures (E-1183).
 */
export function createPasswordEnvironmentReader(
	services: RouteServices,
): PasswordEnvironmentReader {
	const semaphore = createKdfSemaphore({ limit: services.password.concurrentHashLimit });
	const credentials = createPasswordCredentialRepository({
		driver: services.driver,
		keys: services.keys,
		schema: services.schema,
	});
	const dummy = createDummyCredential(services.keys, services.password);
	// E-1183: the rejection is delivered to whichever check first awaits it, and this keeps the
	// eager start from being an unhandled rejection until one does.
	dummy.catch(() => undefined);

	return async () => ({
		config: services.password,
		semaphore,
		keys: services.keys,
		credentials,
		dummy: await dummy,
	});
}
