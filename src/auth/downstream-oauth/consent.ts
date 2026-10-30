// Consent flow records for KvOAuthProvider: the consent's state and verifier,
// its flow record and binding, the authorization URL it hands out, and the
// callback's single code exchange.
import { bytesToHex, sha256Hex } from "../../bytes.js";
import type { OAuthClientInformationMixed, OAuthDiscoveryState, OAuthTokens } from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { byteReadResponse } from "../../byte-read-response.js";
import { ConnectorCallError } from "../../errors.js";
import { keepErrorName } from "../../redaction-identity.js";
import { runEdge } from "../../runtime/run.js";
import { OAUTH_FLOW_TTL_SECONDS, oauthFlowKeys, oauthRefreshSpentKeys } from "../../storage/keys.js";
import {
  authCall,
  authCatch,
  authFlow,
  authInvoke,
  authMethod,
  authProgram,
  authStorage,
  authThen,
  authValue,
  registerAuth,
} from "../native.js";
import { discoveryIssuer } from "../oauth-grant.js";
import type { KvOAuthProvider } from "../downstream-oauth.js";
import { GRANT, type Grant, epochOf, parsed, plainObject } from "./grant-store.js";
import { aborted } from "./refresh-coordinator.js";
import { storedRefreshSpent } from "./refresh-records.js";

/** @internal Keep the SDK's cloned body reads inside the code exchange's request. */
export function codeExchangeResponse(response: Response, signal: AbortSignal): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  void reader.closed.catch(() => {});
  let closed = false;
  let abort: () => void;
  const release = () => {
    closed = true;
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (closed) return;
        void reader.cancel().catch(() => {});
        release();
        controller.error(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) {
          release();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        if (!closed) {
          release();
          controller.error(error);
        }
      }
    },
    cancel() {
      if (!closed) {
        void reader.cancel().catch(() => {});
        release();
      }
    },
  });
  return byteReadResponse(
    new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }),
  );
}

/**
 * A callback whose consent another callback already claimed: fixed text, and
 * nothing was sent. Its own class so the callback route can answer it as the
 * already-used link it is, not as an exchange the provider refused.
 */
export class OAuthCallbackClaimedError extends ConnectorCallError {
  constructor(connectorId: string) {
    super(
      "connector_call_failed",
      `Connector "${connectorId}" authorization callback was already used by another request; nothing was exchanged.`,
    );
    this.name = "OAuthCallbackClaimedError";
  }
}
keepErrorName(OAuthCallbackClaimedError, "OAuthCallbackClaimedError");

/** A 256-bit random opaque value, hex-encoded — used for the OAuth `state`. */
export function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** Lowercase hex SHA-256 of a consent's `state`: the name of its flow record. */
export async function oauthStateDigest(state: string): Promise<string> {
  return sha256Hex(state);
}
const FLOW_VERSION = 1;
/**
 * How long a pending authorization URL may be handed out again instead of
 * starting a fresh flow. The authorization server's half of it expires: a
 * pushed request URI lives seconds to minutes (RFC 9126), and login
 * transactions are commonly held for minutes. Past this age a reissued URL
 * more likely lands on an expired session than on consent, and a fresh start
 * costs one authorization request, not a registration. It sits inside the
 * flow record's fifteen minutes.
 */
const PENDING_AUTHORIZATION_MAX_AGE_MS = 10 * 60 * 1000;

export interface FlowBinding {
  issRequired?: true;
  issuer?: string | undefined;
  clientId?: string | undefined;
  tokenEndpoint?: string | undefined;
  discovery?: string | undefined;
}

export function discoveryBinding(state: OAuthDiscoveryState | undefined): Promise<FlowBinding> {
  return runEdge(authProgram<FlowBinding>(discoveryBindingNative, [state]));
}
const discoveryBindingNative = /* @__PURE__ */ registerAuth(
  discoveryBinding,
  function (state: OAuthDiscoveryState | undefined) {
    return authFlow<FlowBinding>(function* () {
      return state
        ? {
            issuer: discoveryIssuer(state),
            tokenEndpoint: state.authorizationServerMetadata?.token_endpoint,
            ...(state.authorizationServerMetadata?.authorization_response_iss_parameter_supported === true
              ? { issRequired: true as const }
              : {}),
            discovery: (yield authCall(oauthStateDigest, [JSON.stringify(state)])) as string,
          }
        : {};
    });
  },
);

/** One consent, by its state's digest. A claimed one keeps only its epoch. */
export interface Flow {
  binding?: FlowBinding;
  epoch: string;
  /** Epoch milliseconds the consent was written. */
  at: number;
  url?: string;
  verifier?: string;
  consumed?: true;
}

interface StoredFlow {
  binding?: FlowBinding;
  connectaOAuthFlow: typeof FLOW_VERSION;
  epoch: string;
  at: number;
  url?: string;
  verifier?: string;
  /** The verifier is ciphertext. */
  sealed?: true;
  consumed?: true;
}

/** KvOAuthProvider's consent and code exchange methods; `authMethods` installs them. */
export const consentMethods = {
  encodeFlow: function (this: KvOAuthProvider, key: string, flow: Flow) {
    return authFlow<string>(
      function* (this: KvOAuthProvider) {
        const { verifier, ...rest } = flow;
        const stored: StoredFlow = { connectaOAuthFlow: FLOW_VERSION, ...rest };
        if (verifier !== undefined) {
          if (this.sealer) {
            stored.verifier = (yield authInvoke(this, "wait", [
              authMethod(() => {
                return authInvoke(this.sealer!, "seal", [this.flowLabel(key, flow.epoch), verifier]) as Effect.Effect<
                  string,
                  unknown
                >;
              }),
            ])) as string;
            stored.sealed = true;
          } else {
            stored.verifier = verifier;
          }
        }
        return JSON.stringify(stored);
      }.bind(this),
    );
  },
  openFlow: function (this: KvOAuthProvider, key: string, raw: string, withVerifier: boolean) {
    return authFlow<Flow | undefined>(
      function* (this: KvOAuthProvider) {
        const value = parsed(raw);
        if (
          !plainObject(value) ||
          value.connectaOAuthFlow !== FLOW_VERSION ||
          typeof value.epoch !== "string" ||
          typeof value.at !== "number" ||
          (value.url !== undefined && typeof value.url !== "string") ||
          (value.verifier !== undefined && typeof value.verifier !== "string")
        ) {
          return undefined;
        }
        const flow: Flow = {
          epoch: value.epoch,
          at: value.at,
          ...(plainObject(value.binding) ? { binding: value.binding as FlowBinding } : {}),
          ...(typeof value.url === "string" ? { url: value.url } : {}),
          ...(value.consumed === true ? { consumed: true as const } : {}),
        };
        if (!withVerifier || typeof value.verifier !== "string") return flow;
        if (value.sealed !== true) return { ...flow, verifier: value.verifier };
        try {
          if (!this.sealer) return undefined;
          return {
            ...flow,
            verifier: (yield authInvoke(this, "wait", [
              authMethod(() => {
                return authInvoke(this.sealer!, "open", [
                  this.flowLabel(key, flow.epoch),
                  value.verifier as string,
                ]) as Effect.Effect<string, unknown>;
              }),
            ])) as string,
          };
        } catch {
          if (this.signal?.aborted) throw aborted(this.signal);
          this.sealer?.warn(
            `[connecta] connector "${this.connectorId}" has a sealed OAuth consent ` +
              "the configured vault cannot open; its callback is refused.",
          );
          return undefined;
        }
      }.bind(this),
    );
  },
  latestConsent: function (this: KvOAuthProvider) {
    return authFlow<(Flow & { url: string }) | undefined>(
      function* (this: KvOAuthProvider) {
        const grant = (yield authInvoke(this, "boundGrant", [])) as Grant;
        if (grant.flow === undefined) return undefined;
        const key = oauthFlowKeys.flow(grant.flow);
        const raw = (yield authInvoke(this, "wait", [
          authMethod(() => {
            return authStorage(this.storage, "get", [key]) as Effect.Effect<string | null, unknown>;
          }),
        ])) as string | null;
        const flow =
          raw === null ? undefined : ((yield authInvoke(this, "openFlow", [key, raw, false])) as Flow | undefined);
        return flow && !flow.consumed && flow.epoch === grant.epoch && flow.url !== undefined
          ? { ...flow, url: flow.url }
          : undefined;
      }.bind(this),
    );
  },
  verifyCallbackState: function (this: KvOAuthProvider, state: string) {
    return authFlow<boolean>(
      function* (this: KvOAuthProvider) {
        if (
          this.callback?.key ===
          oauthFlowKeys.flow(
            (yield authInvoke(this, "wait", [
              authMethod(() => {
                return authCall(oauthStateDigest, [state]) as Effect.Effect<string, unknown>;
              }),
            ])) as string,
          )
        )
          return true;
        return (yield authInvoke(this, "verifyState", [state])) as boolean;
      }.bind(this),
    );
  },
  redirectToAuthorization: function (this: KvOAuthProvider, authorizationUrl: URL) {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        if (this.signal?.aborted) return;
        if (!this.allowAuthorization) throw this.authorizationRefused();
        for (const [name, value] of this.clientOptions?.authorizationParams ?? []) {
          authorizationUrl.searchParams.set(name, value);
        }
        this.assertCredentialFree(
          authorizationUrl.toString(),
          ((yield authInvoke(this, "boundGrant", [])) as Grant).body,
          true,
        );
        const state = this.consent.state ?? authorizationUrl.searchParams.get("state");
        if (!state) throw new Error(`OAuth consent for "${this.connectorId}" carries no state`);
        const client = this.clientOptions?.client;
        if (client && !((yield authInvoke(this, "boundGrant", [])) as Grant).body.client) {
          (yield authInvoke(this, "saveClientInformation", [
            { client_id: client.clientId },
            { issuer: client.issuer },
          ])) as void;
        }
        const configured = this.configuredAuthorizationBinding();
        if (configured?.issuer !== undefined) {
          const issuer = configured.issuer;
          // Static adapters do not save discovery or client configuration. Publish
          // their server identity before consent so a changed endpoint fences the
          // old grant before any code exchange can leave.
          (yield authInvoke(this, "updateGrant", [
            (grant: Grant) => (grant.body.issuer === issuer ? undefined : this.withIssuer(grant, { issuer })),
          ])) as boolean;
        }
        const epoch = (yield authInvoke(this, "flowEpoch", [])) as string;
        this.epoch = epoch;
        const digest = (yield authInvoke(this, "wait", [
          authMethod(() => {
            return authCall(oauthStateDigest, [state]) as Effect.Effect<string, unknown>;
          }),
        ])) as string;
        const key = oauthFlowKeys.flow(digest);
        const url = authorizationUrl.toString();
        const { verifier } = this.consent;
        const grant = (yield authInvoke(this, "boundGrant", [])) as Grant;
        this.assertCredentialFree(url, grant.body, true);
        const binding = this.configuredAuthorizationBinding() ?? {
          ...((yield authInvoke(this, "wait", [
            authMethod(() => {
              return authCall(discoveryBinding, [this.consentDiscovery ?? grant.body.discovery]) as Effect.Effect<
                FlowBinding,
                unknown
              >;
            }),
          ])) as FlowBinding),
          issuer: discoveryIssuer(this.consentDiscovery) ?? grant.body.issuer,
          clientId: authorizationUrl.searchParams.get("client_id") ?? grant.body.client?.value.client_id,
        };
        const record = (yield authInvoke(this, "encodeFlow", [
          key,
          {
            epoch,
            at: Date.now(),
            binding,
            url,
            ...(verifier !== undefined ? { verifier } : {}),
          },
        ])) as string;
        if (this.signal?.aborted) return;
        if (
          !((yield authInvoke(this, "wait", [
            authMethod(() => {
              return authStorage(this.storage, "compareAndSet", [
                key,
                null,
                record,
                { ttlSeconds: OAUTH_FLOW_TTL_SECONDS },
              ]) as Effect.Effect<boolean, unknown>;
            }),
          ])) as boolean)
        ) {
          throw new Error(`OAuth consent for "${this.connectorId}" reused a state`);
        }
        let published = false;
        try {
          published = (yield authInvoke(this, "updateGrant", [
            (grant: Grant) => ({ ...grant, flow: digest }),
            { epoch },
          ])) as boolean;
        } finally {
          if (!published)
            (yield authCatch(
              authInvoke(this, "wait", [
                authMethod(() => {
                  return authStorage(this.storage, "compareAndSet", [key, record, null]) as Effect.Effect<
                    boolean,
                    unknown
                  >;
                }),
              ]),
              () => {},
            )) as boolean | void;
        }
        if (published) this.published = { epoch, url };
      }.bind(this),
    );
  },
  consentUrl: function (this: KvOAuthProvider, signal: AbortSignal | undefined) {
    signal = signal === undefined ? this.signal : signal;

    return authFlow<string | undefined>(
      function* (this: KvOAuthProvider) {
        const published = this.published;
        if (!published) return undefined;
        if (
          epochOf(
            (yield authInvoke(this, "wait", [
              authMethod(() => {
                return authStorage(this.storage, "get", [GRANT]) as Effect.Effect<string | null, unknown>;
              }),
              signal,
            ])) as string | null,
          ) !== published.epoch
        )
          throw this.flowSuperseded();
        this.assertCredentialFree(
          published.url,
          ((yield authInvoke(this, "boundGrant", [signal])) as Grant).body,
          true,
        );
        return published.url;
      }.bind(this),
    );
  },
  pendingAuthorizationUrl: function (this: KvOAuthProvider) {
    return authFlow<string | undefined>(
      function* (this: KvOAuthProvider) {
        const url = (
          (yield authInvoke(this, "latestConsent", [])) as
            | (Flow & {
                url: string;
              })
            | undefined
        )?.url;
        this.assertCredentialFree(url, ((yield authInvoke(this, "boundGrant", [])) as Grant).body, true);
        return url;
      }.bind(this),
    );
  },
  reusablePendingAuthorizationUrl: function (this: KvOAuthProvider) {
    return authFlow<string | undefined>(
      function* (this: KvOAuthProvider) {
        const consent = (yield authInvoke(this, "latestConsent", [])) as
          | (Flow & {
              url: string;
            })
          | undefined;
        if (!consent || Math.abs(Date.now() - consent.at) >= PENDING_AUTHORIZATION_MAX_AGE_MS) {
          return undefined;
        }
        this.assertCredentialFree(consent.url, ((yield authInvoke(this, "boundGrant", [])) as Grant).body, true);
        let clientId: string | null;
        try {
          clientId = new URL(consent.url).searchParams.get("client_id");
        } catch {
          return undefined;
        }
        const client = (yield authInvoke(this, "clientInformation", [])) as OAuthClientInformationMixed | undefined;
        return clientId !== null && client?.client_id === clientId ? consent.url : undefined;
      }.bind(this),
    );
  },
  verifyState: function (this: KvOAuthProvider, candidate: string | null) {
    return authFlow<boolean>(
      function* (this: KvOAuthProvider) {
        this.callback = undefined;
        if (candidate === null) return false;
        const key = oauthFlowKeys.flow(
          (yield authInvoke(this, "wait", [
            authMethod(() => {
              return authCall(oauthStateDigest, [candidate]) as Effect.Effect<string, unknown>;
            }),
          ])) as string,
        );
        const raw = (yield authInvoke(this, "wait", [
          authMethod(() => {
            return authStorage(this.storage, "get", [key]) as Effect.Effect<string | null, unknown>;
          }),
        ])) as string | null;
        const flow =
          raw === null ? undefined : ((yield authInvoke(this, "openFlow", [key, raw, true])) as Flow | undefined);
        if (raw === null || !flow || flow.consumed) return false;
        this.callback = { key, raw, flow, claimed: false };
        this.epoch = flow.epoch;
        return true;
      }.bind(this),
    );
  },
  claimCodeExchange: function (this: KvOAuthProvider) {
    return authFlow<Response | undefined>(
      function* (this: KvOAuthProvider) {
        if (this.exchangeRefusal) return this.exchangeRefusal.clone();
        (yield authInvoke(this, "claimConsent", [])) as void;
        return undefined;
      }.bind(this),
    );
  },
  consumeAuthError: function (this: KvOAuthProvider) {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        const { grant } = (yield authInvoke(this, "readGrant", [])) as {
          raw: string | null;
          grant: Grant;
        };
        if (!this.callback || grant.epoch !== this.callback.flow.epoch) throw this.flowSuperseded();
        (yield authInvoke(this, "checkFlowBinding", [grant])) as void;
        (yield authInvoke(this, "claimConsent", [])) as void;
        this.callback = undefined;
      }.bind(this),
    );
  },
  claimConsent: function (this: KvOAuthProvider) {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        const callback = this.callback;
        if (!callback) throw this.flowSuperseded();
        if (callback.claimed) throw new OAuthCallbackClaimedError(this.connectorId);
        callback.claimed = true;
        const { epoch, at } = callback.flow;
        const claimed = JSON.stringify({
          connectaOAuthFlow: FLOW_VERSION,
          epoch,
          at,
          consumed: true,
        } satisfies StoredFlow);
        const remaining = Math.ceil((at + OAUTH_FLOW_TTL_SECONDS * 1000 - Date.now()) / 1000);
        const ttlSeconds = Math.min(OAUTH_FLOW_TTL_SECONDS, Math.max(1, remaining));
        if (
          (yield authInvoke(this, "wait", [
            authMethod(() => {
              return authStorage(this.storage, "compareAndSet", [
                callback.key,
                callback.raw,
                claimed,
                { ttlSeconds },
              ]) as Effect.Effect<boolean, unknown>;
            }),
          ])) as boolean
        ) {
          return;
        }
        if (
          epochOf(
            (yield authInvoke(this, "wait", [
              authMethod(() => {
                return authStorage(this.storage, "get", [GRANT]) as Effect.Effect<string | null, unknown>;
              }),
            ])) as string | null,
          ) !== epoch
        )
          throw this.flowSuperseded();
        throw new OAuthCallbackClaimedError(this.connectorId);
      }.bind(this),
    );
  },
  dispatchCodeExchange: function (this: KvOAuthProvider, send: () => Promise<Response>, endpoint?: string | URL) {
    return authFlow<Response>(
      function* (this: KvOAuthProvider) {
        const epoch = this.epoch;
        if (!this.codeExchange || epoch === undefined) throw this.flowSuperseded();
        const raw = (yield authInvoke(this, "wait", [
          authMethod(() => {
            return authStorage(this.storage, "get", [GRANT]) as Effect.Effect<string | null, unknown>;
          }),
        ])) as string | null;
        const grant = (yield authInvoke(this, "openGrant", [raw])) as Grant;
        if (grant.epoch !== epoch) throw this.flowSuperseded();
        (yield authInvoke(this, "checkFlowBinding", [grant])) as void;
        if (endpoint !== undefined && this.callback?.flow.binding?.tokenEndpoint !== String(endpoint)) {
          throw this.flowSuperseded();
        }
        // Opening ciphertext may yield. Re-read the exact record after opening,
        // then check and send in the same reaction, without another await.
        return (yield authInvoke(this, "wait", [
          authMethod(() => {
            return authThen(
              authStorage(this.storage, "get", [GRANT]),
              authMethod((current: string | null) => {
                return authFlow<Response>(
                  function* (this: KvOAuthProvider) {
                    if (this.signal?.aborted) throw aborted(this.signal);
                    if (current !== raw) throw this.flowSuperseded();
                    const sent = send();
                    sent.catch(() => {});
                    return (yield authValue(() => sent)) as Response;
                  }.bind(this),
                );
              }),
            ) as Effect.Effect<Response, unknown>;
          }),
        ])) as Response;
      }.bind(this),
    );
  },
  recordCodeExchangeTokens: function (this: KvOAuthProvider, tokens: OAuthTokens) {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        this.exchangeConsent = undefined;
        if (tokens.refresh_token === undefined) return;
        try {
          const digest = (yield authInvoke(this, "wait", [
            authMethod(() => {
              return authCall(oauthStateDigest, [tokens.refresh_token!]) as Effect.Effect<string, unknown>;
            }),
          ])) as string;
          const resolution = (yield authInvoke(this, "wait", [
            authMethod(() => {
              return authStorage(this.storage, "get", [oauthRefreshSpentKeys.spent(digest)]) as Effect.Effect<
                string | null,
                unknown
              >;
            }),
          ])) as string | null;
          const spent = storedRefreshSpent(resolution);
          // Observing the exact resolved storage write before consent completion
          // proves their order without comparing isolate clocks. A consent that
          // saw outstanding/ambiguous cannot become eligible on a delayed save.
          if (spent?.state === "resolved") this.exchangeConsent = { digest, resolution: resolution! };
        } catch {
          if (this.signal?.aborted) throw aborted(this.signal);
          throw this.credentialWriteError();
        }
      }.bind(this),
    );
  },
  sweepConsents: function (this: KvOAuthProvider) {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        try {
          const consents: Array<[string, string]> = [];
          for (const key of (yield authStorage(this.storage, "list", [oauthFlowKeys.prefix])) as string[]) {
            const raw = (yield authStorage(this.storage, "get", [key])) as string | null;
            if (raw !== null) consents.push([key, raw]);
          }
          const live = epochOf((yield authStorage(this.storage, "get", [GRANT])) as string | null);
          for (const [key, raw] of consents) {
            const flow = parsed(raw);
            if (plainObject(flow) && flow.epoch === live) continue;
            (yield authStorage(this.storage, "compareAndSet", [key, raw, null])) as boolean;
          }
        } catch {
          // Hygiene only: the epoch, not this, fences a stale consent.
        }
      }.bind(this),
    );
  },
};
