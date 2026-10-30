// Where one connector's bounded health facts are stored for a registry view:
// the catalog cache's store and owner partition (principal, subject, caller
// identity and pool, origin) and the admitted endpoint, with the connector's
// described configuration and the package version, through the deployment's
// keyed digest (a described endpoint keeps its path), beside the catalog
// invalidation generation those facts must match (INV-4, INV-5). Shared by
// discovery health and the operator page's status observations.
import { Effect } from "effect";
import { catalogOwnerPartition } from "./catalog-policy.js";
import { canonicalJson } from "./canonical-json.js";
import type { RegistryView } from "./registry.js";
import { secretDigest } from "./storage-digest.js";
import { responseCacheKeys } from "./storage/keys.js";
import type { Connector, KVStorage, Logger } from "./types.js";
import { CONNECTA_VERSION } from "./version.js";

// A connector's described configuration, serialized once per connector object.
// A change `describe()` cannot see, such as a static header rotated in
// deployment code, takes effect on redeploy and leaves an earlier record to
// lapse within its TTL.
const configs = new WeakMap<Connector, string>();
function describedConfig(connector: Connector): string {
  let config = configs.get(connector);
  if (config === undefined) {
    let described: unknown = null;
    try {
      described = connector.describe?.() ?? null;
    } catch {
      described = null;
    }
    config = canonicalJson([CONNECTA_VERSION, connector.kind ?? null, connector.authScope ?? null, described]);
    configs.set(connector, config);
  }
  return config;
}

// The endpoint a request was admitted at (plain `/mcp`, a pool, an agent
// path). The same person and pool can reach one connector through several,
// and each keeps its own records. The operator page binds none.
const endpoints = new WeakMap<object, string>();
/** Bind the admitted endpoint to a request scope, before any discovery runs in it. */
export function bindDiscoveryEndpoint(requestScope: object, endpoint: string): void {
  endpoints.set(requestScope, endpoint);
}

export interface HealthAddress {
  storage: KVStorage;
  digest: string;
  generationKey: string;
  logger: Logger;
}

/** Where one connector's records sit in this view's owner partition. */
export function healthAddress(
  registry: RegistryView,
  id: string,
  baseUrl: string,
  requestScope: object,
): Effect.Effect<HealthAddress | undefined> {
  return Effect.suspend(() => {
    const connector = registry.getConnector(id);
    if (!connector) return Effect.succeed(undefined);
    const ctx = registry.contextFor(id, baseUrl, requestScope);
    const { storage, partition } = catalogOwnerPartition(ctx);
    if (!storage) return Effect.succeed(undefined);
    return Effect.promise(async () => ({
      storage,
      digest: await secretDigest(
        ctx,
        JSON.stringify([partition, endpoints.get(requestScope) ?? null, describedConfig(connector)]),
      ),
      generationKey: responseCacheKeys.generation(id),
      logger: ctx.logger,
    }));
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
}
