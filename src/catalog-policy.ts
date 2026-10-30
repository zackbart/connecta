// The catalog cache's per-view policy: its store, owner partition and TTL
// bounds, attached to each connector context by the registry. Kept apart from
// the cache itself so bounded facts stored beside it (connector health, the
// operator page's status observations) reach the partition without the MCP
// client the cache adapter imports.
import { Context } from "effect";
import type { CompletedCatalogRefresh } from "./catalog-cache.js";
import { callerOf } from "./connector-caller.js";
import { serviceFor } from "./runtime/call.js";
import type { ConnectorContext, KVStorage } from "./types.js";

export interface CatalogCacheSettings {
  storage: KVStorage;
  partition: string;
  credentialRevision?: () => number;
  sharedPartition?: string;
  defaultTtlMs: number;
  minTtlMs: number;
  maxTtlMs: number;
  onCompletedCatalogRefresh?: (refresh: CompletedCatalogRefresh, ctx: ConnectorContext) => void | Promise<void>;
}

export class CatalogPolicy extends Context.Service<CatalogPolicy, CatalogCacheSettings>()(
  "connecta/operation/CatalogPolicy",
) {}

/** The store and owner partition this connector's catalog cache uses, for bounded facts kept beside it. */
export function catalogOwnerPartition(ctx: ConnectorContext): { storage: KVStorage; partition: string } {
  const policy = serviceFor(ctx, CatalogPolicy);
  return {
    storage: policy?.storage ?? ctx.storage,
    partition: JSON.stringify([policy?.partition ?? JSON.stringify(callerOf(ctx) ?? null), ctx.baseUrl, ctx.publicUrl]),
  };
}
