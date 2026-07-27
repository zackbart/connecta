import type {
  ActivityPage,
  ActivityStore,
} from "@zackbart/connecta";
import { InvalidActivityCursorError } from "@zackbart/connecta";
import {
  activityEventToRow,
  activityRowToEvent,
  type ActivityRow,
} from "./d1-activity-row.js";

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

/** One append-only row per completed downstream call; no arguments or results. */
export function d1ActivityStore(db: D1Database): ActivityStore {
  return {
    async record(event) {
      const row = activityEventToRow(event);
      await db
        .prepare(
          `INSERT INTO tool_call_activity (
            id, occurred_at_ms, request_id, actor_kind, actor_id,
            actor_namespace,
            connector_id, tool_name, source, outcome, duration_ms, attempts,
            error_code, server_name, server_version, deployment_id, toolkit_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.occurred_at_ms,
          row.request_id,
          row.actor_kind,
          row.actor_id,
          row.actor_namespace,
          row.connector_id,
          row.tool_name,
          row.source,
          row.outcome,
          row.duration_ms,
          row.attempts,
          row.error_code,
          row.server_name,
          row.server_version,
          row.deployment_id,
          row.toolkit_id,
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
        events: visible.map(activityRowToEvent),
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
