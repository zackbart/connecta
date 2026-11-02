import { META_ROUTES } from "../agent-routes.js";
import type {
  FetchLike,
  OAuthClientInformationContext,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthTokens,
} from "@modelcontextprotocol/client";
import { UnauthorizedError } from "@modelcontextprotocol/client";
import { deriveContext } from "../derived-context.js";
import { ConnectorCallError, resendAdvice } from "../errors.js";
import type { OAuthStateSealer } from "../oauth-sealing.js";
import { SentSecrets } from "../sent-secrets.js";
import type { ConnectorContext, KVStorage } from "../types.js";
import {
  authenticateRemoteClient,
  downstreamClientMetadata,
  remoteClientAuthMethod,
  type RemoteOAuthClient,
} from "./downstream-client-metadata.js";
import { authMethods } from "./native.js";
import { type RefreshFailure } from "./oauth-token-response.js";
import { OAUTH_REFRESH_SKEW_MS, type OAuthGrantBody } from "./oauth-grant.js";
import { type Flow, type FlowBinding, consentMethods } from "./downstream-oauth/consent.js";
import {
  ACTIVE_EPOCH_PREFIX,
  GRANT,
  type Grant,
  type GrantBody,
  grantStoreMethods,
  isDisconnectedEpoch,
} from "./downstream-oauth/grant-store.js";
import {
  type OAuthRefreshCoordinator,
  type RefreshWait,
  aborted,
  tokenResponse,
} from "./downstream-oauth/refresh-coordinator.js";
import { type RefreshLease, refreshRecordMethods } from "./downstream-oauth/refresh-records.js";
import { sdkHookMethods } from "./downstream-oauth/sdk-hooks.js";
export {
  earlyRenewalFetch,
  EarlyRenewals,
  OAuthRefreshCoordinator,
  refreshCoordinatorsByPartition,
} from "./downstream-oauth/refresh-coordinator.js";
export { codeExchangeResponse, OAuthCallbackClaimedError, oauthStateDigest } from "./downstream-oauth/consent.js";

/** RFC 6749 section 3.3: one or more scope tokens, separated by single spaces. */
const OAUTH_SCOPE = /^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/;

/** Refuse, at construction, a configured scope no authorization server could parse. */
export function assertOAuthScope(connectorId: string, scope: string | undefined): void {
  if (scope !== undefined && !OAUTH_SCOPE.test(scope)) {
    throw new Error(`[connecta] connector "${connectorId}" OAuth scope must contain space-separated scope tokens.`);
  }
}

/**
 * The context an explicit authorization start runs under: allowed to begin
 * consent, in the same request scope, and derived so the registry's sealer,
 * owner partition, and every other call-state entry carry across the copy.
 * Only `startAuth` builds one; status reads and calls never do, which is what
 * keeps them from starting authorization.
 */
export function authorizingContext(ctx: ConnectorContext): ConnectorContext {
  return deriveContext(ctx, { allowAuthorization: true });
}

/** A local destination guard proved that no OAuth HTTP request left. */
export class OAuthRequestNotSentError extends ConnectorCallError {}

/**
 * OAuthClientProvider over one owner's grant record and its consents' flow
 * records, in one connector's namespace.
 *
 * Headless: `redirectToAuthorization()` cannot navigate a user agent, so it
 * stores the consent; the registry surfaces its URL, and the
 * `/oauth/callback/<id>` route drives the exchange.
 *
 * A flow — a connect attempt, an `api()` call or start, or a callback — binds
 * to one epoch. Its reads fail once another epoch is live, and its writes are
 * compare-and-sets against the record it read, so a restart or disconnect,
 * which replaces the epoch, fences every flow that began before it.
 *
 * Each native method is defined once, in `./downstream-oauth/` by seam, and
 * `authMethods` installs it with its Promise edge; the class declares only the
 * edge's type. State those bodies read is not `private` for that reason; it
 * remains internal to src/auth.
 */
export class KvOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;
  readonly addClientAuthentication?: NonNullable<OAuthClientProvider["addClientAuthentication"]>;
  /** The epoch this provider's flow reads and writes in, once known. */
  epoch: string | undefined;
  /** Set when a flow binds: from then on a replaced epoch fails the flow. */
  bound = false;
  /** The consent being started, held until `redirectToAuthorization` stores it. */
  consentDiscovery: OAuthDiscoveryState | undefined;
  consent: { state?: string; verifier?: string } = {};
  /** The consent this provider stored, for the start that asked for it. */
  published: { epoch: string; url: string } | undefined;
  /** The consent a matching `verifyState` found, which the exchange claims. */
  callback: { key: string; raw: string; flow: Flow; claimed: boolean } | undefined;
  /** Set by `bindFlow`: this provider exchanges a code. */
  codeExchange = false;
  /** The token endpoint's refusal of this exchange's code, for the SDK's retry. */
  exchangeRefusal: Response | undefined;
  /** Resolution observed when the code answer completed, before the SDK saves. */
  exchangeConsent: GrantBody["refreshConsent"];
  /**
   * The client and tokens as this flow last saw them. An invalidation removes
   * only these, never a value another flow wrote meanwhile.
   */
  seen: { client?: string | undefined; tokens?: string | undefined } = {};
  /** How the last refresh this provider took part in failed, if it did. */
  refreshFailure: RefreshFailure | undefined;
  /** The tokens this flow's issuer-aware read handed the SDK to refresh. */
  refreshBasis: { accessToken: string; epoch: string; issuer: string } | undefined;
  /** The access token of a refresh the coordinator already stored. */
  storedRefresh: string | undefined;
  /**
   * @internal When this flow's last token request other than a refresh was
   * sent. The tokens the SDK saves from its answer expire counted from here,
   * never from the later save, which a slow answer would push past expiry.
   */
  tokenRequestSent: number | undefined;
  /**
   * The tokens of the grant this provider last opened or wrote, as facts
   * only: no credential beyond the access token it already handed out.
   */
  observed: { epoch: string; accessToken: string; refreshable: boolean; expiresAt?: number } | undefined;

  constructor(
    readonly connectorId: string,
    readonly storage: KVStorage,
    private readonly redirectUri: string,
    readonly refreshCoordinator?: OAuthRefreshCoordinator,
    readonly allowAuthorization = true,
    /** Present when the deployment's vault can seal; the grant is then ciphertext. */
    readonly sealer?: OAuthStateSealer,
    /** SDK hook ownership; renewal ignores it after claim submission. */
    readonly signal?: AbortSignal,
    /** Stable connector configuration bound to dynamically registered clients. */
    readonly clientBinding?: string,
    /** Request-local observer so the operator route drains every reset it began. */
    readonly onReset?: (reset: Promise<void>) => void,
    /** SDK uses this only when the authorization server advertises support. */
    clientMetadataUrl?: string,
    private readonly scope?: string,
    /** Isolate-local clock, used only for claims that have never been sent. */
    readonly refreshNow: () => number = Date.now,
    readonly clientOptions?: {
      authorizationParams?: ReadonlyArray<readonly [string, string]>;
      /** Remote MCP resource metadata may only be learned on this configured origin. */
      resourceOrigin?: string;
      name?: string | undefined;
      client?: RemoteOAuthClient | undefined;
      secrets?: SentSecrets | undefined;
    },
  ) {
    if (clientMetadataUrl !== undefined) this.clientMetadataUrl = clientMetadataUrl;
    const client = clientOptions?.client;
    if (client) this.addClientAuthentication = (headers, params) => authenticateRemoteClient(client, headers, params);
  }

  /** Stored facts only: no sealing writes, refresh or discovery. */
  declare storedAuthorization: (issuer?: string) => Promise<boolean>;

  /**
   * One read of the grant's epoch and tokens, for discovery. Unlike the grant
   * reads a flow makes, it never seals a plaintext record in place, binds an
   * epoch, records what it handed out, refreshes or discovers (INV-10).
   */
  declare peekGrant: () => Promise<{ epoch: string; tokens?: OAuthTokens }>;

  /**
   * @internal The access token a call should renew before sending it: the
   * one this provider last read, refreshable and within
   * OAUTH_REFRESH_SKEW_MS of its stored expiry, in the epoch it is bound to.
   * Memory only: no storage read, refresh or discovery. A grant without an
   * expiry is never due; a 401 renews it.
   */
  renewalDue(now: number = Date.now()): string | undefined {
    const seen = this.observed;
    if (!seen?.refreshable || seen.expiresAt === undefined) return undefined;
    if (this.bound && seen.epoch !== this.epoch) return undefined;
    return seen.expiresAt - OAUTH_REFRESH_SKEW_MS <= now ? seen.accessToken : undefined;
  }

  observe(grant: Grant): void {
    const { tokens, expiresAt } = grant.body;
    this.observed = tokens
      ? {
          epoch: grant.epoch,
          accessToken: tokens.access_token,
          refreshable: typeof tokens.refresh_token === "string" && tokens.refresh_token !== "",
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        }
      : undefined;
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    const client = this.clientOptions?.client;
    return downstreamClientMetadata(
      this.redirectUri,
      this.scope,
      this.clientOptions?.name,
      client ? remoteClientAuthMethod(client) : "none",
    );
  }

  /** A preparation await owns no continuation after its call/request closes.
   * null explicitly selects coordinator/reset ownership, never the caller. */
  declare private wait: <T>(work: () => Promise<T>, signal?: AbortSignal | null | undefined) => Promise<T>;

  // --- the grant record ---------------------------------------------------

  /** The grant's additional authenticated data: record and epoch. */
  grantLabel(epoch: string): string {
    return `${GRANT}:${epoch}`;
  }

  declare private encodeGrant: (grant: Grant, signal?: AbortSignal | null | undefined) => Promise<string>;

  /**
   * Open a stored grant. A body that does not open — tampered, under a
   * rotated key, moved from another connector, owner, or epoch, or sealed
   * with no sealer configured — reads as empty: authorization again.
   */
  declare private openGrant: (raw: string | null, signal?: AbortSignal | null | undefined) => Promise<Grant>;

  /**
   * The current grant record. A plaintext
   * body, written before the vault could seal, is sealed where it lies by
   * compare-and-set; a failure leaves it readable for the next write to seal.
   */
  declare private readGrant: (signal?: AbortSignal | null | undefined) => Promise<{
    raw: string | null;
    grant: Grant;
  }>;

  /** The grant a bound flow reads: a replaced epoch fails it. */
  declare private boundGrant: (signal?: AbortSignal | null | undefined) => Promise<Grant>;

  /** SDK preparation is call/request-owned; coordinator reads explicitly opt out. */
  declare private activeGrant: () => Promise<Grant>;

  /**
   * The one way a grant changes: read, change, compare-and-set, again while
   * other writers win. The write belongs to `epoch` (default: the flow's,
   * captured now if unset) and lands nowhere once another is live: `quiet`
   * drops it silently, otherwise a bound flow fails as superseded. `commit`
   * writes after the request's abort too. `change` returning undefined
   * leaves the grant as it is.
   */
  declare private updateGrant: (
    change: (grant: Grant) => Grant | undefined,
    options?: {
      epoch?: string;
      quiet?: boolean;
      commit?: boolean;
      beforeWrite?: () => void;
      signal?: AbortSignal;
    },
  ) => Promise<boolean>;

  /** Store a client or tokens for `issuer`'s grant, replacing another server's. */
  declare private writeCredential: (
    field: "client" | "tokens",
    value: NonNullable<GrantBody["client"] | GrantBody["tokens"]>,
    issuer: string | undefined,
    refreshConsent?: GrantBody["refreshConsent"],
  ) => Promise<void>;

  withIssuer(grant: Grant, body: GrantBody): Grant {
    if (grant.body.issuer !== undefined && grant.body.issuer !== body.issuer) {
      if (this.codeExchange) throw this.flowSuperseded();
      return {
        epoch: `${ACTIVE_EPOCH_PREFIX}${crypto.randomUUID()}`,
        body,
      };
    }
    return { ...grant, body };
  }

  /** Static clients bind to deployment configuration without storing secrets. */
  protected configuredAuthorizationBinding(): FlowBinding | undefined {
    return undefined;
  }

  declare private bindingForGrant: (grant: Grant) => Promise<FlowBinding>;

  declare private checkFlowBinding: (grant: Grant) => Promise<void>;

  /** Validate RFC 9207 against the server this consent selected. */
  validateCallbackIssuer(issuer: string | null): void {
    if (
      !this.callback ||
      (issuer === null
        ? this.callback.flow.binding?.issRequired === true
        : issuer !== this.callback.flow.binding?.issuer)
    ) {
      throw new ConnectorCallError(
        "connector_call_failed",
        `Connector "${this.connectorId}" authorization callback issuer does not match its consent; nothing was exchanged.`,
      );
    }
  }

  // --- flow records ---------------------------------------------------------

  flowLabel(key: string, epoch: string): string {
    return `${key}:${epoch}`;
  }

  declare private encodeFlow: (key: string, flow: Flow) => Promise<string>;

  /** A flow record, its verifier opened only when `withVerifier`. */
  declare private openFlow: (key: string, raw: string, withVerifier: boolean) => Promise<Flow | undefined>;

  /** The live epoch's latest consent, until a callback claims it. */
  declare private latestConsent: () => Promise<
    | (Flow & {
        url: string;
      })
    | undefined
  >;

  // --- flows and epochs -----------------------------------------------------

  /** The live epoch; an owner with no grant yet has the initial one. */
  declare liveEpoch: () => Promise<string>;

  /** True only after an operator disconnect, until an explicit start replaces it. */
  declare operatorDisconnected: () => Promise<boolean>;

  isOperatorDisconnectedEpoch(epoch: string): boolean {
    return isDisconnectedEpoch(epoch);
  }

  /**
   * Begin a flow — a connect, whose 401 may refresh or start consent, or an
   * `api()` call or start — in the live epoch, and return it. Nothing about
   * the grant is decided here: a grant belongs to one server by construction.
   * An expected epoch continues an existing attempt; a replacement fails it.
   */
  declare beginFlow: (expectedEpoch?: string) => Promise<string>;

  /** The epoch this flow is bound to, or the live one. */
  declare flowEpoch: () => Promise<string>;

  /**
   * Bind a code exchange: to the epoch its verified consent was written in, or
   * the live one for an exchange no callback verified. An epoch already
   * replaced fails here, before the SDK can send anything. What the grant
   * holds now is all a refused code may invalidate.
   */
  declare bindFlow: () => Promise<void>;

  /** Retain an already verified snapshot only for the exact same state. */
  declare verifyCallbackState: (state: string) => Promise<boolean>;

  /** Whether `verifyState` matched a consent on this provider. */
  verified(): boolean {
    return this.callback !== undefined;
  }

  /** The fixed, retryable failure of a flow a later reset superseded. */
  flowSuperseded(): ConnectorCallError {
    return resendAdvice(
      new ConnectorCallError(
        "unavailable",
        `Connector "${this.connectorId}" authorization changed while this request was in flight.`,
      ),
      "; try again",
    );
  }

  /**
   * A credential write that storage refused, in fixed text and with no cause
   * attached. Retryable: the grant it held is untouched.
   */
  credentialWriteError(): ConnectorCallError {
    return resendAdvice(
      new ConnectorCallError("unavailable", `Connector "${this.connectorId}" could not store its OAuth credentials.`),
      "; try again shortly",
    );
  }

  /** @internal Other requests kept refreshing faster than this one could join. */
  refreshContended(): ConnectorCallError {
    this.recordRefreshFailure({ kind: "contended" });
    return resendAdvice(
      new ConnectorCallError(
        "unavailable",
        `Connector "${this.connectorId}" could not refresh its OAuth grant while other requests were.`,
      ),
      "; retry",
    );
  }

  /**
   * A passive call cannot start consent. A waiter deadline remains retryable;
   * any dispatched failure requires consent because its token is spent.
   */
  authorizationRefused(): Error {
    // The SDK catches a refresh cancellation and falls back to consent. Keep
    // the ended caller's own reason instead of turning it into an auth verdict.
    if (this.signal?.aborted) throw aborted(this.signal);
    const failure = this.refreshFailure;
    if (failure?.kind === "contended") return this.refreshContended();
    // Only the class reaches callers: remoteMcp replaces this error with its own
    // typed auth error, so this text keeps the meta name.
    return new UnauthorizedError(`Authorization required. Use ${META_ROUTES.authorize} or Connect to start consent.`);
  }

  // --- the SDK's hooks --------------------------------------------------------

  declare clientInformation: (ctx?: OAuthClientInformationContext) => Promise<OAuthClientInformationMixed | undefined>;

  declare saveClientInformation: (
    info: OAuthClientInformationMixed,
    ctx?: OAuthClientInformationContext,
  ) => Promise<void>;

  declare registrationPath: () => Promise<"cimd" | "dcr" | "static" | undefined>;

  /** Intake and saved URLs share a guard. Include the current grant's secrets
   * so a fresh request can reject an older cache before sending credentials. */
  assertCredentialFree(value: unknown, body: GrantBody, consentUrl = false): void {
    // OAuth intentionally puts its public client identity in consent. Exempt
    // only that parameter when it equals the bound/configured client, leaving
    // every other occurrence subject to the credential check. The URL itself
    // is never changed, only this matching view.
    if (consentUrl && typeof value === "string") {
      const url = new URL(value);
      const clientId =
        this.clientOptions?.client?.clientId ??
        body.client?.value.client_id ??
        this.configuredAuthorizationBinding()?.clientId;
      const ids = url.searchParams.getAll("client_id");
      if (clientId && ids.length === 1 && ids[0] === clientId) url.searchParams.delete("client_id");
      value = url.href;
    }
    const secrets = new SentSecrets();
    for (const value of [
      body.tokens?.access_token,
      body.tokens?.refresh_token,
      body.client?.value.client_secret,
      this.clientOptions?.client?.clientSecret,
    ]) {
      if (typeof value === "string") secrets.secret(value);
    }
    if (body.client?.value.client_secret) secrets.identifier(body.client.value.client_id);
    if (this.clientOptions?.client?.clientSecret) secrets.identifier(this.clientOptions.client.clientId);
    const urls: string[] = [];
    const collect = (item: unknown): void => {
      if (typeof item === "string") {
        try {
          urls.push(new URL(item).href);
        } catch {
          /* Not a URL field. */
        }
      } else if (item && typeof item === "object") for (const field of Object.values(item)) collect(field);
    };
    collect(value);
    if (
      [secrets, this.clientOptions?.secrets].some(
        (source) => source && (source.changes(value) || urls.some((url) => source.containsUrl(url))),
      )
    ) {
      throw new ConnectorCallError(
        "connector_call_failed",
        "OAuth metadata or consent URL contains a credential; refusing authorization.",
        { retryable: false },
      );
    }
  }

  /** Only metadata bound to the discovered issuer can supply operator origins. */
  declare validatedIssuerOrigin: () => Promise<string | undefined>;

  declare discoveryState: () => Promise<OAuthDiscoveryState | undefined>;

  /**
   * Discovery names the grant's server: the same one keeps the client and
   * tokens beside it, another replaces them. The SDK discovers afresh only
   * without a cached record — a restart's carried client, say — and what a
   * different server leaves behind would never be sent to it anyway.
   */
  declare saveDiscoveryState: (state: OAuthDiscoveryState) => Promise<void>;

  /**
   * The grant's tokens, for the server that issued them only. An
   * issuer-aware read records what it handed the SDK, so the coordinator can
   * tell a refresh another request completed since.
   */
  declare tokens: (ctx?: OAuthClientInformationContext) => Promise<OAuthTokens | undefined>;

  declare saveTokens: (tokens: OAuthTokens, ctx?: OAuthClientInformationContext) => Promise<void>;

  /**
   * OAuth `state`: 256 random bits the consent URL carries and the callback
   * must present, so nobody holding a consent URL can complete it with their
   * own account (login CSRF). Stored, by digest, with the consent.
   */
  declare state: () => Promise<string>;

  declare saveCodeVerifier: (verifier: string) => Promise<void>;

  declare codeVerifier: () => Promise<string>;

  /**
   * Store the consent: its flow record first, by state digest with the
   * link's lifetime, then the grant's pointer to it, in the flow's epoch. A
   * reset that replaced the epoch fails the start, and the record is removed,
   * so no start hands out a consent its callback could not complete.
   */
  declare redirectToAuthorization: (authorizationUrl: URL) => Promise<void>;

  /** The consent this provider stored, while its epoch is still live. */
  declare consentUrl: (signal?: AbortSignal | undefined) => Promise<string | undefined>;

  /** The live epoch's pending consent URL, if one is unclaimed. */
  declare pendingAuthorizationUrl: () => Promise<string | undefined>;

  /**
   * The pending consent URL, only while it is still worth handing out again:
   * unclaimed, written within PENDING_AUTHORIZATION_MAX_AGE_MS of now in
   * either direction (clock skew between isolates), and naming the grant's
   * client. A callback whose exchange the server refused with
   * `invalid_client` drops the client, and its URL would send the operator to
   * a consent the server has already refused.
   */
  declare reusablePendingAuthorizationUrl: () => Promise<string | undefined>;

  /**
   * Find the consent a callback's `state` names. One read whatever the
   * answer; the callback route's refusals pay the same. A claimed consent
   * no longer matches.
   */
  declare verifyState: (candidate: string | null) => Promise<boolean>;

  /**
   * @internal The first half of the fence a code exchange crosses after every
   * read it depends on, just before the code leaves: claim the consent by
   * compare-and-set from the exact record `verifyState` found to a claimed
   * one. Of several callbacks carrying one state, exactly one wins; the
   * others send nothing. A claim that fails because a restart swept the
   * consent reports the supersession. The claim is spent whether or not the
   * exchange succeeds; the SDK's one retry after a refused code is answered
   * with that refusal, never sent again.
   */
  declare claimCodeExchange: () => Promise<Response | undefined>;

  /** Terminate the verified consent on an error, sharing the code exchange CAS. */
  declare consumeAuthError: () => Promise<void>;

  declare private claimConsent: () => Promise<void>;

  /**
   * @internal The second half: read the live epoch and, in the reaction to
   * that read, dispatch. No await stands between the check and `send`. A
   * reset published at or before the read fails the exchange with nothing
   * sent; one published after it, while the request is leaving, cannot be
   * ordered before the send without a lock across requests, and its tokens
   * are refused by the grant's compare-and-set: one more consent.
   */
  declare dispatchCodeExchange: (send: () => Promise<Response>, endpoint?: string | URL) => Promise<Response>;

  /** @internal The access token of the last refresh this flow adopted. */
  adoptedRefresh(): string | undefined {
    return this.storedRefresh;
  }

  /** @internal The stored expiry of `accessToken`, when this provider last read or wrote it. */
  observedExpiry(accessToken: string): number | undefined {
    return this.observed?.accessToken === accessToken ? this.observed.expiresAt : undefined;
  }

  /** @internal Keep a refused code's answer for the SDK's retry to read. */
  recordCodeExchangeRefusal(forSdk: Response): void {
    this.exchangeRefusal = forSdk.clone();
  }

  /** @internal Observe resolution while accepting the code response, never on a later SDK save. */
  declare recordCodeExchangeTokens: (tokens: OAuthTokens) => Promise<void>;

  /**
   * Remove what the SDK asks, but only as this flow saw it: a refused code or
   * refresh says nothing about a client or tokens another flow wrote since.
   * The verifier lives in its consent, which the claim already spent.
   */
  declare invalidateCredentials: (scope: "all" | "client" | "tokens" | "verifier" | "discovery") => Promise<void>;

  // --- refresh, for the coordinator ---------------------------------------------

  /**
   * @internal How the refresh this provider owned or joined failed; undefined
   * clears it. The hooks the SDK calls next (`state`, `saveCodeVerifier`,
   * `redirectToAuthorization`, `invalidateCredentials`, `saveTokens`) read it.
   */
  recordRefreshFailure(failure: RefreshFailure | undefined): void {
    this.refreshFailure = failure;
  }

  /** @internal A shared-storage claim precedes every refresh dispatch. */
  declare claimRefresh: (
    epoch: string,
    requested: string | null,
    signal?: AbortSignal,
    sharedWait?: RefreshWait,
  ) => Promise<RefreshLease | Response>;

  /** @internal Only the successful claimed-to-dispatched CAS may send. */
  declare dispatchRefresh: (
    lease: RefreshLease,
    send: () => Promise<Response>,
    waiting: RefreshWait,
  ) => Promise<Response>;

  /** @internal Release by CAS after a commit or a classified failure. */
  declare releaseRefresh: (
    lease: RefreshLease,
    verdict?: RefreshFailure,
    tokens?: OAuthTokens,
    resolution?: "resolved" | "ambiguous",
  ) => Promise<void>;

  declare private resolveRefreshSpent: (lease: RefreshLease, state: "resolved" | "ambiguous") => Promise<void>;

  /** @internal The same typed verdict for local and cross-isolate joiners. */
  refreshVerdict(): RefreshFailure | undefined {
    return this.refreshFailure;
  }

  /** @internal The grant's tokens as stored, in the flow's epoch. */
  declare storedTokens: (signal?: AbortSignal | null) => Promise<OAuthTokens | undefined>;

  /** @internal True when a refresh landed after this flow's issuer-aware read. */
  refreshedSinceRead(current: OAuthTokens, epoch: string): boolean {
    const basis = this.refreshBasis;
    return basis !== undefined && basis.epoch === epoch && basis.accessToken !== current.access_token;
  }

  /** @internal The issuer this flow's issuer-aware read bound its refresh to. */
  refreshIssuer(epoch: string): string | undefined {
    const basis = this.refreshBasis;
    return basis?.epoch === epoch ? basis.issuer : undefined;
  }

  /** @internal Hand the SDK tokens already stored, so its save is not repeated. */
  adoptRefresh(tokens: OAuthTokens): Response {
    this.storedRefresh = tokens.access_token;
    return tokenResponse(tokens);
  }

  /**
   * @internal Store an accepted rotation in `epoch`, even after the request
   * that redeemed it has left, unless a newer rotation, another server's
   * grant, or another epoch is there now. A token response names no issuer:
   * the one the refreshed grant was bound to is stamped here.
   */
  declare storeRefresh: (
    epoch: string,
    requested: string | null,
    tokens: OAuthTokens,
    issuer: string | undefined,
    issuedAt?: number,
  ) => Promise<OAuthTokens | undefined>;

  /**
   * @internal Drop the tokens the authorization server just refused, only
   * while the grant still holds that refresh token in `epoch`: a consent
   * that completed meanwhile survives. Best effort: if storage fails, the
   * next refresh is refused again and ends the same way.
   */
  declare discardRefusedGrant: (
    refreshToken: string | null,
    epoch: string,
    beforeWrite?: () => void,
    signal?: AbortSignal,
  ) => Promise<void>;

  // --- restart and disconnect ---------------------------------------------------

  /**
   * Replace the epoch, by one compare-and-set: the grant goes with it, and
   * every flow bound to the old epoch fails at its next read or write. A
   * forced restart may carry the registration forward (`carriableClient`);
   * a disconnect leaves only its epoch, which no passive request leaves.
   * Then the old epochs' consents are removed; that is hygiene, since their
   * callbacks fail the epoch check anyway and the records expire.
   */
  declare resetAuthorization: (operatorDisconnected?: boolean, preserveClient?: boolean) => Promise<void>;

  /** Remove the local grant before a bounded, best-effort RFC 7009 request. */
  declare disconnectAuthorization: (send: FetchLike) => Promise<void>;

  /** Static adapters supply trusted configuration without persisting client secrets. */
  protected revocationSnapshot(body: OAuthGrantBody): { body: OAuthGrantBody; client?: RemoteOAuthClient } {
    return { body, ...(this.clientOptions?.client ? { client: this.clientOptions.client } : {}) };
  }

  declare private performReset: (
    operatorDisconnected: boolean,
    preserveClient: boolean,
    revoke?: FetchLike,
  ) => Promise<void>;

  /**
   * Remove every consent of an epoch no longer live. The records are read
   * before the epoch, and epochs never recur, so a consent whose epoch is not
   * the live one then can never complete; each goes by compare-and-set
   * against what was read. Best effort.
   */
  declare private sweepConsents: () => Promise<void>;

  declare private sweepRefreshLeases: () => Promise<void>;

  /**
   * The registration a forced restart may carry into its new epoch, or
   * nothing. It must be bound to a server (`issuer`) and registered under this
   * connector's exact configuration, redirect URI, and client metadata
   * (`binding`), in this owner's own grant. Never carried:
   *
   * - A URL-based client (`clientMetadataUrl`): nothing was registered, and
   *   leaving it behind makes the SDK ask fresh metadata whether the server
   *   still accepts one.
   * - One whose `client_secret_expires_at` has passed (RFC 7591: zero means
   *   never).
   * - One a previous restart carried that has not since earned tokens. The
   *   SDK builds a consent URL locally and sends nothing that could answer
   *   `invalid_client`, and RFC 6749 section 4.1.2.1 forbids redirecting an
   *   unknown client to the callback, so tokens are the only proof the server
   *   still knows it. Without them the next restart registers again.
   */
  carriableClient(grant: Grant): GrantBody | undefined {
    const { issuer, client, tokens } = grant.body;
    const clientId: unknown = client?.value.client_id;
    const expiresAt: unknown = client?.value.client_secret_expires_at;
    if (
      !this.clientBinding ||
      issuer === undefined ||
      !client ||
      client.binding !== this.clientBinding ||
      typeof clientId !== "string" ||
      client.registrationPath === "cimd" ||
      client.registrationPath === "static" ||
      // Legacy records have no mechanism field: retain their conservative
      // URL-client refusal, but never reinterpret a recorded DCR identity.
      (client.registrationPath === undefined && clientId === this.clientMetadataUrl) ||
      this.clientOptions?.client !== undefined ||
      (typeof expiresAt === "number" && expiresAt > 0 && expiresAt * 1000 <= Date.now()) ||
      (client.carried && !tokens)
    ) {
      return undefined;
    }
    return {
      issuer,
      client: {
        value: client.value,
        binding: client.binding,
        carried: true,
        ...(client.registrationPath ? { registrationPath: client.registrationPath } : {}),
      },
    };
  }

  static {
    authMethods(KvOAuthProvider.prototype, {
      ...grantStoreMethods,
      ...consentMethods,
      ...sdkHookMethods,
      ...refreshRecordMethods,
    });
  }
}
