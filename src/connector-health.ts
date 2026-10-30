// Where one connector's bounded health facts are stored for a registry view:
// the catalog cache's store and owner partition (principal, subject, caller
// identity and pool, origin) and the admitted endpoint, digested with the
// connector's value-free described configuration and the package version, beside the catalog invalidation
// generation those facts must match (INV-4, INV-5). Shared by discovery health
// and the operator page's status observations.
import { Effect } from "effect";
import { sha256Hex } from "./bytes.js";
import { catalogOwnerPartition } from "./catalog-policy.js";
import { canonicalJson } from "./canonical-json.js";
import type { RegistryView } from "./registry.js";
import { responseCacheKeys } from "./storage/keys.js";
import type { Connector, KVStorage, Logger } from "./types.js";
import { CONNECTA_VERSION } from "./version.js";

// A connector's described configuration, digested once per connector object.
// `describe()` is value-free: no header value, URL query or other secret
// enters it, so the key this digest joins is no verifier for one. A change it
// cannot see, such as a static header rotated in deployment code, takes effect
// on redeploy and leaves an earlier record to lapse within its TTL.
const configDigests = new WeakMap<Connector, Promise<string>>();
function configDigest(connector: Connector): Promise<string> {
  let digest = configDigests.get(connector);
  if (!digest) {
    let described: unknown = null;
    try {
      described = connector.describe?.() ?? null;
    } catch {
      described = null;
    }
    digest = sha256Hex(
      canonicalJson([CONNECTA_VERSION, connector.kind ?? null, connector.authScope ?? null, described]),
    );
    configDigests.set(connector, digest);
  }
  return digest;
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
      digest: await sha256Hex(
        JSON.stringify([partition, endpoints.get(requestScope) ?? null, await configDigest(connector)]),
      ),
      generationKey: responseCacheKeys.generation(id),
      logger: ctx.logger,
    }));
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
}
