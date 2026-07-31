// Keep this pure mapping module dependency-free so the repository's tests can
// exercise the example before the package's dist/ entrypoint has been built.
// The public adapter in d1-activity.ts remains checked against ActivityStore.
export interface ActivityEvent {
  schemaVersion: 1;
  id: string;
  occurredAt: string;
  requestId: string;
  actor: {
    kind: string;
    id?: string;
    namespace?: string;
  };
  connectorId: string;
  toolName: string;
  address: string;
  source:
    | "call_tool"
    | "call_destructive_tool"
    | "batch_call"
    | "execute_code";
  outcome: "success" | "error" | "timeout" | "cancelled";
  durationMs: number;
  attempts: number;
  errorCode?: string;
  friction?:
    | "tool_not_found"
    | "schema_retry"
    | "destructive_reroute"
    | "auth_required"
    | "result_too_large";
  serverName: string;
  serverVersion: string;
  deploymentId?: string;
}

function frictionForCode(code: string | null): ActivityEvent["friction"] {
  switch (code) {
    case "unknown_address":
    case "unknown_tool":
    case "ambiguous_tool_alias":
      return "tool_not_found";
    case "invalid_args":
      return "schema_retry";
    case "destructive_tool_requires_approval":
      return "destructive_reroute";
    case "auth_required":
      return "auth_required";
    case "result_too_large":
      return "result_too_large";
    default:
      return undefined;
  }
}

export interface ActivityRow {
  id: string;
  occurred_at_ms: number;
  request_id: string;
  actor_kind: string;
  actor_id: string | null;
  actor_namespace: string | null;
  connector_id: string;
  tool_name: string;
  source: ActivityEvent["source"];
  outcome: ActivityEvent["outcome"];
  duration_ms: number;
  attempts: number;
  error_code: string | null;
  server_name: string;
  server_version: string;
  deployment_id: string | null;
}

export function activityEventToRow(
  event: ActivityEvent,
): ActivityRow {
  return {
    id: event.id,
    occurred_at_ms: Date.parse(event.occurredAt),
    request_id: event.requestId,
    actor_kind: event.actor.kind,
    actor_id: event.actor.id ?? null,
    actor_namespace: event.actor.namespace ?? null,
    connector_id: event.connectorId,
    tool_name: event.toolName,
    source: event.source,
    outcome: event.outcome,
    duration_ms: event.durationMs,
    attempts: event.attempts,
    error_code: event.errorCode ?? null,
    server_name: event.serverName,
    server_version: event.serverVersion,
    deployment_id: event.deploymentId ?? null,
  };
}

export function activityRowToEvent(
  row: ActivityRow,
): ActivityEvent {
  const friction = frictionForCode(row.error_code);
  return {
    schemaVersion: 1,
    id: row.id,
    occurredAt: new Date(row.occurred_at_ms).toISOString(),
    requestId: row.request_id,
    actor: {
      kind: row.actor_kind,
      ...(row.actor_id ? { id: row.actor_id } : {}),
      ...(row.actor_namespace ? { namespace: row.actor_namespace } : {}),
    },
    connectorId: row.connector_id,
    toolName: row.tool_name,
    address: `${row.connector_id}.${row.tool_name}`,
    source: row.source,
    outcome: row.outcome,
    durationMs: row.duration_ms,
    attempts: row.attempts,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(friction ? { friction } : {}),
    serverName: row.server_name,
    serverVersion: row.server_version,
    ...(row.deployment_id
      ? { deploymentId: row.deployment_id }
      : {}),
  };
}
