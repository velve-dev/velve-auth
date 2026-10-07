import type { RouteServices } from "../auth/routes.js";
import { createPasswordCredentialRepository } from "./credential.js";
import { storedMemoryCeilingKiB } from "./limits.js";
import { createDummyCredential, type PasswordEnvironment } from "./verify.js";

export type PasswordEnvironmentReader = () => Promise<PasswordEnvironment>;

//the dummy Argon2 hash is started early and only awaited on the measured path (E-1183)
export function createPasswordEnvironmentReader(
	services: RouteServices,
): PasswordEnvironmentReader {
	const credentials = createPasswordCredentialRepository({
		driver: services.driver,
		keys: services.keys,
		schema: services.schema,
		memoryCeilingKiB: storedMemoryCeilingKiB(services.password.argon2id.memoryKiB),
		unboundEnvelopes: services.unboundEnvelopes,
	});
	const dummy = createDummyCredential(services.keys, services.password);
	//the eager start must not become an unhandled rejection before a check awaits it (E-1183)
	dummy.catch(() => undefined);

	return async () => ({
		config: services.password,
		semaphore: services.kdfSemaphore,
		keys: services.keys,
		credentials,
		dummy: await dummy,
	});
}
