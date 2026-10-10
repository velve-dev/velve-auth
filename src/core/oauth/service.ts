import type {
	Identity,
	OAuthCallbackResult,
	OAuthRedirect,
	SignInResult,
} from "../auth/results.js";
import type { RouteServices } from "../auth/routes.js";
import { createUserRepository, type User, type UserRepository } from "../auth/user.js";
import { type Actor, actorOfConsumedOAuthFlow, type ConsumedOAuthFlow } from "../db/actor.js";
import type { Driver } from "../db/driver.js";
import { lockAccountRow } from "../db/lock.js";
import type { IssueAuthorisation } from "../db/repositories/session.js";
import { PreviousSessionMissingError } from "../db/repositories/session.js";
import type { SecondFactor } from "../factor/pending/repository.js";
import { type OAuthResponseDelivery, oauthStateCookieFor } from "../http/cookies.js";
import { ConcealedError, VelveError } from "../http/error-map.js";
import type { RedirectPath } from "../http/redirect.js";
import { identityColumns } from "../identity/columns.js";
import { removeSignInMethod } from "../identity/sign-in-methods.js";
import {
	decryptBound,
	type EnvelopeBinding,
	encryptBound,
	rowOfParts,
} from "../keys/envelope-binding.js";
import { KeyError } from "../keys/index.js";
import { hooksOnTheTransaction } from "../plugin/registry.js";
import { announceEachRevocation } from "../plugin/revocation.js";
import { askBeforeSignIn, createSessionUnderHooks, tellAfterSignIn } from "../plugin/sign-in.js";
import { type AnchorReading, consultAnchors } from "../security-state/anchor.js";
import { assertBelowCredentialLimit } from "../security-state/limits.js";
import { type SecurityStateRead, sealedComponentsOf } from "../security-state/read.js";
import {
	checkAccount,
	issueAuthorisationOf,
	recordSealLater,
	reportEnvelopeRefusal,
	sealChange,
	secondFactorsOf,
} from "../security-state/runtime.js";
import {
	componentsAfter,
	type SealWritten,
	sealCreatedAccount,
} from "../security-state/sealing.js";
import { sessionRowsOn } from "../session/rows.js";
import type { IssuedSession, ObservedRequest } from "../session/service.js";
import { authorizationUrlFor } from "./authorization-request.js";
import { type ProviderAccount, providerAccountOf } from "./claims.js";
import {
	type ConsumedOAuthFlowRow,
	createOAuthFlowRepository,
	type OAuthLinkStart,
} from "./flow-repository.js";
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
	type IdentityFacts,
	type OwnedIdentity,
} from "./identity-repository.js";
import { accountAnAutomaticLinkMayJoin } from "./linking.js";
import type { OutboundFetch } from "./outbound.js";
import type { ProviderTable, ResolvedProvider } from "./providers.js";
import { acceptedRedirectPath, DEFAULT_REDIRECT_PATH } from "./redirect-path.js";
import { exchangeAuthorizationCode, type ProviderTokens } from "./token-exchange.js";
import { claimsFromUserInfo } from "./user-info.js";

/** a callback result plus the path its redirect carries, the only `Location` the library emits */
export type OAuthCallbackOutcome = OAuthCallbackResult & {
	readonly redirectToPath: RedirectPath;
};

export interface OAuthFlowStart {
	readonly providerId: string;
	readonly redirectPath?: string;
	readonly linkTo: OAuthLinkStart | null;
}

//the callback reads no session cookie, so the flow row decides which session is replaced (E-588)
export interface OAuthCallbackArrival {
	readonly providerId: string;
	readonly code: string;
	readonly state: string;
	readonly iss: string | null;
	readonly pointer: string | null;
	readonly presentedSessionToken: string | null;
	readonly observed: ObservedRequest;
}

//the pointer travels beside the answer so the route can set the cookie the flow needs (E-541)
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
	/** the seal the sign-in checked or wrote, which the session it leads to is bound to */
	readonly authorisedBy: IssueAuthorisation;
	/** the second factors the sign-in's verified read held */
	readonly secondFactors: readonly SecondFactor[];
	/** a seal the sign-in wrote in its transaction, which reaches the anchor once that commits */
	readonly toRecord: SealWritten<unknown> | null;
}

function sealedIdentityAfter(read: SecurityStateRead, provider: string, subject: string) {
	const components = sealedComponentsOf(read);
	return { ...components, identities: [...components.identities, { provider, subject }] };
}

interface IdentityLinkWritten extends IssuedSession {
	readonly identity: Identity;
}

interface LinkedSession {
	readonly account: ConsumedOAuthFlow;
	readonly previousSessionId: string;
}

//a flow whose session is gone or expired has no authority left to spend (E-961)
function refuseAFlowWhoseSessionIsGone(cause: unknown): never {
	if (cause instanceof PreviousSessionMissingError) {
		throw new ConcealedError("link_session_gone");
	}
	throw cause;
}

const UNIQUE_VIOLATION = "23505";

//an identifier another sign-up took after the check must end the flow as a taken one does (E-2874)
function refuseAnIdentifierTakenMeanwhile(cause: unknown): never {
	const fields = typeof cause === "object" && cause !== null ? cause : {};
	const { code, sqlState } = fields as { readonly code?: unknown; readonly sqlState?: unknown };
	if (code === UNIQUE_VIOLATION || sqlState === UNIQUE_VIOLATION) {
		throw new VelveError("oauth_flow_invalid");
	}
	throw cause;
}

//a link flow writes both columns, so a row carrying one alone was not written by this library
function linkedSessionOf(flow: ConsumedOAuthFlowRow): LinkedSession | null {
	if (flow.linkTo === null) {
		return null;
	}
	if (flow.linkFromSessionId === null) {
		throw new ConcealedError("state_not_found");
	}
	return { account: flow.linkTo, previousSessionId: flow.linkFromSessionId };
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

//an unknown provider must be answered exactly as an unknown state
function providerOfCallback(providers: ProviderTable, id: string): ResolvedProvider {
	const provider = providers.get(id);
	if (provider === undefined) {
		throw new ConcealedError("state_not_found");
	}
	return provider;
}

//a configured issuer is settled per RFC 9207 before anything is exchanged
function assertIssuerMatches(provider: ResolvedProvider, iss: string | null): void {
	if (iss !== null && provider.issuer !== null && iss !== provider.issuer) {
		throw new ConcealedError("issuer_mismatch");
	}
}

//a tenant issuer has no configured value, so the signed token must answer for it (E-585)
function assertClaimsAnswerForTheIssuer(input: {
	readonly provider: ResolvedProvider;
	readonly iss: string | null;
	readonly claims: Record<string, unknown>;
	readonly fromIdToken: boolean;
}): void {
	if (input.iss === null || input.provider.issuer !== null) {
		return;
	}
	if (!input.fromIdToken || input.claims.iss !== input.iss) {
		throw new ConcealedError("issuer_mismatch");
	}
}

//a link authorised by a stored flow must check the account is still enabled (E-976)
function assertTheAccountIsEnabled(user: User | null): void {
	if (user === null || user.disabledAt !== null) {
		throw new ConcealedError("user_disabled_on_oauth_flow");
	}
}

function refuseIfAlreadyLinked(inserted: Identity | null): Identity {
	if (inserted === null) {
		throw new VelveError("identity_already_linked");
	}
	return inserted;
}

/** the columns of a flow row that decide where the flow leads, bound with its verifier */
interface FlowIdentity {
	readonly stateSha256: Uint8Array;
	readonly provider: string;
	readonly nonce: string | null;
	readonly redirectPath: string | null;
	readonly linkFromSessionId: string | null;
	readonly expiresAtMicros: string;
}

//a writer who changes any column that steers a flow must make its verifier unreadable (E-3123)
function pkceBindingOf(owner: string | null, flow: FlowIdentity): EnvelopeBinding {
	return {
		column: "oauth_flow.pkce_verifier_enc",
		owner,
		row: rowOfParts([
			flow.stateSha256,
			flow.provider,
			flow.nonce,
			flow.redirectPath,
			flow.linkFromSessionId,
			flow.expiresAtMicros,
		]),
	};
}

export function createOAuthService(input: {
	readonly services: RouteServices;
	readonly providers: ProviderTable;
}): OAuthService {
	const { services, providers } = input;
	const driver: Driver = services.driver;
	const schema = services.schema;
	const flows = createOAuthFlowRepository({ driver, schema });
	const keys = services.keys;
	const identities = createOAuthIdentityRepository({ driver, schema, keys });
	const outbound: OutboundFetch = services.fetch ?? globalThis.fetch;
	const storeTokens = services.oauth?.storeTokens === true;

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
			tokens: storeTokens ? tokens : null,
		};
	}

	async function claimsOfProvider(
		provider: ResolvedProvider,
		tokens: ProviderTokens,
		nonce: string | null,
	): Promise<{ readonly claims: Record<string, unknown>; readonly fromIdToken: boolean }> {
		if (provider.jwksUri !== null && tokens.idToken !== null) {
			return {
				claims: await claimsOfIdToken({
					fetch: outbound,
					provider,
					idToken: tokens.idToken,
					nonce,
				}),
				fromIdToken: true,
			};
		}
		//a minted nonce that no ID token answered must fail closed
		if (nonce !== null) {
			throw new ConcealedError("nonce_mismatch");
		}
		return {
			claims: await claimsFromUserInfo({
				fetch: outbound,
				provider,
				accessToken: tokens.accessToken,
			}),
			fromIdToken: false,
		};
	}

	async function createAccountFor(
		transaction: Driver,
		provider: ResolvedProvider,
		account: ProviderAccount,
	): Promise<User> {
		//the application names the username a provider cannot, and nothing is invented (E-1900)
		const contributed = await services.oauth?.identifiersForNewAccount?.({
			provider: provider.id,
			account,
		});
		const columns = identityColumns(services.identity, {
			email: account.email,
			...(contributed?.username === undefined ? {} : { username: contributed.username }),
		});
		if (!columns.accepted) {
			//no address and no username is invented, so the account is not created (E-559)
			throw new VelveError(
				columns.rejection.identifier === "email" ? "oauth_provider_error" : "oauth_flow_invalid",
			);
		}
		const users = createUserRepository({ driver: transaction, schema });
		//an address that belongs to another account must end the flow before the insert (E-560)
		if (
			columns.value.email !== null &&
			(await users.findUserByEmail(columns.value.email)) !== null
		) {
			throw new VelveError("oauth_flow_invalid");
		}
		//a hook must see the uncommitted account and not ask the pool for a connection (E-2797)
		const hooks = hooksOnTheTransaction(services.pluginRuntime.hooks, transaction);
		await hooks.beforeUserCreate({
			email: columns.value.email,
			username: columns.value.username,
		});
		const created = await users
			.createUser({
				...columns.value,
				//a provider claim verifies an address only where the operator trusts it (E-558)
				emailVerifiedAt:
					account.emailVerified && provider.trustedForAutomaticLinking
						? services.clock.now()
						: null,
			})
			.catch(refuseAnIdentifierTakenMeanwhile);
		await hooks.afterUserCreate({
			email: created.email,
			username: created.username,
			userId: created.id,
		});
		return created;
	}

	//every write to an account's provider tokens runs under the account lock (E-3222)
	async function theIdentityUnderItsAccountLock(
		transaction: Driver,
		owned: ReturnType<typeof createOAuthIdentityRepository>,
		existing: OwnedIdentity,
	): Promise<OwnedIdentity> {
		await lockAccountRow(transaction, schema, existing.userId);
		const locked = await owned.findIdentityBySubject({
			provider: existing.identity.provider,
			subject: existing.identity.subject,
		});
		if (
			locked === null ||
			locked.userId !== existing.userId ||
			locked.identity.id !== existing.identity.id
		) {
			throw new ConcealedError("state_not_found");
		}
		return locked;
	}

	//an automatic link joins only the account that still qualifies once its lock is held (E-3227)
	async function theJoinableAccountUnderItsLock(
		transaction: Driver,
		users: UserRepository,
		joinable: User,
		provider: ResolvedProvider,
		account: ProviderAccount,
	): Promise<User> {
		await lockAccountRow(transaction, schema, joinable.id);
		const locked = await accountAnAutomaticLinkMayJoin({ users, account, provider });
		if (locked === null || locked.id !== joinable.id) {
			throw new ConcealedError("state_not_found");
		}
		assertTheAccountIsEnabled(locked);
		return locked;
	}

	//a sign-in through a linked identity checks the seal and finds that identity in its read (S-INTEG-4)
	async function checkedIdentityOf(
		transaction: Driver,
		locked: OwnedIdentity,
		anchorReading: AnchorReading,
	): Promise<Pick<ResolvedAccount, "authorisedBy" | "secondFactors">> {
		const check = await checkAccount(services.securityState, locked.userId, "sign_in", {
			driver: transaction,
			anchorReading,
		});
		if (check.kind !== "usable") {
			throw new ConcealedError("broken_state_on_oauth_sign_in");
		}
		const sealed = check.read.identities.some(
			(identity) =>
				identity.id === locked.identity.id &&
				identity.provider === locked.identity.provider &&
				identity.subject === locked.identity.subject,
		);
		if (!sealed) {
			services.securityState.alarms.raise({
				userId: locked.userId,
				occasion: "sign_in",
				reason: "seal_mismatch",
			});
			throw new ConcealedError("broken_state_on_oauth_sign_in");
		}
		assertTheAccountIsEnabled(
			await createUserRepository({ driver: transaction, schema }).findUserById(locked.userId),
		);
		return { authorisedBy: check.authorisedBy, secondFactors: secondFactorsOf(check.read) };
	}

	async function accountForSignIn(
		provider: ResolvedProvider,
		account: ProviderAccount,
		facts: IdentityFacts,
	): Promise<ResolvedAccount> {
		return driver.transaction(async (transaction) => {
			const owned = createOAuthIdentityRepository({ driver: transaction, schema, keys });
			const users: UserRepository = createUserRepository({ driver: transaction, schema });
			const existing = await owned.findIdentityBySubject({
				provider: provider.id,
				subject: account.subject,
			});

			if (existing !== null) {
				//the anchor is asked before the lock so no connection holds it while the application answers (S-INTEG-6)
				const anchored = await consultAnchors(services.securityState.anchors, existing.userId);
				const locked = await theIdentityUnderItsAccountLock(transaction, owned, existing);
				const checked = await checkedIdentityOf(transaction, locked, anchored);
				return {
					userId: locked.userId,
					identity: await owned.refreshIdentity({ existing: locked, ...facts }),
					...checked,
					toRecord: null,
				};
			}

			const joinable = await accountAnAutomaticLinkMayJoin({ users, account, provider });
			if (joinable === null) {
				const owner = await createAccountFor(transaction, provider, account);
				const identity = refuseIfAlreadyLinked(
					await owned.insertIdentityOfSignIn({ userId: owner.id, ...facts }),
				);
				//an account created by a sign-in is sealed with its identity in the same transaction (S-INTEG-3)
				const sealed = await sealCreatedAccount(transaction, owner.id, { schema, keys });
				return {
					userId: owner.id,
					identity,
					authorisedBy: issueAuthorisationOf(sealed),
					secondFactors: secondFactorsOf(sealed.read),
					toRecord: sealed,
				};
			}
			const anchored = await consultAnchors(services.securityState.anchors, joinable.id);
			const joined = await theJoinableAccountUnderItsLock(
				transaction,
				users,
				joinable,
				provider,
				account,
			);
			const sealed = await sealChange(
				services.securityState,
				{ unproven: joined.id },
				{
					epoch: "keep",
					write: async (tx, read) => {
						assertBelowCredentialLimit(read, "identity", services.securityState.limits);
						return refuseIfAlreadyLinked(
							await createOAuthIdentityRepository({
								driver: tx,
								schema,
								keys,
							}).insertIdentityOfSignIn({
								userId: joined.id,
								...facts,
							}),
						);
					},
					after: (read) => sealedIdentityAfter(read, provider.id, account.subject),
				},
				{
					driver: transaction,
					occasion: "sign_in",
					refusal: "broken_state_on_oauth_sign_in",
					anchorReading: anchored,
				},
			);
			return {
				userId: joined.id,
				identity: sealed.written,
				authorisedBy: issueAuthorisationOf(sealed),
				secondFactors: secondFactorsOf(sealed.read),
				toRecord: sealed,
			};
		});
	}

	async function issueSessionAround(
		userId: string,
		issue: () => Promise<IssuedSession>,
	): Promise<{ readonly issued: IssuedSession; readonly user: User }> {
		const issued = await createSessionUnderHooks(
			services.pluginRuntime.hooks,
			{ userId, factors: OAUTH_FACTORS },
			issue,
		);
		const user = await services.users.findUserById(userId);
		if (user === null) {
			throw new VelveError("internal_error");
		}
		return { issued, user };
	}

	//the pending row is written first and withdrawn again when it names no factor (E-563)
	async function signInOrAskForTheSecondFactor(
		resolved: ResolvedAccount,
		arrival: OAuthCallbackArrival,
	): Promise<SignInResult> {
		const { observed } = arrival;
		const { userId, authorisedBy } = resolved;
		const pending = await services.pending.begin({
			userId,
			factorsCompleted: OAUTH_FACTORS,
			sessionEpoch: authorisedBy === "unsealed" ? 1 : authorisedBy.sessionEpoch,
			offered: { factors: resolved.secondFactors, refusal: "broken_state_on_oauth_sign_in" },
		});
		if (pending.pending.availableFactors.length > 0) {
			return {
				status: "second_factor_required",
				pendingToken: pending.token,
				pending: pending.pending,
			};
		}
		await services.pending.cancel({ token: pending.token });

		const { issued, user } = await issueSessionAround(userId, () =>
			services.sessions.issueReplacingPresented({
				completes: "oauth_sign_in",
				authorisedBy,
				presentedToken: arrival.presentedSessionToken,
				userId,
				factors: OAUTH_FACTORS,
				observed,
			}),
		);
		return { status: "signed_in", sessionToken: issued.token, session: issued.session, user };
	}

	//a session the account no longer owns is not announced as it will not be revoked (E-758)
	async function announceTheReplacedSession(linked: LinkedSession): Promise<void> {
		if (!services.pluginRuntime.listensTo("beforeSessionRevoke")) {
			return;
		}
		const owned = await sessionRowsOn(services.sessions, driver).listEverySessionIdOwnedBy({
			actor: actorOfConsumedOAuthFlow(linked.account),
		});
		await announceEachRevocation(services.pluginRuntime, {
			userId: linked.account.userId,
			sessionIds: owned.filter((sessionId) => sessionId === linked.previousSessionId),
			reason: "identity_linked",
		});
	}

	//a new identity replaces the session the link began in and no other session (E-588)
	async function linkIdentityAndReissue(input: {
		readonly linked: LinkedSession;
		readonly account: ProviderAccount;
		readonly facts: IdentityFacts;
		readonly observed: ObservedRequest;
	}): Promise<IdentityLinkWritten> {
		const userId = input.linked.account.userId;
		await announceTheReplacedSession(input.linked);
		return createSessionUnderHooks(
			services.pluginRuntime.hooks,
			{ userId, factors: OAUTH_FACTORS },
			() => linkInOneTransaction(input),
		);
	}

	async function linkInOneTransaction(input: {
		readonly linked: LinkedSession;
		readonly facts: IdentityFacts;
		readonly observed: ObservedRequest;
	}): Promise<IdentityLinkWritten> {
		const actor = actorOfConsumedOAuthFlow(input.linked.account);
		const outcome: { issued?: IssuedSession } = {};
		//a link inserts the identity under the lock and reseals before the session is issued under it (S-INTEG-3)
		const sealed = await sealChange(services.securityState, actor, {
			epoch: "keep",
			write: async (transaction, read) => {
				if (read.disabled) {
					throw new ConcealedError("user_disabled_on_oauth_flow");
				}
				assertBelowCredentialLimit(read, "identity", services.securityState.limits);
				//a link only ever inserts and the unique pair refuses every existing identity (E-979)
				return refuseIfAlreadyLinked(
					await createOAuthIdentityRepository({ driver: transaction, schema, keys }).insertIdentity(
						{
							actor,
							...input.facts,
						},
					),
				);
			},
			after: (read) => sealedIdentityAfter(read, input.facts.provider, input.facts.subject),
			afterSeal: async (transaction, next) => {
				outcome.issued = await services.sessions
					.boundTo(transaction)
					.reissueSessionOfUser({
						completes: "oauth_link",
						authorisedBy: next,
						actor,
						previousSessionId: input.linked.previousSessionId,
						factors: OAUTH_FACTORS,
						observed: input.observed,
					})
					.catch(refuseAFlowWhoseSessionIsGone);
			},
		});
		if (outcome.issued === undefined) {
			throw new ConcealedError("link_session_gone");
		}
		return {
			identity: sealed.written,
			token: outcome.issued.token,
			session: outcome.issued.session,
		};
	}

	//a flow that began before the upgrade holds an unbound verifier and is begun again (S-INTEG-1)
	async function verifierOf(flow: ConsumedOAuthFlowRow, stateSha256: Uint8Array): Promise<string> {
		try {
			const verifier = await decryptBound(
				services.keys,
				pkceBindingOf(flow.linkTo?.userId ?? null, {
					stateSha256,
					provider: flow.provider,
					nonce: flow.nonce,
					redirectPath: flow.redirectPath,
					linkFromSessionId: flow.linkFromSessionId,
					expiresAtMicros: flow.expiresAtMicros,
				}),
				{ keyVersion: flow.keyVersion, ciphertext: flow.pkceVerifierEnc },
				"refused",
			);
			return new TextDecoder().decode(verifier);
		} catch (failure) {
			reportEnvelopeRefusal(
				services.securityState,
				flow.linkTo?.userId ?? null,
				flow.linkTo === null ? "sign_in" : "change",
				failure,
			);
			throw failure instanceof KeyError ? new ConcealedError("state_not_found") : failure;
		}
	}

	return {
		async beginFlow({ providerId, redirectPath, linkTo }) {
			const provider = configuredProvider(providers, providerId);
			const pointer = createFlowPointer();
			const state = stateOfPointer(pointer);
			const verifier = createPkceVerifier();
			const nonce = provider.jwksUri === null ? null : createNonce();
			const flow: FlowIdentity = {
				stateSha256: stateHash(state),
				provider: provider.id,
				nonce,
				redirectPath: redirectPath === undefined ? null : acceptedRedirectPath(redirectPath),
				linkFromSessionId: linkTo?.sessionId ?? null,
				expiresAtMicros: await flows.deadlineOfANewFlow(),
			};
			const sealed = await encryptBound(
				services.keys,
				pkceBindingOf(linkTo?.actor ?? null, flow),
				utf8.encode(verifier),
			);

			await flows.insertFlow({
				...flow,
				pkceVerifierEnc: sealed.ciphertext,
				keyVersion: sealed.keyVersion,
				linkTo,
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
			//the pointer is one half of the check and the row the other, and both must hold (S-CSRF-5)
			if (arrival.pointer === null || !pointerBelongsToState(arrival.pointer, arrival.state)) {
				throw new ConcealedError("state_not_found");
			}
			assertIssuerMatches(provider, arrival.iss);

			const stateSha256 = stateHash(arrival.state);
			const flow = await flows.consumeFlow({ stateSha256 });
			if (flow === null || flow.provider !== provider.id) {
				throw new ConcealedError("state_not_found");
			}

			//no column of the row is acted on before its verifier proves the row unchanged (E-3128)
			const codeVerifier = await verifierOf(flow, stateSha256);
			const linked = linkedSessionOf(flow);
			if (linked === null) {
				await askBeforeSignIn(services.pluginRuntime.hooks, "oauth", arrival.observed);
			}

			const tokens = await exchangeAuthorizationCode({
				fetch: outbound,
				provider,
				code: arrival.code,
				codeVerifier,
			});
			const read = await claimsOfProvider(provider, tokens, flow.nonce);
			assertClaimsAnswerForTheIssuer({ provider, iss: arrival.iss, ...read });
			const account = providerAccountOf(read.claims, provider);
			const facts = await factsOf(provider, account, tokens);
			const redirectToPath = acceptedRedirectPath(flow.redirectPath ?? DEFAULT_REDIRECT_PATH);

			//whether a flow links is the flow row's statement and not the callback's to make
			if (linked !== null) {
				const { identity, token, session } = await linkIdentityAndReissue({
					linked,
					account,
					facts,
					observed: arrival.observed,
				});
				return {
					status: "identity_linked",
					identity,
					sessionToken: token,
					session,
					redirectToPath,
				};
			}

			const resolved = await accountForSignIn(provider, account, facts);
			//the sign-up's first seal and an automatic link's seal reach the anchor once their transaction committed (S-INTEG-6)
			if (resolved.toRecord !== null) {
				recordSealLater(services.securityState, resolved.toRecord, "sign_in");
			}
			const result = await signInOrAskForTheSecondFactor(resolved, arrival);
			if (result.status === "signed_in") {
				await tellAfterSignIn(services.pluginRuntime.hooks, {
					method: "oauth",
					observed: arrival.observed,
					session: result.session,
				});
			}
			return { ...result, redirectToPath };
		},

		listIdentities: ({ actor }) => identities.listIdentitiesOwnedBy({ actor }),

		//the count that refuses to remove the last way in is shared with core identity (E-460)
		unlinkIdentity: async ({ actor, identityId }) => {
			await sealChange(services.securityState, actor, {
				epoch: "keep",
				write: (tx) =>
					removeSignInMethod({
						driver: tx,
						schema,
						actor,
						removing: { method: "linked_identity", identityId },
					}),
				after: (read) =>
					componentsAfter(read, {
						identities: read.identities.filter((identity) => identity.id !== identityId),
					}),
			});
		},
	};
}
