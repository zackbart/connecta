import type {
  ActivityPage,
  ActivityStore,
  ToolCallActivityEvent,
} from "@zackbart/connecta";
import { InvalidActivityCursorError } from "@zackbart/connecta";

interface ActivityRow {
  id: string;
  occurred_at_ms: number;
  request_id: string;
  actor_kind: string;
  actor_id: string | null;
  connector_id: string;
  tool_name: string;
  source: ToolCallActivityEvent["source"];
  outcome: ToolCallActivityEvent["outcome"];
  duration_ms: number;
  attempts: number;
  error_code: string | null;
  server_name: string;
  server_version: string;
  deployment_id: string | null;
}

interface Cursor {
  occurredAtMs: number;
  id: string;
}

function encodeCursor(row: ActivityRow): string {
  return btoa(`${row.occurred_at_ms}:${row.id}`);
}

function decodeCursor(value: string): Cursor {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new InvalidActivityCursorError();
  }
  const separator = decoded.indexOf(":");
  const occurredAtMs = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (
    separator < 1 ||
    !Number.isSafeInteger(occurredAtMs) ||
    occurredAtMs < 0 ||
    !/^[0-9a-f-]{36}$/i.test(id)
  ) {
    throw new InvalidActivityCursorError();
  }
  return { occurredAtMs, id };
}

function toEvent(row: ActivityRow): ToolCallActivityEvent {
  return {
    schemaVersion: 1,
    id: row.id,
    occurredAt: new Date(row.occurred_at_ms).toISOString(),
    requestId: row.request_id,
    actor: {
      kind: row.actor_kind,
      ...(row.actor_id ? { id: row.actor_id } : {}),
    },
    connectorId: row.connector_id,
    toolName: row.tool_name,
    address: `${row.connector_id}.${row.tool_name}`,
    source: row.source,
    outcome: row.outcome,
    durationMs: row.duration_ms,
    attempts: row.attempts,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    serverName: row.server_name,
    serverVersion: row.server_version,
    ...(row.deployment_id
      ? { deploymentId: row.deployment_id }
      : {}),
  };
}

/** One append-only row per completed downstream call; no arguments or results. */
export function d1ActivityStore(db: D1Database): ActivityStore {
  return {
    async record(event) {
      await db
        .prepare(
          `INSERT INTO tool_call_activity (
            id, occurred_at_ms, request_id, actor_kind, actor_id,
            connector_id, tool_name, source, outcome, duration_ms, attempts,
            error_code, server_name, server_version, deployment_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          event.id,
          Date.parse(event.occurredAt),
          event.requestId,
          event.actor.kind,
          event.actor.id ?? null,
          event.connectorId,
          event.toolName,
          event.source,
          event.outcome,
          event.durationMs,
          event.attempts,
          event.errorCode ?? null,
          event.serverName,
          event.serverVersion,
          event.deploymentId ?? null,
        )
        .run();
    },

    async list({ cursor, limit }): Promise<ActivityPage> {
      const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
      const pageSize = boundedLimit + 1;
      const position = cursor ? decodeCursor(cursor) : undefined;
      const statement = position
        ? db
            .prepare(
              `SELECT * FROM tool_call_activity
               WHERE occurred_at_ms < ?
                  OR (occurred_at_ms = ? AND id < ?)
               ORDER BY occurred_at_ms DESC, id DESC
               LIMIT ?`,
            )
            .bind(
              position.occurredAtMs,
              position.occurredAtMs,
              position.id,
              pageSize,
            )
        : db
            .prepare(
              `SELECT * FROM tool_call_activity
               ORDER BY occurred_at_ms DESC, id DESC
               LIMIT ?`,
            )
            .bind(pageSize);
      const result = await statement.all<ActivityRow>();
      const rows = result.results ?? [];
      const hasMore = rows.length > boundedLimit;
      const visible = hasMore ? rows.slice(0, boundedLimit) : rows;
      const last = visible.at(-1);
      return {
        events: visible.map(toEvent),
        ...(hasMore && last ? { nextCursor: encodeCursor(last) } : {}),
      };
    },
  };
}

/**
 * Daily retention pass. Each statement is capped at 5,000 rows, then repeats
 * up to a per-run ceiling so normal traffic catches up without allowing one
 * scheduled invocation to consume unbounded queries.
 */
export async function pruneActivity(
  db: D1Database,
  retentionDays: number,
  maxBatches = 20,
): Promise<void> {
  const cutoff = Date.now() -
    Math.max(1, Math.trunc(retentionDays)) * 24 * 60 * 60 * 1_000;
  const batchLimit = Math.max(1, Math.trunc(maxBatches));
  for (let batch = 0; batch < batchLimit; batch++) {
    const result = await db
      .prepare(
        `DELETE FROM tool_call_activity
         WHERE id IN (
           SELECT id FROM tool_call_activity
           WHERE occurred_at_ms < ?
           ORDER BY occurred_at_ms ASC
           LIMIT 5000
         )`,
      )
      .bind(cutoff)
      .run();
    if ((result.meta.changes ?? 0) < 5_000) return;
  }
}
