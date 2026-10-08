import { isSpecType, type PriorDiscovery } from "@modelcontextprotocol/client";
import { failureRecord, logFailure } from "../operator-record.js";
import { sentSecretsForRequest } from "../sent-secrets.js";
import { negotiationKeys, NEGOTIATION_TTL_SECONDS } from "../storage/keys.js";
import type { ConnectorContext } from "../types.js";

/** Verdicts carry data only. Clients, signals and secrets remain request-local. */
export async function readNegotiation(ctx: ConnectorContext, digest: string): Promise<PriorDiscovery | undefined> {
  try {
    const raw = await ctx.storage.get(negotiationKeys.verdict(digest));
    if (!raw) return;
    const value = JSON.parse(raw);
    if (!Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) return;
    const prior = value.prior;
    if (prior?.kind === "legacy" && Object.keys(prior).length === 1) return prior;
    if (prior?.kind === "modern" && isSpecType.DiscoverResult(prior.discover)) return prior;
  } catch (error) {
    logFailure(ctx.logger, "negotiation cache read failed", failureRecord({}, error));
  }
}

export async function storeNegotiation(ctx: ConnectorContext, digest: string, prior: PriorDiscovery): Promise<void> {
  if (ctx.signal?.aborted) return;
  // DiscoverResult instructions, metadata and capability keys can echo auth.
  const clean = sentSecretsForRequest(ctx.requestScope ?? ctx).redact(prior);
  if (clean.kind === "modern" && !isSpecType.DiscoverResult(clean.discover)) return;
  try {
    await ctx.storage.set(negotiationKeys.verdict(digest), JSON.stringify({
      prior: clean,
      expiresAt: Date.now() + NEGOTIATION_TTL_SECONDS * 1000,
    }), { ttlSeconds: NEGOTIATION_TTL_SECONDS });
  } catch (error) {
    logFailure(ctx.logger, "negotiation cache write failed", failureRecord({}, error));
  }
}
