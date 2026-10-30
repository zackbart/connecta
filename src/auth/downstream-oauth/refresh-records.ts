// Refresh lease and spent records for KvOAuthProvider: the shared-storage
// claim that keeps isolates from redeeming one refresh token twice, and the
// stored outcome of each redemption.
import type { OAuthTokens } from "@modelcontextprotocol/client";
import { UnauthorizedError } from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { fromSignal } from "../../runtime/run.js";
import {
  OAUTH_REFRESH_LEASE_SECONDS,
  oauthRefreshActiveKeys,
  oauthRefreshKeys,
  oauthRefreshSpentKeys,
} from "../../storage/keys.js";
import { authCall, authCatch, authFlow, authInvoke, authMethod, authStorage, authStorageMany } from "../native.js";
import { type RefreshFailure } from "../oauth-token-response.js";
import { tokenExpiry } from "../oauth-grant.js";
import { GRANT, type Grant, MAX_GRANT_WRITES, epochOf, parsed, plainObject } from "./grant-store.js";
import type { KvOAuthProvider } from "../downstream-oauth.js";
import { type RefreshWait, aborted, refreshTokensDigest, refreshWait } from "./refresh-coordinator.js";
import { oauthStateDigest } from "./consent.js";

/**
 * One redemption of one epoch's refresh token. It holds no request state: the
 * owner settles it from its own request, and joined requests only await it.
 */
export interface RefreshLease {
  spentKey: string;
  spentExpected: string | null;
  spentRaw?: string;
  key: string;
  raw: string;
}

interface StoredRefreshSpent {
  connectaOAuthRefreshSpent: 1;
  epoch: string;
  holder: string;
  activeKey: string;
  state: "outstanding" | "ambiguous" | "resolved";
  resolvedAt?: number;
}

export function storedRefreshSpent(raw: string | null): StoredRefreshSpent | undefined {
  const value = raw === null ? undefined : parsed(raw);
  return plainObject(value) &&
    value.connectaOAuthRefreshSpent === 1 &&
    typeof value.epoch === "string" &&
    typeof value.holder === "string" &&
    typeof value.activeKey === "string" &&
    (value.state === "outstanding" ||
      value.state === "ambiguous" ||
      (value.state === "resolved" && typeof value.resolvedAt === "number" && Number.isFinite(value.resolvedAt)))
    ? (value as unknown as StoredRefreshSpent)
    : undefined;
}

interface StoredRefreshLease {
  connectaOAuthRefresh: 1;
  holder: string;
  state: "claimed" | "dispatched";
  activeKey?: string;
  expiresAt: number;
  verdict?: RefreshFailure;
  completed?: true;
  tokenDigest?: string;
  /** Resolved holder a reusable-token generation's unsent claim replaces. */
  predecessor?: string;
}
/**
 * Polling for another isolate's refresh. Each poll is one batched storage
 * read of its lease, the grant, the spent fingerprint and the owner's
 * liveness key. Doubling from 50 ms to 2 s, a wait that runs to the 35 s
 * deadline costs at most 22 polls; a typical sub-second refresh, four or five.
 */
const REFRESH_POLL_INITIAL_MS = 50;
const REFRESH_POLL_MAX_MS = 2_000;

/** KvOAuthProvider's refresh lease and spent record methods; `authMethods` installs them. */
export const refreshRecordMethods = {
  claimRefresh: function (
    this: KvOAuthProvider,
    epoch: string,
    requested: string | null,
    signal?: AbortSignal,
    sharedWait?: RefreshWait,
  ) {
    return authFlow<Response | RefreshLease>(
      function* (this: KvOAuthProvider) {
        const waiting = sharedWait ?? refreshWait(signal);
        const wait = waiting.run;
        const read = (key: string) =>
          authCall<string | null>(wait, [authMethod(() => authStorage(this.storage, "get", [key]))]);
        const discard = () =>
          authCall<void>(wait, [
            authMethod(() =>
              authInvoke(this, "discardRefusedGrant", [requested, epoch, waiting.transfer, waiting.signal]),
            ),
          ]);
        const tokens = () =>
          authCall<OAuthTokens | undefined>(wait, [
            authMethod(() => authInvoke(this, "storedTokens", [waiting.signal])),
          ]);
        let delay = REFRESH_POLL_INITIAL_MS;
        try {
          const digest = (yield authCall(wait, [
            authMethod(() => {
              return authCall(oauthStateDigest, [requested ?? ""]) as Effect.Effect<string, unknown>;
            }),
          ])) as string;
          const key = oauthRefreshKeys.lease(epoch, digest);
          const spentKey = oauthRefreshSpentKeys.spent(digest);
          type Polled = { lease: string | null; grant: Grant; spent: string | null; active: string | null };
          // One batched read per poll. The lease comes first, so a store that
          // reads the keys one at a time never pairs a completed lease with the
          // grant as it was before that lease's commit.
          const poll = (activeKey: string | undefined) =>
            authCall<Polled>(wait, [
              authMethod(() =>
                authFlow<Polled>(
                  function* (this: KvOAuthProvider) {
                    const [lease, raw, spent, active] = (yield authStorageMany(this.storage, [
                      key,
                      GRANT,
                      spentKey,
                      ...(activeKey !== undefined ? [activeKey] : []),
                    ])) as (string | null)[];
                    const grant = (yield authInvoke(this, "openGrant", [raw ?? null, waiting.signal])) as Grant;
                    if (this.bound && grant.epoch !== this.epoch) throw this.flowSuperseded();
                    return { lease: lease ?? null, grant, spent: spent ?? null, active: active ?? null };
                  }.bind(this),
                ),
              ),
            ]);
          /** The liveness key the previous poll's lease named, read with the next poll. */
          let activeKey: string | undefined;
          while (!waiting.signal.aborted) {
            const polled = (yield poll(activeKey)) as Polled;
            const current = polled.grant.body.tokens;
            if (current?.refresh_token !== requested || (current && this.refreshedSinceRead(current, epoch))) {
              if (!current) this.recordRefreshFailure({ kind: "dead" });
              return current ? this.adoptRefresh(current) : Response.json({ error: "invalid_grant" }, { status: 400 });
            }
            const raw = polled.lease;
            const stored = raw === null ? undefined : parsed(raw);
            const committed =
              plainObject(stored) &&
              (stored.completed === true || (stored.state === "claimed" && typeof stored.predecessor === "string")) &&
              current !== undefined &&
              stored.tokenDigest ===
                ((yield authCall(wait, [
                  authMethod(() => {
                    return authCall(refreshTokensDigest, [current]) as Effect.Effect<string, unknown>;
                  }),
                ])) as string);
            const completed = committed && stored.completed === true;
            if (plainObject(stored) && (plainObject(stored.verdict) || (stored.completed === true && !committed))) {
              this.recordRefreshFailure({ kind: "dead" });
              (yield discard()) as void;
              throw new UnauthorizedError("OAuth refresh grant is no longer active.");
            }
            if (plainObject(stored) && stored.state !== "claimed" && !completed) {
              // Never compare another isolate's clock for a sent request. The
              // durable record survives expiry of this storage-owned liveness key.
              const named = typeof stored.activeKey === "string" ? stored.activeKey : undefined;
              const active =
                named === undefined
                  ? null
                  : named === activeKey
                    ? polled.active
                    : ((yield read(named)) as string | null);
              activeKey = named;
              if (active === null) {
                const refused = JSON.stringify({ ...stored, verdict: { kind: "dead" } });
                if (
                  (yield authCall(wait, [
                    authMethod(() => {
                      return authStorage<boolean>(this.storage, "compareAndSet", [key, raw, refused], () =>
                        waiting.transfer(),
                      );
                    }),
                  ])) as boolean
                ) {
                  (yield authCall(wait, [
                    authMethod(() => {
                      return authInvoke(this, "resolveRefreshSpent", [
                        { key, spentKey, spentExpected: null, raw: raw! },
                        "ambiguous",
                      ]) as Effect.Effect<void, unknown>;
                    }),
                  ])) as void;
                  this.recordRefreshFailure({ kind: "dead" });
                  (yield discard()) as void;
                  throw new UnauthorizedError("OAuth refresh outcome is unknown; authorization required.");
                }
                continue;
              }
            } else {
              const spentExpected = polled.spent;
              if (spentExpected !== null) {
                const spent = storedRefreshSpent(spentExpected);
                const consent = polled.grant.body.refreshConsent;
                if (
                  spent?.state !== "resolved" ||
                  !(
                    // A completed lease proves these exact tokens committed.
                    // Reusable refresh tokens may start another generation,
                    // but only after its own dispatch is durably resolved.
                    (committed &&
                      spent.epoch === epoch &&
                      spent.holder === (completed ? stored.holder : stored.predecessor)) ||
                    (spent.epoch !== epoch && consent?.digest === digest && consent.resolution === spentExpected)
                  )
                ) {
                  // Lease and fingerprint are separate records. A competing
                  // generation can advance both between these reads; retry
                  // its new lease instead of discarding a live grant.
                  const latestLease = (yield read(key)) as string | null;
                  if (latestLease !== raw) continue;
                  // Reset can sweep the old lease while its request remains live.
                  // Only storage-owned expiry can make an outstanding send ambiguous.
                  if (spent?.state === "outstanding" && ((yield read(spent.activeKey)) as string | null) === null) {
                    (yield authCall(wait, [
                      authMethod(() => {
                        return authStorage<boolean>(
                          this.storage,
                          "compareAndSet",
                          [spentKey, spentExpected, JSON.stringify({ ...spent, state: "ambiguous" })],
                          () => waiting.transfer(),
                        );
                      }),
                    ])) as boolean;
                  }
                  this.recordRefreshFailure({ kind: "dead" });
                  (yield discard()) as void;
                  throw new UnauthorizedError("OAuth refresh token was already spent; authorization required.");
                }
              }
              if (
                raw === null ||
                completed ||
                (plainObject(stored) && typeof stored.expiresAt === "number" && stored.expiresAt <= this.refreshNow())
              ) {
                // Clock skew can replace an unsent claim; its dispatch CAS then loses.
                const predecessor = completed ? stored.holder : plainObject(stored) ? stored.predecessor : undefined;
                const claimed = JSON.stringify({
                  connectaOAuthRefresh: 1,
                  holder: crypto.randomUUID(),
                  state: "claimed",
                  expiresAt: this.refreshNow() + OAUTH_REFRESH_LEASE_SECONDS * 1000,
                  ...(committed && typeof predecessor === "string" && typeof stored.tokenDigest === "string"
                    ? {
                        predecessor,
                        tokenDigest: stored.tokenDigest,
                      }
                    : {}),
                } satisfies StoredRefreshLease);
                let won: boolean;
                try {
                  won = (yield authCall(wait, [
                    authMethod(() => {
                      return authStorage<boolean>(this.storage, "compareAndSet", [key, raw, claimed], () =>
                        waiting.transfer(),
                      );
                    }),
                  ])) as boolean;
                } catch {
                  throw this.credentialWriteError();
                }
                if (won) {
                  try {
                    const latest = (yield tokens()) as OAuthTokens | undefined;
                    if (latest?.refresh_token !== requested || (latest && this.refreshedSinceRead(latest, epoch))) {
                      (yield authCall(wait, [
                        authMethod(() => {
                          return authInvoke(this, "releaseRefresh", [
                            { key, spentKey, spentExpected, raw: claimed },
                          ]) as Effect.Effect<void, unknown>;
                        }),
                      ])) as void;
                      return latest
                        ? this.adoptRefresh(latest)
                        : Response.json({ error: "invalid_grant" }, { status: 400 });
                    }
                    return { key, spentKey, spentExpected, raw: claimed };
                  } catch (error) {
                    if (!waiting.signal.aborted) {
                      (yield authCall(wait, [
                        authMethod(() => {
                          return authInvoke(this, "releaseRefresh", [
                            { key, spentKey, spentExpected, raw: claimed },
                          ]) as Effect.Effect<void, unknown>;
                        }),
                      ])) as void;
                    }
                    throw error;
                  }
                }
              }
            }
            (yield Effect.raceAllFirst([Effect.sleep(delay), fromSignal(waiting.signal)])) as void;
            delay = Math.min(REFRESH_POLL_MAX_MS, delay * 2);
          }
        } catch (error) {
          if (!waiting.signal.aborted) throw error;
        } finally {
          if (!sharedWait) waiting.close();
        }
        throw this.refreshContended();
      }.bind(this),
    );
  },
  dispatchRefresh: function (
    this: KvOAuthProvider,
    lease: RefreshLease,
    send: () => Promise<Response>,
    waiting: RefreshWait,
  ) {
    return authFlow<Response>(
      function* (this: KvOAuthProvider) {
        const stored = parsed(lease.raw) as StoredRefreshLease;
        const epoch = (yield authInvoke(waiting, "run", [
          authMethod(() => {
            return authInvoke(this, "flowEpoch", []) as Effect.Effect<string, unknown>;
          }),
        ])) as string;
        const activeKey = oauthRefreshActiveKeys.holder(epoch, stored.holder);
        (yield authInvoke(waiting, "run", [
          authMethod(() => {
            return authStorage(this.storage, "set", [
              activeKey,
              JSON.stringify({ connectaOAuthRefresh: 1 }),
              {
                ttlSeconds: OAUTH_REFRESH_LEASE_SECONDS,
              },
            ]) as Effect.Effect<void, unknown>;
          }),
        ])) as void;
        const dispatched = JSON.stringify({
          ...stored,
          state: "dispatched",
          activeKey,
        } satisfies StoredRefreshLease);
        const won = (yield authInvoke(waiting, "run", [
          authMethod(() => authStorage<boolean>(this.storage, "compareAndSet", [lease.key, lease.raw, dispatched])),
        ])) as boolean;
        if (!won) throw this.refreshContended();
        lease.raw = dispatched;
        if (waiting.signal.aborted) throw aborted(waiting.signal);
        // One CAS owns the fingerprint across epochs and generations. Only a
        // proven successful commit or later consent may replace a resolved send.
        lease.spentRaw = JSON.stringify({
          connectaOAuthRefreshSpent: 1,
          epoch,
          holder: stored.holder,
          activeKey,
          state: "outstanding",
        } satisfies StoredRefreshSpent);
        let unspent: boolean;
        try {
          unspent = (yield authInvoke(waiting, "run", [
            authMethod(() =>
              authStorage<boolean>(this.storage, "compareAndSet", [
                lease.spentKey,
                lease.spentExpected,
                lease.spentRaw,
              ]),
            ),
          ])) as boolean;
        } catch {
          this.recordRefreshFailure({ kind: "dead" });
          throw new UnauthorizedError("OAuth refresh dispatch could not be recorded; authorization required.");
        }
        if (!unspent) {
          this.recordRefreshFailure({ kind: "dead" });
          throw new UnauthorizedError("OAuth refresh token was already spent; authorization required.");
        }
        // Final owner check and physical submission share one reaction.
        // Submission already transferred ownership to the coordinator. Only
        // its own deadline can stop this send; the departed caller cannot.
        if (waiting.signal.aborted) throw aborted(waiting.signal);
        return (yield authCall<Response>(send, [])) as Response;
      }.bind(this),
    );
  },
  releaseRefresh: function (
    this: KvOAuthProvider,
    lease: RefreshLease,
    verdict?: RefreshFailure,
    tokens?: OAuthTokens,
    resolution: "resolved" | "ambiguous" = "ambiguous",
  ) {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        const stored = parsed(lease.raw) as StoredRefreshLease;
        // Unsent successors restore the prior completed proof; other unsent
        // claims may be removed. Dispatched outcomes never reopen a send.
        const next =
          stored.state === "claimed"
            ? stored.predecessor && stored.tokenDigest
              ? JSON.stringify({
                  ...stored,
                  holder: stored.predecessor,
                  state: "dispatched",
                  completed: true,
                } satisfies StoredRefreshLease)
              : null
            : JSON.stringify({
                ...stored,
                ...(tokens
                  ? {
                      completed: true as const,
                      tokenDigest: (yield authCall(refreshTokensDigest, [tokens])) as string,
                    }
                  : { verdict: { kind: "dead" } }),
              } satisfies StoredRefreshLease);
        // Verdicts contain fixed typed facts; no downstream causes or text.
        if (verdict) this.recordRefreshFailure(verdict);
        (yield authInvoke(this, "resolveRefreshSpent", [lease, resolution])) as void;
        const released = (yield authCatch(
          authStorage(this.storage, "compareAndSet", [lease.key, lease.raw, next]),
          () => false,
        )) as boolean;
        if (released && stored.activeKey)
          (yield authCatch(authStorage(this.storage, "delete", [stored.activeKey]), () => {})) as void;
      }.bind(this),
    );
  },
  resolveRefreshSpent: function (this: KvOAuthProvider, lease: RefreshLease, state: "resolved" | "ambiguous") {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        try {
          const raw = lease.spentRaw ?? ((yield authStorage(this.storage, "get", [lease.spentKey])) as string | null);
          const spent = storedRefreshSpent(raw);
          const holder = (parsed(lease.raw) as StoredRefreshLease).holder;
          if (spent?.state !== "outstanding" || spent.holder !== holder) return;
          // The timestamp belongs to this resolution write, never to dispatch.
          // Consent copies the exact stored receipt, so wall clocks grant no sends.
          (yield authStorage(this.storage, "compareAndSet", [
            lease.spentKey,
            raw,
            JSON.stringify({
              ...spent,
              state,
              ...(state === "resolved" ? { resolvedAt: Date.now() } : {}),
            }),
          ])) as boolean;
        } catch {
          // A lost resolution answer leaves outstanding or the durable outcome;
          // either blocks replay until a later consent observes a resolved write.
        }
      }.bind(this),
    );
  },
  storedTokens: function (this: KvOAuthProvider, signal: AbortSignal | null = null) {
    return authFlow<OAuthTokens | undefined>(
      function* (this: KvOAuthProvider) {
        return ((yield authInvoke(this, "boundGrant", [signal])) as Grant).body.tokens;
      }.bind(this),
    );
  },
  storeRefresh: function (
    this: KvOAuthProvider,
    epoch: string,
    requested: string | null,
    tokens: OAuthTokens,
    issuer: string | undefined,
    issuedAt: number = Date.now(),
  ) {
    return authFlow<OAuthTokens | undefined>(
      function* (this: KvOAuthProvider) {
        for (let attempt = 0; attempt < MAX_GRANT_WRITES; attempt++) {
          try {
            const { raw, grant } = (yield authInvoke(this, "readGrant", [null])) as {
              raw: string | null;
              grant: Grant;
            };
            if (grant.epoch !== epoch || (issuer !== undefined && grant.body.issuer !== issuer)) return undefined;
            if (grant.body.tokens?.refresh_token !== requested) return grant.body.tokens;
            const committed = issuer !== undefined ? { ...tokens, issuer } : tokens;
            const { expiresAt: _previous, ...body } = grant.body;
            const expiresAt = tokenExpiry(committed, issuedAt);
            const next: Grant = {
              ...grant,
              body: { ...body, tokens: committed, ...(expiresAt !== undefined ? { expiresAt } : {}) },
            };
            const encoded = (yield authInvoke(this, "encodeGrant", [next, null])) as string;
            if ((yield authStorage(this.storage, "compareAndSet", [GRANT, raw, encoded])) as boolean) {
              this.observe(next);
              return committed;
            }
          } catch {
            // A failed or lost CAS answer may still have committed. Re-read the
            // epoch and retry these in-memory tokens without another HTTP request.
          }
        }
        throw this.credentialWriteError();
      }.bind(this),
    );
  },
  discardRefusedGrant: function (
    this: KvOAuthProvider,
    refreshToken: string | null,
    epoch: string,
    beforeWrite?: () => void,
    signal?: AbortSignal,
  ) {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        try {
          (yield authInvoke(this, "updateGrant", [
            (grant: Grant) => {
              if (grant.body.tokens?.refresh_token !== refreshToken) return undefined;
              const { tokens: _refused, expiresAt: _expiry, ...body } = grant.body;
              return { ...grant, body };
            },
            {
              epoch,
              quiet: true,
              commit: true,
              ...(beforeWrite ? { beforeWrite } : {}),
              ...(signal ? { signal } : {}),
            },
          ])) as boolean;
        } catch {
          // See above: a refusal that could not be recorded recurs, it does not hide.
        }
      }.bind(this),
    );
  },
  sweepRefreshLeases: function (this: KvOAuthProvider) {
    return authFlow<void>(
      function* (this: KvOAuthProvider) {
        try {
          const records: Array<[string, string]> = [];
          // A reset may sweep an old lease while its HTTP request is still live.
          // Keep holder liveness until completion or its storage-owned TTL: spent
          // records in later epochs still use it to distinguish live from crashed.
          for (const key of (yield authStorage(this.storage, "list", [oauthRefreshKeys.prefix])) as string[]) {
            const raw = (yield authStorage(this.storage, "get", [key])) as string | null;
            if (raw !== null) records.push([key, raw]);
          }
          const live = epochOf((yield authStorage(this.storage, "get", [GRANT])) as string | null);
          for (const [key, raw] of records) {
            if (!key.startsWith(`${oauthRefreshKeys.prefix}${live}:`)) {
              (yield authStorage(this.storage, "compareAndSet", [key, raw, null])) as boolean;
            }
          }
        } catch {
          // Stale dispatch records cannot grant credentials: epochs never recur.
        }
      }.bind(this),
    );
  },
};
