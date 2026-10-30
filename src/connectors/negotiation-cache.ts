import type { Effect } from "effect";
import { runEdge } from "../runtime/run.js";

import { authFlow, authProgram, registerAuth, authStorage } from "../auth/native.js";
import { isSpecType, type PriorDiscovery } from "@modelcontextprotocol/client";
import { failureRecord, logFailure } from "../operator-record.js";
import { sentSecretsForRequest } from "../sent-secrets.js";
import { assertDownstreamOutputSafe } from "../downstream-input-context.js";
import { LEGACY_NEGOTIATION_TTL_SECONDS, negotiationKeys, NEGOTIATION_TTL_SECONDS } from "../storage/keys.js";
import { viewReads } from "../runtime/call.js";
import type { ConnectorContext } from "../types.js";

/** Verdicts carry data only. Clients, signals and secrets remain request-local. */
export function readNegotiation(ctx: ConnectorContext, digest: string): Promise<PriorDiscovery | undefined> {
  return runEdge(authProgram<PriorDiscovery | undefined>(readNegotiationNative, [ctx, digest]));
}
const readNegotiationNative = /* @__PURE__ */ registerAuth(readNegotiation, (ctx: ConnectorContext, digest: string) =>
  authFlow<PriorDiscovery | undefined>(function* () {
    let prior: PriorDiscovery | undefined;
    try {
      // Memoized per request: a verdict only orders the versions a handshake
      // tries, so one read earlier in this request at worst costs a fallback.
      // This request's own storeNegotiation is a write, which clears the memo.
      const key = negotiationKeys.verdict(digest);
      const raw = (yield viewReads(ctx).read(
        ctx.storage,
        key,
        authStorage(ctx.storage, "get", [key]) as Effect.Effect<string | null, unknown>,
      )) as string | null;
      if (!raw) return;
      const value = JSON.parse(raw);
      if (!Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) return;
      const candidate = value.prior;
      if (
        (candidate?.kind === "legacy" && Object.keys(candidate).length === 1) ||
        (candidate?.kind === "modern" && isSpecType.DiscoverResult(candidate.discover))
      )
        prior = candidate;
    } catch (error) {
      logFailure(ctx.logger, "negotiation cache read failed", failureRecord({}, error));
    }
    if (prior) assertDownstreamOutputSafe(ctx.requestScope ?? ctx, prior);
    return prior;
  }),
);

export function storeNegotiation(ctx: ConnectorContext, digest: string, prior: PriorDiscovery): Promise<void> {
  return runEdge(authProgram<void>(storeNegotiationNative, [ctx, digest, prior]));
}
const storeNegotiationNative = /* @__PURE__ */ registerAuth(
  storeNegotiation,
  (ctx: ConnectorContext, digest: string, prior: PriorDiscovery) =>
    authFlow<void>(function* () {
      if (ctx.signal?.aborted) return;
      assertDownstreamOutputSafe(ctx.requestScope ?? ctx, prior);
      const clean = sentSecretsForRequest(ctx.requestScope ?? ctx).redactCredentials(prior);
      if (clean.kind === "modern" && !isSpecType.DiscoverResult(clean.discover)) return;
      const ttlSeconds = clean.kind === "legacy" ? LEGACY_NEGOTIATION_TTL_SECONDS : NEGOTIATION_TTL_SECONDS;
      try {
        (yield authStorage(ctx.storage, "set", [
          negotiationKeys.verdict(digest),
          JSON.stringify({
            prior: clean,
            expiresAt: Date.now() + ttlSeconds * 1000,
          }),
          { ttlSeconds },
        ])) as void;
      } catch (error) {
        logFailure(ctx.logger, "negotiation cache write failed", failureRecord({}, error));
      }
    }),
);

/** Drop a verdict the downstream has contradicted, so the next connect negotiates. */
export function forgetNegotiation(ctx: ConnectorContext, digest: string): Promise<void> {
  return runEdge(authProgram<void>(forgetNegotiationNative, [ctx, digest]));
}
const forgetNegotiationNative = /* @__PURE__ */ registerAuth(
  forgetNegotiation,
  (ctx: ConnectorContext, digest: string) =>
    authFlow<void>(function* () {
      try {
        (yield authStorage(ctx.storage, "delete", [negotiationKeys.verdict(digest)])) as void;
      } catch (error) {
        logFailure(ctx.logger, "negotiation cache write failed", failureRecord({}, error));
      }
    }),
);
