import { intersectAccess, type ConnectorAccess } from "../connector-access.js";
import { recordedToolName } from "../operator-record.js";
import type { RegistryView } from "../registry.js";
import type { ActivityPage } from "../activity.js";
import type { Authorized } from "./operator.js";
import type { RouteContext } from "./shared.js";

/** Historical disclosure uses the verdict at call time; old guarded rows fail closed. */
function activityToolVisible(authz: ConnectorAccess, event: ActivityPage["events"][number]): boolean {
  const allowed = authz.toolAccess?.get(event.connectorId);
  return (
    recordedToolName({ name: event.toolName }) === event.toolName &&
    (!allowed || allowed.has(event.toolName)) &&
    (!authz.guardedToolAccess?.get(event.connectorId)?.has(event.toolName) || event.classification === "read")
  );
}

/**
 * One disclosure rule for the timeline and the UI's last-call overlay.
 * After Activity access and the read gate, operators and activityAccess machine
 * callers may see other principals' shared-connector history when connector/tool
 * and recorded-pool grants permit, including request IDs, client name/version,
 * and actor kind/id/namespace. Interactive reads may add directory actor labels;
 * machine reads do not. Personal history requires a matching principal owner.
 */
export function activityEventVisible(
  context: RouteContext,
  authz: Authorized,
  registry: RegistryView,
  admittedPools: ReadonlySet<string>,
  event: ActivityPage["events"][number],
): boolean {
  const connector = registry.getConnector(event.connectorId);
  if (!connector || (event.pool !== undefined && !admittedPools.has(event.pool))) return false;
  if (connector.authScope === "personal" || (event.kind === "catalog_drift" && event.actorBasis === "principal")) {
    const owner = authz.identity.principal;
    if (
      !owner ||
      event.actorBasis !== "principal" ||
      event.actor.id !== owner.id ||
      event.actor.namespace !== owner.namespace
    )
      return false;
  }
  const pool = event.pool ? context.opts.pools.get(event.pool) : undefined;
  if (event.pool && !pool) return false;
  const access = pool ? intersectAccess(authz, pool.access) : authz;
  if (access.connectorIds !== "all" && !access.connectorIds.includes(event.connectorId)) return false;
  // Connector-wide counts reveal tools outside an address-only grant.
  if (event.kind === "catalog_drift") return !access.toolAccess?.has(event.connectorId);
  return activityToolVisible(access, event);
}
