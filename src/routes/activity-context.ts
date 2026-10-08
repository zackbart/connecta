import type { ActivityRequestContext } from "../activity.js";
import type { Authorized } from "./operator.js";
import type { RouteContext } from "./shared.js";

/** Attribute catalog refreshes initiated by an admitted operator request. */
export function operatorActivityContext(context: RouteContext, authz: Authorized): ActivityRequestContext | undefined {
  const { opts, defer } = context;
  const activity = opts.config.activity;
  if (!activity) return undefined;
  const principal = authz.identity.principal;
  return {
    sink: activity.store,
    recordTool: activity.recordTool,
    actor: authz.actor,
    ...(principal
      ? { principalActor: { kind: authz.actor.kind, id: principal.id, namespace: principal.namespace } }
      : {}),
    requestId: crypto.randomUUID(),
    serverInfo: opts.config.serverInfo,
    ...(activity.deploymentId ? { deploymentId: activity.deploymentId } : {}),
    ...(defer ? { defer } : {}),
    logger: opts.config.logger,
  };
}
