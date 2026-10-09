import { isSpecType, type PriorDiscovery } from "@modelcontextprotocol/client";
import { failureRecord, logFailure } from "../operator-record.js";
import { sentSecretsForRequest } from "../sent-secrets.js";
import { assertDownstreamOutputSafe } from "../downstream-input-context.js";
import { negotiationKeys, NEGOTIATION_TTL_SECONDS } from "../storage/keys.js";
import type { ConnectorContext } from "../types.js";

/** Verdicts carry data only. Clients, signals and secrets remain request-local. */
export async function readNegotiation(ctx: ConnectorContext, digest: string): Promise<PriorDiscovery | undefined> {
  let prior: PriorDiscovery | undefined;
  try {
    const raw = await ctx.storage.get(negotiationKeys.verdict(digest));
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
  // Privacy refusals are not cache misses and must not enter cache diagnostics.
  if (prior) assertDownstreamOutputSafe(ctx.requestScope ?? ctx, prior);
  return prior;
}

export async function storeNegotiation(ctx: ConnectorContext, digest: string, prior: PriorDiscovery): Promise<void> {
  if (ctx.signal?.aborted) return;
  assertDownstreamOutputSafe(ctx.requestScope ?? ctx, prior);
  // DiscoverResult instructions, metadata and capability keys can echo auth.
  const clean = sentSecretsForRequest(ctx.requestScope ?? ctx).redactCredentials(prior);
  if (clean.kind === "modern" && !isSpecType.DiscoverResult(clean.discover)) return;
  try {
    await ctx.storage.set(
      negotiationKeys.verdict(digest),
      JSON.stringify({
        prior: clean,
        expiresAt: Date.now() + NEGOTIATION_TTL_SECONDS * 1000,
      }),
      { ttlSeconds: NEGOTIATION_TTL_SECONDS },
    );
  } catch (error) {
    logFailure(ctx.logger, "negotiation cache write failed", failureRecord({}, error));
  }
}
