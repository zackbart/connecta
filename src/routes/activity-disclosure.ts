import { intersectAccess, type ConnectorAccess } from "../connector-access.js";
import { recordedToolName } from "../operator-record.js";
import type { RegistryView } from "../registry.js";
import type { ActivityPage } from "../activity.js";
import type { Authorized } from "./operator.js";
import type { RouteContext } from "./shared.js";

/** Historical disclosure uses the verdict at call time; old guarded rows fail closed. */
function activityToolVisible(authz: ConnectorAccess, event: ActivityPage["events"][number]): boolean {
  const allowed = authz.toolAccess?.get(event.connectorId);
  return recordedToolName({ name: event.toolName }) === event.toolName && (!allowed || allowed.has(event.toolName)) &&
    (!authz.guardedToolAccess?.get(event.connectorId)?.has(event.toolName) || event.classification === "read");
}

/** One disclosure rule for the timeline and the UI's last-call overlay. */
export function activityEventVisible(
  context: RouteContext,
  authz: Authorized,
  registry: RegistryView,
  admittedPools: ReadonlySet<string>,
  event: ActivityPage["events"][number],
): boolean {
  const connector = registry.getConnector(event.connectorId);
  if (!connector || event.pool !== undefined && !admittedPools.has(event.pool)) return false;
  if (connector.authScope === "personal" && (!event.actor.id || !authz.actor.id || event.actor.kind !== authz.actor.kind || event.actor.id !== authz.actor.id || event.actor.namespace !== authz.actor.namespace)) return false;
  const pool = event.pool ? context.opts.pools.get(event.pool) : undefined;
  if (event.pool && !pool) return false;
  const access = pool ? intersectAccess(authz, pool.access) : authz;
  if (access.connectorIds !== "all" && !access.connectorIds.includes(event.connectorId)) return false;
  // Connector-wide counts reveal tools outside an address-only grant.
  if (event.kind === "catalog_drift") return !access.toolAccess?.has(event.connectorId);
  return activityToolVisible(access, event);
}

