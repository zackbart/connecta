import type { ConnectorAccess } from "../connector-access.js";
import { recordedToolName } from "../operator-record.js";
import type { RegistryView } from "../registry.js";
import type { ActivityPage } from "../activity.js";
import type { Authorized } from "./operator.js";
import type { RouteContext } from "./shared.js";

/** A recorded tool is shown only when its name passes the record grammar and its endpoint granted it. */
function activityToolVisible(access: ConnectorAccess, event: ActivityPage["events"][number]): boolean {
  const allowed = access.toolAccess?.get(event.connectorId);
  return recordedToolName({ name: event.toolName }) === event.toolName && (!allowed || allowed.has(event.toolName));
}

/**
 * One disclosure rule for the timeline and the UI's last-call overlay. Only
 * maintainers read activity, and only after the optional
 * read gate. They may see other principals' shared-connector history,
 * including request IDs, client name/version, and actor kind/id/namespace, on
 * plain /mcp and in every declared pool, within the tools that pool declares.
 * Interactive reads may add directory actor labels; machine reads do not.
 * Personal history requires a matching principal owner. A row recorded in a
 * pool that is no longer declared is withheld.
 */
export function activityEventVisible(
  context: RouteContext,
  authz: Authorized,
  registry: RegistryView,
  event: ActivityPage["events"][number],
): boolean {
  const connector = registry.getConnector(event.connectorId);
  if (!connector) return false;
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
  const pool = event.pool !== undefined ? context.opts.pools.get(event.pool) : undefined;
  if (event.pool !== undefined && !pool) return false;
  const access: ConnectorAccess = pool ? pool.access : { connectorIds: "all" };
  if (access.connectorIds !== "all" && !access.connectorIds.includes(event.connectorId)) return false;
  // Connector-wide counts reveal tools outside an address-only grant.
  if (event.kind === "catalog_drift") return !access.toolAccess?.has(event.connectorId);
  return activityToolVisible(access, event);
}
