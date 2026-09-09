import type {
	Identity,
	OAuthCallbackResult,
	OAuthRedirect,
	SignInResult,
} from "../auth/results.js";
import type { RouteServices } from "../auth/routes.js";
import { createUserRepository, type User } from "../auth/user.js";
import type { Actor } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { type OAuthResponseDelivery, oauthStateCookieFor } from "../http/cookies.js";
import { ConcealedError, VelveError } from "../http/error-map.js";
import type { RedirectPath } from "../http/redirect.js";
import { identityColumns } from "../identity/columns.js";
import { removeSignInMethod } from "../identity/sign-in-methods.js";
import { decryptWithPurposeKey, encryptWithPurposeKey } from "../keys/index.js";
import type { IssuedSession, ObservedRequest } from "../session/service.js";
import { authorizationUrlFor } from "./authorization-request.js";
import { type ProviderAccount, providerAccountOf } from "./claims.js";
import { createOAuthFlowRepository } from "./flow-repository.js";
import {
	createFlowPointer,
	createNonce,
	createPkceVerifier,
	pkceChallengeOf,
	pointerBelongsToState,
	stateHash,
	stateOfPointer,
} from "./flow-secrets.js";
import { claimsOfIdToken } from "./id-token.js";
import {
	createOAuthIdentityRepository,
	type EncryptedProviderTokens,
	type IdentityFacts,
	NO_STORED_TOKENS,
	type OAuthIdentityRepository,
} from "./identity-repository.js";
import { accountAnAutomaticLinkMayJoin } from "./linking.js";
import type { OutboundFetch } from "./outbound.js";
import type { ProviderTable, ResolvedProvider } from "./providers.js";
import { acceptedRedirectPath, DEFAULT_REDIRECT_PATH } from "./redirect-path.js";
import { exchangeAuthorizationCode, type ProviderTokens } from "./token-exchange.js";
import { claimsFromUserInfo } from "./user-info.js";

/** 3.15 C.1 plus the path the 302 carries, which is the only `Location` the library emits (S-REDIR-3). */
export type OAuthCallbackOutcome = OAuthCallbackResult & {
	readonly redirectToPath: RedirectPath;
};

export interface OAuthFlowStart {
	readonly providerId: string;
	readonly redirectPath?: string;
	readonly linkToUserId: string | null;
}

export interface OAuthCallbackArrival {
	readonly providerId: string;
	readonly code: string;
	readonly state: string;
	readonly iss: string | null;
	readonly pointer: string | null;
	readonly sessionToken: string | null;
	readonly observed: ObservedRequest;
}

/** The pointer travels beside the answer so that the route sets the cookie the flow needs (E-541). */
export interface StartedFlow {
	readonly redirect: OAuthRedirect;
	readonly pointer: string;
	readonly delivery: OAuthResponseDelivery;
}

export interface OAuthService {
	beginFlow(input: OAuthFlowStart): Promise<StartedFlow>;
	completeFlow(input: OAuthCallbackArrival): Promise<OAuthCallbackOutcome>;
	listIdentities(input: { readonly actor: Actor }): Promise<Identity[]>;
	unlinkIdentity(input: { readonly actor: Actor; readonly identityId: string }): Promise<void>;
}

interface ResolvedAccount {
	readonly userId: string;
	readonly identity: Identity;
	readonly linked: boolean;
}

const OAUTH_FACTORS = ["oauth"] as const;

const utf8 = new TextEncoder();

function configuredProvider(providers: ProviderTable, id: string): ResolvedProvider {
	const provider = providers.get(id);
	if (provider === undefined) {
		throw new VelveError("provider_not_configured");
	}
	return provider;
}

/** A callback naming a provider this instance does not run is answered exactly as an unknown state. */
function providerOfCallback(providers: ProviderTable, id: string): ResolvedProvider {
	const provider = providers.get(id);
	if (provider === undefined) {
		throw new ConcealedError("state_not_found");
	}
	return provider;
}

/** RFC 9207: an `iss` that no configured issuer answers for is refused rather than passed over. */
function assertIssuerMatches(provider: ResolvedProvider, iss: string | null): void {
	if (iss !== null && iss !== provider.issuer) {
		throw new ConcealedError("issuer_mismatch");
	}
}

async function insertOrRefuse(
	repository: OAuthIdentityRepository,
	userId: string,
	facts: IdentityFacts,
): Promise<Identity> {
	const inserted = await repository.insertIdentity({ userId, ...facts });
	if (inserted === null) {
		throw new VelveError("identity_already_linked");
	}
	return inserted;
}

export function createOAuthService(input: {
	readonly services: RouteServices;
	readonly providers: ProviderTable;
}): OAuthService {
	const { services, providers } = input;
	const driver: Driver = services.driver;
	const schema = services.schema;
	const flows = createOAuthFlowRepository({ driver, schema });
	const identities = createOAuthIdentityRepository({ driver, schema });
	const outbound: OutboundFetch = services.fetch ?? globalThis.fetch;
	const storeTokens = services.oauth?.storeTokens === true;

	async function encryptedProviderTokens(tokens: ProviderTokens): Promise<EncryptedProviderTokens> {
		if (!storeTokens) {
			return NO_STORED_TOKENS;
		}
		const sealed = await Promise.all(
			[tokens.accessToken, tokens.refreshToken, tokens.idToken].map(async (token) =>
				token === null
					? null
					: encryptWithPurposeKey(services.keys, "oauth-token-enc", utf8.encode(token)),
			),
		);
		const versions = new Set(
			sealed.filter((written) => written !== null).map((written) => written.keyVersion),
		);
		// One column carries the version of three ciphertexts, so a rotation between them is refused.
		if (versions.size > 1) {
			throw new VelveError("internal_error");
		}
		return {
			accessTokenEnc: sealed[0]?.ciphertext ?? null,
			refreshTokenEnc: sealed[1]?.ciphertext ?? null,
			idTokenEnc: sealed[2]?.ciphertext ?? null,
			tokenKeyVersion: [...versions][0] ?? null,
		};
	}

	async function factsOf(
		provider: ResolvedProvider,
		account: ProviderAccount,
		tokens: ProviderTokens,
	): Promise<IdentityFacts> {
		return {
			provider: provider.id,
			subject: account.subject,
			providerEmail: account.email,
			providerEmailVerified: account.emailVerified,
			profile: account.claims,
			scopes: tokens.scopes,
			tokenLifetimeInSeconds: storeTokens ? tokens.expiresInSeconds : null,
			tokens: await encryptedProviderTokens(tokens),
		};
	}

	async function claimsOfProvider(
		provider: ResolvedProvider,
		tokens: ProviderTokens,
		nonce: string | null,
	): Promise<Record<string, unknown>> {
		if (provider.jwksUri !== null && tokens.idToken !== null) {
			return claimsOfIdToken({ fetch: outbound, provider, idToken: tokens.idToken, nonce });
		}
		// A minted nonce that no ID token answered cannot be compared, and an uncompared nonce fails closed.
		if (nonce !== null) {
			throw new ConcealedError("nonce_mismatch");
		}
		return claimsFromUserInfo({ fetch: outbound, provider, accessToken: tokens.accessToken });
	}

	async function createAccountFor(
		transaction: Driver,
		provider: ResolvedProvider,
		account: ProviderAccount,
	): Promise<User> {
		const columns = identityColumns(services.identity, { email: account.email });
		if (!columns.accepted) {
			// S-LINK-5: no address and no username is invented, so the account is not created (E-559).
			throw new VelveError(
				columns.rejection.identifier === "email" ? "oauth_provider_error" : "oauth_flow_invalid",
			);
		}
		const users = createUserRepository({ driver: transaction, schema });
		// The address the automatic link was refused over stays another account's, so the flow ends
		// here rather than in a unique-index violation, and it links nothing on the way (E-560).
		if (
			columns.value.email !== null &&
			(await users.findUserByEmail(columns.value.email)) !== null
		) {
			throw new VelveError("oauth_flow_invalid");
		}
		await services.pluginRuntime.hooks.beforeUserCreate({
			email: columns.value.email,
			username: columns.value.username,
		});
		const created = await users.createUser({
			...columns.value,
			// A provider's claim verifies an address only where the operator trusts that provider (S-LINK-2).
			emailVerifiedAt:
				account.emailVerified && provider.trustedForAutomaticLinking ? services.clock.now() : null,
		});
		await services.pluginRuntime.hooks.afterUserCreate({
			email: created.email,
			username: created.username,
			userId: created.id,
		});
		return created;
	}

	async function resolveAccount(
		provider: ResolvedProvider,
		account: ProviderAccount,
		facts: IdentityFacts,
		linkToUserId: string | null,
	): Promise<ResolvedAccount> {
		return driver.transaction(async (transaction) => {
			const owned = createOAuthIdentityRepository({ driver: transaction, schema });
			const existing = await owned.findIdentityBySubject({
				provider: provider.id,
				subject: account.subject,
			});

			if (existing !== null) {
				if (linkToUserId !== null && existing.userId !== linkToUserId) {
					throw new VelveError("identity_already_linked");
				}
				return {
					userId: existing.userId,
					identity: await owned.refreshIdentity(facts),
					linked: linkToUserId !== null,
				};
			}

			if (linkToUserId !== null) {
				return {
					userId: linkToUserId,
					identity: await insertOrRefuse(owned, linkToUserId, facts),
					linked: true,
				};
			}

			const joinable = await accountAnAutomaticLinkMayJoin({
				users: createUserRepository({ driver: transaction, schema }),
				account,
				provider,
			});
			const owner = joinable ?? (await createAccountFor(transaction, provider, account));
			return {
				userId: owner.id,
				identity: await insertOrRefuse(owned, owner.id, facts),
				linked: false,
			};
		});
	}

	async function issueSessionAround(
		userId: string,
		issue: () => Promise<IssuedSession>,
	): Promise<{ readonly issued: IssuedSession; readonly user: User }> {
		await services.pluginRuntime.hooks.beforeSessionCreate({ userId, factors: OAUTH_FACTORS });
		const issued = await issue();
		await services.pluginRuntime.hooks.afterSessionCreate({
			userId,
			factors: issued.session.factors,
			sessionId: issued.session.id,
		});
		const user = await services.users.findUserById(userId);
		if (user === null) {
			throw new VelveError("internal_error");
		}
		return { issued, user };
	}

	/**
	 * 3.6: an account with a second factor reaches a pending state rather than a session, and which
	 * factors it may offer is read where the pending row is written — so the row is written first
	 * and withdrawn again when it names none (E-563).
	 */
	async function signInOrAskForTheSecondFactor(
		userId: string,
		observed: ObservedRequest,
	): Promise<SignInResult> {
		const pending = await services.pending.begin({ userId, factorsCompleted: OAUTH_FACTORS });
		if (pending.pending.availableFactors.length > 0) {
			return {
				status: "second_factor_required",
				pendingToken: pending.token,
				pending: pending.pending,
			};
		}
		await services.pending.cancel({ token: pending.token });

		const { issued, user } = await issueSessionAround(userId, () =>
			services.sessions.issue({ userId, factors: OAUTH_FACTORS, observed }),
		);
		return { status: "signed_in", sessionToken: issued.token, session: issued.session, user };
	}

	/** S-LINK-7: a new identity changes the trust level, so the session is replaced rather than kept. */
	async function reissueAfterLinking(
		userId: string,
		previousToken: string | null,
		observed: ObservedRequest,
	): Promise<IssuedSession> {
		const { issued } = await issueSessionAround(userId, () =>
			previousToken === null
				? services.sessions.issue({ userId, factors: OAUTH_FACTORS, observed })
				: services.sessions.reissue({
						previousToken,
						userId,
						factors: OAUTH_FACTORS,
						observed,
					}),
		);
		return issued;
	}

	async function verifierOf(flow: {
		readonly pkceVerifierEnc: Uint8Array<ArrayBuffer>;
		readonly keyVersion: number;
	}): Promise<string> {
		return new TextDecoder().decode(
			await decryptWithPurposeKey(services.keys, "pkce-enc", flow.keyVersion, flow.pkceVerifierEnc),
		);
	}

	return {
		async beginFlow({ providerId, redirectPath, linkToUserId }) {
			const provider = configuredProvider(providers, providerId);
			const pointer = createFlowPointer();
			const state = stateOfPointer(pointer);
			const verifier = createPkceVerifier();
			const nonce = provider.jwksUri === null ? null : createNonce();
			const sealed = await encryptWithPurposeKey(services.keys, "pkce-enc", utf8.encode(verifier));

			await flows.insertFlow({
				stateSha256: stateHash(state),
				provider: provider.id,
				pkceVerifierEnc: sealed.ciphertext,
				keyVersion: sealed.keyVersion,
				nonce,
				redirectPath: redirectPath === undefined ? null : acceptedRedirectPath(redirectPath),
				linkToUserId,
			});

			return {
				redirect: {
					authorizationUrl: authorizationUrlFor({
						provider,
						state,
						codeChallenge: pkceChallengeOf(verifier),
						nonce,
					}),
					stateCookie: oauthStateCookieFor(pointer, provider.responseMode),
				},
				pointer,
				delivery: provider.responseMode,
			};
		},

		async completeFlow(arrival) {
			const provider = providerOfCallback(providers, arrival.providerId);
			// S-CSRF-5: the pointer is one half of the check and the row the other, and both must hold.
			if (arrival.pointer === null || !pointerBelongsToState(arrival.pointer, arrival.state)) {
				throw new ConcealedError("state_not_found");
			}
			assertIssuerMatches(provider, arrival.iss);

			const flow = await flows.consumeFlow({ stateSha256: stateHash(arrival.state) });
			if (flow === null || flow.provider !== provider.id) {
				throw new ConcealedError("state_not_found");
			}

			if (flow.linkToUserId === null) {
				await services.pluginRuntime.hooks.beforeSignIn({
					method: "oauth",
					userId: null,
					ipAddress: arrival.observed.ipAddress,
					userAgent: arrival.observed.userAgent,
				});
			}

			const tokens = await exchangeAuthorizationCode({
				fetch: outbound,
				provider,
				code: arrival.code,
				codeVerifier: await verifierOf(flow),
			});
			const account = providerAccountOf(
				await claimsOfProvider(provider, tokens, flow.nonce),
				provider,
			);
			const resolved = await resolveAccount(
				provider,
				account,
				await factsOf(provider, account, tokens),
				flow.linkToUserId,
			);
			const redirectToPath = acceptedRedirectPath(flow.redirectPath ?? DEFAULT_REDIRECT_PATH);

			if (resolved.linked) {
				const issued = await reissueAfterLinking(
					resolved.userId,
					arrival.sessionToken,
					arrival.observed,
				);
				return {
					status: "identity_linked",
					identity: resolved.identity,
					sessionToken: issued.token,
					session: issued.session,
					redirectToPath,
				};
			}

			const result = await signInOrAskForTheSecondFactor(resolved.userId, arrival.observed);
			if (result.status === "signed_in") {
				await services.pluginRuntime.hooks.afterSignIn({
					method: "oauth",
					userId: resolved.userId,
					ipAddress: arrival.observed.ipAddress,
					userAgent: arrival.observed.userAgent,
					sessionId: result.session.id,
					factors: result.session.factors,
				});
			}
			return { ...result, redirectToPath };
		},

		listIdentities: ({ actor }) => identities.listIdentitiesOwnedBy({ actor }),

		// L-13: the count that refuses to remove the last way in lives in `core/identity` and is shared.
		unlinkIdentity: ({ actor, identityId }) =>
			removeSignInMethod({
				driver,
				schema,
				actor,
				removing: { method: "linked_identity", identityId },
			}),
	};
}
