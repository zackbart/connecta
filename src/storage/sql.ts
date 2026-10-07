// One SQL key-value store and one SQL activity store, over two drivers.
//
// D1 (`src/d1.ts`) and Node's built-in SQLite (`src/sqlite.ts`) speak the same
// SQLite dialect, so every statement here runs unchanged on both. A driver is
// three methods; nothing in this module knows which one it has. It imports no
// platform module, so the Worker subpath can carry it.
//
// Atomicity. Every compare-and-set is one statement. SQLite executes a
// statement atomically against the database file, and D1 runs one database's
// statements one at a time against its primary, so a comparison and its write
// cannot interleave with another request's: of fifty concurrent claims on an
// absent key, exactly one changes a row.
//
// Expiry is judged by the caller's clock at each call, the same `Date.now()`
// the core uses. An expired row reads as absent at once and is removed
// physically by later writes, a bounded batch at a time, so no request starts
// a background job and no cron is required.
//
// Schema. Each store creates its own tables and indexes the first time one of
// its methods runs in an isolate or process, with idempotent statements, so a
// deployment applies no migration by hand. The flag that records it is a
// boolean, never a shared promise: a request that sees it unset runs the
// statements itself (INV-7).

import type {
  ActivityPage,
  ActivityStore,
  ToolCallActivityEvent,
} from "../activity.js";
import { InvalidActivityCursorError } from "../activity.js";
import { agentFrictionForCode } from "../activity-friction.js";
import type { KVStorage } from "../types.js";

type SqlValue = string | number | null;

export interface SqlStatement {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

/** What a store needs from a SQLite-dialect database. */
export interface SqlDriver {
  /** Rows a query returns. */
  all<Row>(statement: SqlStatement): Promise<Row[]>;
  /** Run one write; resolve with the number of rows it changed. */
  run(statement: SqlStatement): Promise<number>;
  /** Run writes in order as one transaction. */
  batch(statements: readonly SqlStatement[]): Promise<void>;
}

const sql = (text: string, ...params: SqlValue[]): SqlStatement => ({
  sql: text,
  params,
});

/** Run `ddl` once per store object; a failure leaves it to the next call. */
function schemaOnce(
  driver: SqlDriver,
  ddl: (driver: SqlDriver) => Promise<void>,
): () => Promise<void> {
  let ready = false;
  return async () => {
    if (ready) return;
    await ddl(driver);
    ready = true;
  };
}

// --- key-value ----------------------------------------------------------

/**
 * The key-value table. Its shape is the one the 0.28 Worker example's
 * `d1-storage.ts` documented, so a D1 database that already holds it is read
 * as is.
 */
export const KV_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS connecta_kv (
    key           TEXT PRIMARY KEY,
    value         TEXT NOT NULL,
    expires_at_ms INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS connecta_kv_expiry
    ON connecta_kv (expires_at_ms)`,
];

/** Expired rows one write removes on its way. */
const SWEEP_ROWS = 16;

function expiresAt(now: number, ttlSeconds?: number): number | null {
  if (ttlSeconds !== undefined && !Number.isFinite(ttlSeconds)) {
    throw new RangeError("ttlSeconds must produce a finite expiration timestamp");
  }
  if (!ttlSeconds) return null;
  const expiry = now + ttlSeconds * 1000;
  if (!Number.isFinite(expiry)) {
    throw new RangeError("ttlSeconds must produce a finite expiration timestamp");
  }
  return Math.ceil(expiry);
}

/** `KVStorage` over one `connecta_kv` table. */
export function sqlStorage(driver: SqlDriver): KVStorage {
  const ensure = schemaOnce(driver, (d) =>
    d.batch(KV_SCHEMA.map((statement) => sql(statement))),
  );
  // Every statement that tests liveness binds the current time as ?2.
  const live = "(expires_at_ms IS NULL OR expires_at_ms > ?2)";
  const current = async (key: string, now: number) =>
    (await driver.all<{ value: string }>(
      sql(`SELECT value FROM connecta_kv WHERE key = ?1 AND ${live}`, key, now),
    ))[0]?.value ?? null;
  return {
    async get(key) {
      await ensure();
      return current(key, Date.now());
    },
    async set(key, value, opts) {
      await ensure();
      const now = Date.now();
      const expiry = expiresAt(now, opts?.ttlSeconds);
      await driver.batch([
        sql(
          `DELETE FROM connecta_kv WHERE key IN (
            SELECT key FROM connecta_kv WHERE expires_at_ms <= ?1 LIMIT ${SWEEP_ROWS}
          )`,
          now,
        ),
        sql(
          `INSERT INTO connecta_kv (key, value, expires_at_ms)
           VALUES (?1, ?2, ?3)
           ON CONFLICT (key) DO UPDATE SET
             value = excluded.value, expires_at_ms = excluded.expires_at_ms`,
          key,
          value,
          expiry,
        ),
      ]);
    },
    async delete(key) {
      await ensure();
      await driver.run(sql("DELETE FROM connecta_kv WHERE key = ?1", key));
    },
    async list(prefix) {
      await ensure();
      const rows = await driver.all<{ key: string }>(
        sql(
          `SELECT key FROM connecta_kv
           WHERE key >= ?1
             AND substr(CAST(key AS BLOB), 1, length(CAST(?1 AS BLOB))) = CAST(?1 AS BLOB)
             AND ${live}`,
          prefix,
          Date.now(),
        ),
      );
      // Sort in JavaScript: SQLite orders UTF-8 bytes, the contract orders
      // the UTF-16 code units every other adapter sorts by.
      return rows.map((row) => row.key).sort();
    },
    async compareAndSet(key, expected, next, opts) {
      await ensure();
      const now = Date.now();
      if (next === null && expected === null) {
        // Nothing to write; the claim holds exactly when no live row exists.
        return (await current(key, now)) === null;
      }
      if (next === null) {
        return (await driver.run(sql(
          `DELETE FROM connecta_kv WHERE key = ?1 AND ${live} AND value = ?3`,
          key,
          now,
          expected,
        ))) > 0;
      }
      let expiry: number | null;
      try {
        expiry = expiresAt(now, opts?.ttlSeconds);
      } catch (error) {
        // Invalid write options do not change a failed comparison's result.
        // Ordinary claims still use one atomic statement without this read.
        if ((await current(key, now)) !== expected) return false;
        throw error;
      }
      if (expected === null) {
        // Insert, or take over a row that has expired. A live row makes the
        // upsert's WHERE false, so nothing changes and the claim is refused.
        return (await driver.run(sql(
          `INSERT INTO connecta_kv (key, value, expires_at_ms)
           VALUES (?1, ?3, ?4)
           ON CONFLICT (key) DO UPDATE SET
             value = excluded.value, expires_at_ms = excluded.expires_at_ms
           WHERE connecta_kv.expires_at_ms IS NOT NULL
             AND connecta_kv.expires_at_ms <= ?2`,
          key,
          now,
          next,
          expiry,
        ))) > 0;
      }
      return (await driver.run(sql(
        `UPDATE connecta_kv SET value = ?4, expires_at_ms = ?5
         WHERE key = ?1 AND ${live} AND value = ?3`,
        key,
        now,
        expected,
        next,
        expiry,
      ))) > 0;
    },
  };
}

// --- activity -----------------------------------------------------------

/**
 * The activity table, with keyset paging on `(occurred_at_ms, id)`. Its shape
 * is the 0.28 Worker example's `tool_call_activity`; a table created before
 * `actor_namespace`, `friction`, or `approval` existed gets them added.
 */
const ACTIVITY_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tool_call_activity (
    id              TEXT PRIMARY KEY,
    occurred_at_ms  INTEGER NOT NULL,
    request_id      TEXT NOT NULL,
    actor_kind      TEXT NOT NULL,
    actor_id        TEXT,
    actor_namespace TEXT,
    connector_id    TEXT NOT NULL,
    tool_name       TEXT NOT NULL,
    source          TEXT NOT NULL,
    outcome         TEXT NOT NULL,
    duration_ms     INTEGER NOT NULL,
    attempts        INTEGER NOT NULL,
    error_code      TEXT,
    friction        TEXT,
    approval        TEXT,
    server_name     TEXT NOT NULL,
    server_version  TEXT NOT NULL,
    deployment_id   TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS tool_call_activity_recent
    ON tool_call_activity (occurred_at_ms DESC, id DESC)`,
];

/** Columns added after the table first shipped, in the order they arrived. */
const LATER_ACTIVITY_COLUMNS = ["actor_namespace", "friction", "approval"];

interface ActivityRow {
  id: string;
  occurred_at_ms: number;
  request_id: string;
  actor_kind: string;
  actor_id: string | null;
  actor_namespace: string | null;
  connector_id: string;
  tool_name: string;
  source: ToolCallActivityEvent["source"];
  outcome: ToolCallActivityEvent["outcome"];
  duration_ms: number;
  attempts: number;
  error_code: string | null;
  friction: ToolCallActivityEvent["friction"] | null;
  /** Null on every row since 0.28.0; history for `approved` rows before it. */
  approval: ToolCallActivityEvent["approval"] | null;
  server_name: string;
  server_version: string;
  deployment_id: string | null;
}

function rowToEvent(row: ActivityRow): ToolCallActivityEvent {
  // Rows written before `friction` had a column derive it from the code.
  // Friction without a code — an oversized but successful result — exists
  // only in the column, which is why the column exists.
  const friction = row.friction ??
    agentFrictionForCode(row.error_code ?? undefined);
  return {
    schemaVersion: 1,
    id: row.id,
    occurredAt: new Date(row.occurred_at_ms).toISOString(),
    requestId: row.request_id,
    actor: {
      kind: row.actor_kind as ToolCallActivityEvent["actor"]["kind"],
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
    ...(row.approval ? { approval: row.approval } : {}),
    serverName: row.server_name,
    serverVersion: row.server_version,
    ...(row.deployment_id ? { deploymentId: row.deployment_id } : {}),
  };
}

function encodeCursor(row: ActivityRow): string {
  return btoa(`${row.occurred_at_ms}:${row.id}`);
}

function decodeCursor(value: string): { occurredAtMs: number; id: string } {
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

export interface SqlActivityOptions {
  /**
   * Days of history kept. Each write removes a bounded batch of older rows,
   * so the table stays near this window without a scheduled job. Default 90.
   */
  retentionDays?: number;
}

/** Older rows one write removes on its way. Above one: writes catch up. */
const RETENTION_SWEEP_ROWS = 16;

/**
 * One append-only row per completed downstream call. Rows carry no arguments,
 * results, generated code, or raw error messages — the store never has a
 * payload to leak.
 */
export function sqlActivityStore(
  driver: SqlDriver,
  options: SqlActivityOptions = {},
): ActivityStore {
  const retentionDays = options.retentionDays ?? 90;
  if (!(retentionDays > 0) || !Number.isFinite(retentionDays)) {
    throw new TypeError("activity retentionDays must be a positive number");
  }
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const ensure = schemaOnce(driver, async (d) => {
    await d.batch(ACTIVITY_SCHEMA.map((statement) => sql(statement)));
    const columns = new Set(
      (await d.all<{ name: string }>(sql("PRAGMA table_info(tool_call_activity)")))
        .map((column) => column.name),
    );
    const missing = LATER_ACTIVITY_COLUMNS.filter((name) => !columns.has(name));
    if (missing.length > 0) {
      await d.batch(missing.map((name) =>
        sql(`ALTER TABLE tool_call_activity ADD COLUMN ${name} TEXT`),
      ));
    }
  });
  return {
    async record(event) {
      await ensure();
      const occurredAtMs = Date.parse(event.occurredAt);
      await driver.batch([
        sql(
          `INSERT INTO tool_call_activity (
            id, occurred_at_ms, request_id, actor_kind, actor_id,
            actor_namespace, connector_id, tool_name, source, outcome,
            duration_ms, attempts, error_code, friction, approval,
            server_name, server_version, deployment_id
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
          event.id,
          occurredAtMs,
          event.requestId,
          event.actor.kind,
          event.actor.id ?? null,
          event.actor.namespace ?? null,
          event.connectorId,
          event.toolName,
          event.source,
          event.outcome,
          event.durationMs,
          event.attempts,
          event.errorCode ?? null,
          // Stored beside the code rather than derived from it: a truncated
          // result is friction on a call that succeeded, and
          // `error_code IS NOT NULL` stays an honest count of failures.
          event.friction ?? null,
          event.approval ?? null,
          event.serverName,
          event.serverVersion,
          event.deploymentId ?? null,
        ),
        sql(
          `DELETE FROM tool_call_activity WHERE id IN (
            SELECT id FROM tool_call_activity
            WHERE occurred_at_ms < ?1
            ORDER BY occurred_at_ms ASC
            LIMIT ${RETENTION_SWEEP_ROWS}
          )`,
          Date.now() - retentionMs,
        ),
      ]);
    },

    async list({ cursor, limit }): Promise<ActivityPage> {
      const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
      const pageSize = boundedLimit + 1;
      const position = cursor ? decodeCursor(cursor) : undefined;
      await ensure();
      const rows = await driver.all<ActivityRow>(position
        ? sql(
            `SELECT * FROM tool_call_activity
             WHERE occurred_at_ms < ?1
                OR (occurred_at_ms = ?1 AND id < ?2)
             ORDER BY occurred_at_ms DESC, id DESC
             LIMIT ?3`,
            position.occurredAtMs,
            position.id,
            pageSize,
          )
        : sql(
            `SELECT * FROM tool_call_activity
             ORDER BY occurred_at_ms DESC, id DESC
             LIMIT ?1`,
            pageSize,
          ));
      const hasMore = rows.length > boundedLimit;
      const visible = hasMore ? rows.slice(0, boundedLimit) : rows;
      const last = visible.at(-1);
      return {
        events: visible.map(rowToEvent),
        ...(hasMore && last ? { nextCursor: encodeCursor(last) } : {}),
      };
    },
  };
}
