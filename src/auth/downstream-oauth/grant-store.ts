// The grant record and its epochs for KvOAuthProvider: reading, sealing and
// compare-and-set writes of one owner's grant, flow binding to an epoch, and
// the resets and disconnects that replace it.
import type {
  FetchLike,
  OAuthClientInformationMixed,
  OAuthDiscoveryState,
  OAuthTokens,
} from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { runEdge } from "../../runtime/run.js";
import { oauthGrantKeys, retiredOAuthKeys } from "../../storage/keys.js";
import { revokeDownstreamGrant } from "../downstream-revocation.js";
import { authAwait, authCall, authCatch, authFlow, authInvoke, authMethod, authStorage, authValue } from "../native.js";
import { discoveryIssuer, tokenExpiry, type OAuthGrantBody } from "../oauth-grant.js";
import type { KvOAuthProvider } from "../downstream-oauth.js";
import { aborted } from "./refresh-coordinator.js";
import { type FlowBinding, discoveryBinding } from "./consent.js";

export const GRANT = oauthGrantKeys.grant;
/** The epoch of an owner with no grant record yet. */
const INITIAL_EPOCH = "initial";
/** The epoch of a record that does not parse: readers see no grant in it. */
const UNREADABLE_EPOCH = "unreadable";
export const ACTIVE_EPOCH_PREFIX = "v3:";
const DISCONNECTED_EPOCH_PREFIX = "disconnected:";
const GRANT_VERSION = 3;
/** Attempts at one grant write while other writers keep winning. */
export const MAX_GRANT_WRITES = 32;

export type GrantBody = OAuthGrantBody & {
  /** The exact resolved storage write observed before this consent committed. */
  refreshConsent?: { digest: string; resolution: string };
};

/**
 * One owner's grant: its epoch, the state digest of the epoch's latest
 * consent, and one authorization server's client, tokens, and discovery.
 * A value written for another server replaces the body whole, so a grant
 * never mixes servers and nothing it holds is sent to one that did not
 * issue it.
 */
export interface Grant {
  epoch: string;
  flow?: string;
  body: GrantBody;
}

/** A grant as stored: the body sealed when the vault can seal. */
interface StoredGrant {
  connectaOAuth: typeof GRANT_VERSION;
  epoch: string;
  flow?: string;
  sealed?: string;
  body?: GrantBody;
}

export function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parsed(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function storedGrant(raw: string): StoredGrant | undefined {
  const value = parsed(raw);
  return plainObject(value) &&
    value.connectaOAuth === GRANT_VERSION &&
    typeof value.epoch === "string" &&
    (value.flow === undefined || typeof value.flow === "string") &&
    (value.sealed === undefined || typeof value.sealed === "string")
    ? (value as unknown as StoredGrant)
    : undefined;
}

/** The epoch a raw grant record names, without opening its body. */
export function epochOf(raw: string | null): string {
  if (raw === null) return INITIAL_EPOCH;
  return storedGrant(raw)?.epoch ?? UNREADABLE_EPOCH;
}

/** Nothing here trusts stored bytes: keep only what has the expected shape. */
function grantBody(value: unknown): GrantBody {
  if (!plainObject(value)) return {};
  const { issuer, client, tokens, expiresAt, discovery, refreshConsent } = value;
  const hasTokens = plainObject(tokens) && typeof tokens.access_token === "string";
  return {
    ...(typeof issuer === "string" ? { issuer } : {}),
    ...(plainObject(client) && plainObject(client.value) && typeof client.value.client_id === "string"
      ? {
          client: {
            value: client.value as unknown as OAuthClientInformationMixed,
            ...(typeof client.binding === "string" ? { binding: client.binding } : {}),
            ...(client.carried === true ? { carried: true as const } : {}),
            ...(client.registrationPath === "cimd" ||
            client.registrationPath === "dcr" ||
            client.registrationPath === "static"
              ? { registrationPath: client.registrationPath }
              : {}),
          },
        }
      : {}),
    ...(hasTokens ? { tokens: tokens as unknown as OAuthTokens } : {}),
    // Meaningful only beside the tokens it describes.
    ...(hasTokens && typeof expiresAt === "number" && Number.isFinite(expiresAt) ? { expiresAt } : {}),
    ...(discoveryIssuer(discovery) !== undefined ? { discovery: discovery as unknown as OAuthDiscoveryState } : {}),
    ...(plainObject(refreshConsent) &&
    typeof refreshConsent.digest === "string" &&
    typeof refreshConsent.resolution === "string"
      ? { refreshConsent: { digest: refreshConsent.digest, resolution: refreshConsent.resolution } }
      : {}),
  };
}

/** What an invalidation compares: the value exactly as this flow saw it. */
export function fingerprint(value: unknown): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value);
}

export function isDisconnectedEpoch(epoch: string): boolean {
  return epoch.startsWith(DISCONNECTED_EPOCH_PREFIX);
}

/** KvOAuthProvider's grant and epoch methods; `authMethods` installs them. */
export const grantStoreMethods = {
  wait: function <T>(this: KvOAuthProvider, work: () => Promise<T>, signal: AbortSignal | null | undefined) {
    signal = signal === undefined ? this.signal : signal;
    return authFlow<T>(function* () {
      if (signal?.aborted) throw aborted(signal);
      const value = signal
        ? ((yield authAwait(authCall<T>(work, []), { signal }.signal)) as Awaited<T>)
        : ((yield authCall(work, [])) as Awaited<T>);
      if (signal?.aborted) throw aborted(signal);
      return value;
    });
  },
  encodeGrant: function (this: KvOAuthProvider, grant: Grant, signal: AbortSignal | null | undefined) {
    signal = signal === undefined ? this.signal : signal;

    return authFlow<string>(
      function* (this: KvOAuthProvider) {
        this.assertCredentialFree({ issuer: grant.body.issuer, discovery: grant.body.discovery }, grant.body);
        const stored: StoredGrant = {
          connectaOAuth: GRANT_VERSION,
          epoch: grant.epoch,
          ...(grant.flow !== undefined ? { flow: grant.flow } : {}),
        };
        if (Object.keys(grant.body).length > 0) {
          if (this.sealer) {
            stored.sealed = (yield authInvoke(this, "wait", [
              authMethod(() => {
                return authInvoke(this.sealer!, "seal", [
                  this.grantLabel(grant.epoch),
                  JSON.stringify(grant.body),
                ]) as Effect.Effect<string, unknown>;
              }),
              signal,
            ])) as string;
          } else {
            stored.body = grant.body;
          }
        }
        return JSON.stringify(stored);
      }.bind(this),
    );
  },
  openGrant: function (this: KvOAuthProvider, raw: string | null, signal: AbortSignal | null | undefined) {
    signal = signal === undefined ? this.signal : signal;

    return authFlow<Grant>(
      function* (this: KvOAuthProvider) {
        const stored = raw === null ? undefined : storedGrant(raw);
        if (!stored) {
          this.observed = undefined;
          return { epoch: raw === null ? INITIAL_EPOCH : UNREADABLE_EPOCH, body: {} };
        }
        let body: unknown = stored.body;
        if (stored.sealed !== undefined) {
          body = undefined;
          try {
            if (this.sealer)
              body = parsed(
                (yield authInvoke(this, "wait", [
                  authMethod(() => {
                    return authInvoke(this.sealer!, "open", [
                      this.grantLabel(stored.epoch),
                      stored.sealed!,
                    ]) as Effect.Effect<string, unknown>;
                  }),
                  signal,
                ])) as string,
              );
          } catch {
            if (signal?.aborted) throw aborted(signal);
            this.sealer?.warn(
              `[connecta] connector "${this.connectorId}" has a sealed OAuth grant ` +
                "the configured vault cannot open; treating it as absent, so the " +
                "connector needs authorization again. A changed vault key or " +
                "tampered storage causes this.",
            );
          }
        }
        const grant: Grant = {
          epoch: stored.epoch,
          ...(stored.flow !== undefined ? { flow: stored.flow } : {}),
          body: grantBody(body),
        };
        this.observe(grant);
        return grant;
      }.bind(this),
    );
  },
  storedAuthorization: function (this: KvOAuthProvider, issuer?: string) {
    return authFlow<boolean>(
      function* (this: KvOAuthProvider) {
        const raw = (yield authStorage(this.storage, "get", [GRANT])) as string | null;
        const grant = (yield authInvoke(this, "openGrant", [raw])) as Grant;
        if (isDisconnectedEpoch(grant.epoch)) return false;
        const body = grant.body;
        const configured = issuer ?? this.clientOptions?.client?.issuer;
        const discovered = body.discovery;
        if (
          !configured &&
          (!discovered || discovered.authorizationServerMetadata?.issuer !== discovered.authorizationServerUrl)
        )
          return false;
        const expected = configured ?? discoveryIssuer(discovered);
        return Boolean(expected && body.issuer === expected && body.tokens?.access_token);
      }.bind(this),
    ).pipe(Effect.catch(() => Effect.succeed(false)));
  },
  peekGrant: function (this: KvOAuthProvider) {
    return authFlow<{ epoch: string; tokens?: OAuthTokens }>(
      function* (this: KvOAuthProvider) {
        const raw = (yield authInvoke(this, "wait", [
          authMethod(() => authStorage(this.storage, "get", [GRANT]) as Effect.Effect<string | null, unknown>),
        ])) as string | null;
        const grant = (yield authInvoke(this, "openGrant", [raw])) as Grant;
        return { epoch: grant.epoch, ...(grant.body.tokens ? { tokens: grant.body.tokens } : {}) };
      }.bind(this),
    );
  },
  readGrant: function (this: KvOAuthProvider, signal: AbortSignal | null | undefined) {
    signal = signal === undefined ? this.signal : signal;

    return authFlow<{ raw: string | null; grant: Grant }>(
      function* (this: KvOAuthProvider) {
        let raw = (yield authInvoke(this, "wait", [
          authMethod(() => {
            return authStorage(this.storage, "get", [GRANT]) as Effect.Effect<string | null, unknown>;
          }),
          signal,
        ])) as string | null;
        if (raw === null) {
          // Inspect names only: retired credentials are never opened or copied.
          const keys = (yield authInvoke(this, "wait", [
            authMethod(() => authStorage(this.storage, "list", [retiredOAuthKeys.scan])),
            signal,
          ])) as string[];
          if (keys.some((key) => retiredOAuthKeys.prefixes.some((prefix) => key.startsWith(prefix))))
            (this.sealer ?? console).warn(
              `[connecta] connector "${this.connectorId}" has an unsupported pre-layout-3 OAuth grant; ` +
                "treating it as absent. Connect again to authorize, or restore a backup and run the " +
                "OAuth migration on Connecta 0.37.1 before upgrading.",
            );
        }
        const grant = (yield authInvoke(this, "openGrant", [raw, signal])) as Grant;
        if (raw !== null && this.sealer && storedGrant(raw)?.body !== undefined) {
          const sealed = (yield authInvoke(this, "encodeGrant", [grant, signal])) as string;
          if (
            (yield authInvoke(this, "wait", [
              authMethod(() => {
                return authCatch(
                  authStorage(this.storage, "compareAndSet", [GRANT, raw, sealed]),
                  () => false,
                ) as Effect.Effect<boolean, unknown>;
              }),
              signal,
            ])) as boolean
          )
            raw = sealed;
        }
        return { raw, grant };
      }.bind(this),
    );
  },
  boundGrant: function (this: KvOAuthProvider, signal: AbortSignal | null | undefined) {
    signal = signal === undefined ? this.signal : signal;

    return authFlow<Grant>(
      function* (this: KvOAuthProvider) {
        const { grant } = (yield authInvoke(this, "readGrant", [signal])) as {
          raw: string | null;
          grant: Grant;
        };
        if (this.bound && grant.epoch !== this.epoch) throw this.flowSuperseded();
        return grant;
      }.bind(this),
    );
  },
  activeGrant: function (this: KvOAuthProvider) {
    return authInvoke(this, "boundGrant", []) as Effect.Effect<Grant, unknown>;
  },
  updateGrant: function (
    this: KvOAuthProvider,
    change: (grant: Grant) => Grant | undefined,
    options: {
      epoch?: string;
      quiet?: boolean;
      commit?: boolean;
      beforeWrite?: () => void;
      signal?: AbortSignal;
    } = {},
  ) {
    return authFlow<boolean>(
      function* (this: KvOAuthProvider) {
        const signal = options.signal ?? (options.commit ? null : this.signal);
        for (let attempt = 0; attempt < MAX_GRANT_WRITES; attempt++) {
          if (!options.commit && this.signal?.aborted) return false;
          const { raw, grant } = (yield authInvoke(this, "readGrant", [signal])) as {
            raw: string | null;
            grant: Grant;
          };
          const epoch = options.epoch ?? (this.epoch ??= grant.epoch);
          if (grant.epoch !== epoch) {
            if (options.quiet || !this.bound) return false;
            throw this.flowSuperseded();
          }
          // A disconnect's epoch holds nothing until an explicit start replaces it.
          if (isDisconnectedEpoch(epoch)) return false;
          const next = change(grant);
          if (next === undefined) return true;
          const encoded = (yield authInvoke(this, "encodeGrant", [next, signal])) as string;
          if (!options.commit && this.signal?.aborted) return false;
          let written: boolean;
          try {
            written = (yield authInvoke(this, "wait", [
              authMethod(() => {
                return authStorage<boolean>(
                  this.storage,
                  "compareAndSet",
                  [GRANT, raw, encoded],
                  options.beforeWrite && (() => options.beforeWrite?.()),
                );
              }),
              signal,
            ])) as boolean;
          } catch {
            if (signal?.aborted) throw aborted(signal);
            // A store's own error can quote the value it refused.
            throw this.credentialWriteError();
          }
          if (written) {
            if (next.epoch !== grant.epoch) this.epoch = next.epoch;
            this.observe(next);
            return true;
          }
        }
        throw this.credentialWriteError();
      }.bind(this),
    );
  },
  writeCredential: function (
    this: KvOAuthProvider,
    field: "client" | "tokens",
    value: NonNullable<GrantBody["client"] | GrantBody["tokens"]>,
    issuer: string | undefined,
    refreshConsent?: GrantBody["refreshConsent"],
  ) {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        // The SDK saves a code exchange's tokens once its answer is read;
        // their lifetime started when its request was sent.
        const issuedAt = (field === "tokens" ? this.tokenRequestSent : undefined) ?? Date.now();
        (yield authInvoke(this, "updateGrant", [
          (grant: Grant) => {
            const body: GrantBody =
              issuer !== undefined && grant.body.issuer !== issuer ? { issuer } : { ...grant.body };
            if (field === "client") body.client = value as NonNullable<GrantBody["client"]>;
            else {
              const tokens = value as OAuthTokens;
              // The same access token saved again keeps the expiry it was issued with.
              const expiresAt =
                body.tokens?.access_token === tokens.access_token && body.expiresAt !== undefined
                  ? body.expiresAt
                  : tokenExpiry(tokens, issuedAt);
              body.tokens = tokens;
              delete body.expiresAt;
              if (expiresAt !== undefined) body.expiresAt = expiresAt;
              delete body.refreshConsent;
              if (refreshConsent) body.refreshConsent = refreshConsent;
            }
            return this.withIssuer(grant, body);
          },
        ])) as boolean;
        if (field === "tokens") this.tokenRequestSent = undefined;
        // A flow may invalidate what it wrote itself.
        this.seen[field] = fingerprint(field === "client" ? (value as NonNullable<GrantBody["client"]>).value : value);
      }.bind(this),
    );
  },
  bindingForGrant: function (this: KvOAuthProvider, grant: Grant) {
    return authFlow<FlowBinding>(
      function* (this: KvOAuthProvider) {
        const configured = this.configuredAuthorizationBinding();
        return configured
          ? { ...configured, issuer: grant.body.issuer }
          : {
              ...((yield authInvoke(this, "wait", [
                authMethod(() => {
                  return authCall(discoveryBinding, [grant.body.discovery]) as Effect.Effect<FlowBinding, unknown>;
                }),
              ])) as FlowBinding),
              issuer: grant.body.issuer,
              clientId: grant.body.client?.value.client_id,
            };
      }.bind(this),
    );
  },
  checkFlowBinding: function (this: KvOAuthProvider, grant: Grant) {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        const binding = this.callback?.flow.binding;
        if (
          !binding ||
          fingerprint(binding) !== fingerprint((yield authInvoke(this, "bindingForGrant", [grant])) as FlowBinding)
        ) {
          throw this.flowSuperseded();
        }
      }.bind(this),
    );
  },
  liveEpoch: function (this: KvOAuthProvider) {
    return authFlow<string>(
      function* (this: KvOAuthProvider) {
        return (
          (yield authInvoke(this, "readGrant", [])) as {
            raw: string | null;
            grant: Grant;
          }
        ).grant.epoch;
      }.bind(this),
    );
  },
  operatorDisconnected: function (this: KvOAuthProvider) {
    return authFlow<boolean>(
      function* (this: KvOAuthProvider) {
        return isDisconnectedEpoch((yield authInvoke(this, "liveEpoch", [])) as string);
      }.bind(this),
    );
  },
  beginFlow: function (this: KvOAuthProvider, expectedEpoch?: string) {
    return authFlow<string>(
      function* (this: KvOAuthProvider) {
        const epoch = (yield authInvoke(this, "liveEpoch", [])) as string;
        if (expectedEpoch !== undefined && epoch !== expectedEpoch) throw this.flowSuperseded();
        this.epoch = epoch;
        this.bound = true;
        return epoch;
      }.bind(this),
    );
  },
  flowEpoch: function (this: KvOAuthProvider) {
    return authFlow<string>(
      function* (this: KvOAuthProvider) {
        return this.epoch ?? ((yield authInvoke(this, "liveEpoch", [])) as string);
      }.bind(this),
    );
  },
  bindFlow: function (this: KvOAuthProvider) {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        const { grant } = (yield authInvoke(this, "readGrant", [])) as {
          raw: string | null;
          grant: Grant;
        };
        const epoch = this.callback?.flow.epoch ?? this.epoch ?? grant.epoch;
        if (grant.epoch !== epoch) throw this.flowSuperseded();
        this.epoch = epoch;
        this.bound = true;
        this.codeExchange = true;
        (yield authInvoke(this, "checkFlowBinding", [grant])) as void;
        this.seen = {
          client: fingerprint(grant.body.client?.value),
          tokens: fingerprint(grant.body.tokens),
        };
      }.bind(this),
    );
  },
  resetAuthorization: function (
    this: KvOAuthProvider,
    operatorDisconnected: boolean = false,
    preserveClient: boolean = false,
  ) {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        const operation = authInvoke<void>(this, "performReset", [operatorDisconnected, preserveClient]);
        if (!this.onReset) return (yield operation) as void;
        const reset = runEdge(operation);
        this.onReset?.(reset);
        return (yield authValue(() => reset)) as void;
      }.bind(this),
    );
  },
  disconnectAuthorization: function (this: KvOAuthProvider, send: FetchLike) {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        const operation = authInvoke<void>(this, "performReset", [true, false, send]);
        if (!this.onReset) return (yield operation) as void;
        const reset = runEdge(operation);
        this.onReset?.(reset);
        return (yield authValue(() => reset)) as void;
      }.bind(this),
    );
  },
  performReset: function (
    this: KvOAuthProvider,
    operatorDisconnected: boolean,
    preserveClient: boolean,
    revoke?: FetchLike,
  ) {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        const epoch = `${operatorDisconnected ? DISCONNECTED_EPOCH_PREFIX : ACTIVE_EPOCH_PREFIX}${crypto.randomUUID()}`;
        for (let attempt = 0; attempt < MAX_GRANT_WRITES; attempt++) {
          const { raw, grant } = (yield authInvoke(this, "readGrant", [null])) as {
            raw: string | null;
            grant: Grant;
          };
          const carried = preserveClient && !operatorDisconnected ? this.carriableClient(grant) : undefined;
          const encoded = (yield authInvoke(this, "encodeGrant", [{ epoch, body: carried ?? {} }, null])) as string;
          let written: boolean;
          try {
            written = (yield authStorage(this.storage, "compareAndSet", [GRANT, raw, encoded])) as boolean;
          } catch {
            throw this.credentialWriteError();
          }
          if (written) {
            this.refreshCoordinator?.retire(grant.epoch);
            try {
              (yield authInvoke(this, "sweepConsents", [])) as void;
              (yield authInvoke(this, "sweepRefreshLeases", [])) as void;
            } finally {
              if (revoke) {
                const snapshot = this.revocationSnapshot(grant.body);
                (yield authCall(revokeDownstreamGrant, [snapshot.body, revoke, snapshot.client])) as void;
              }
            }
            return;
          }
        }
        throw this.credentialWriteError();
      }.bind(this),
    );
  },
};
