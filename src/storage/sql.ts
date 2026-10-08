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
// The database clock creates and checks KV expiry inside each statement.
// Isolate clock skew cannot shorten another holder's TTL. An expired row reads
// as absent at once and is removed
// physically by later writes, a bounded batch at a time, so no request starts
// a background job and no cron is required.
//
// Schema. Each store creates its own tables and indexes the first time one of
// its methods runs in an isolate or process, with idempotent statements, so a
// deployment applies no migration by hand. The flag that records it is a
// boolean, never a shared promise: a request that sees it unset runs the
// statements itself (INV-7).

import type { ActivityPage, ActivityStore, ToolCallActivityEvent } from "../activity.js";
import {
  activityBehaviorFacts,
  activityPackageVersion,
  activityClientFact,
  InvalidActivityCursorError,
} from "../activity.js";
import { assertKnownOptions, ConfigError, keys, optionsOf } from "../config-schema.js";
import { agentFrictionForCode } from "../activity-friction.js";
import type { KVStorage } from "../types.js";
import { validateStorageKey } from "./keys.js";

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
  /**
   * Run writes in order as one transaction; resolve with the rows each
   * statement changed.
   */
  batch(statements: readonly SqlStatement[]): Promise<number[]>;
}

const sql = (text: string, ...params: SqlValue[]): SqlStatement => ({
  sql: text,
  params,
});

// Text holding U+0000. Both drivers bind a string with NUL intact, and SQLite
// stores and compares TEXT by length, but `node:sqlite` on Node 22 ends a TEXT
// result at its first NUL: `"before\0after"` reads back as `"before"`. So a
// read of a text column also selects its bytes, only when they hold a zero
// byte, and the bytes win. Reading every value as a BLOB would also work, but
// D1 returns a BLOB as an array of numbers, several times the value's size on
// the wire, and stash chunks are large.

type TextBytes = Uint8Array | readonly number[];

/** Select `column`, and beside it `<column>_bytes` when it holds a NUL. */
const textColumn = (column: string) =>
  `${column}, CASE WHEN instr(CAST(${column} AS BLOB), x'00') > 0
    THEN CAST(${column} AS BLOB) END AS ${column}_bytes`;

// Everything written here was a JavaScript string, so the bytes are UTF-8;
// a stored row that is not is refused rather than read wrong. A leading
// U+FEFF is part of the value, not a byte order mark.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A text column's value, from its bytes when the read selected them. */
function textOf(text: string | null, bytes: TextBytes | null | undefined, what: string): string | null {
  if (bytes == null) return text;
  try {
    return utf8.decode(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
  } catch {
    throw new TypeError(`${what} is not valid UTF-8`);
  }
}

/** Run `ddl` once per store object; a failure leaves it to the next call. */
function schemaOnce(driver: SqlDriver, ddl: (driver: SqlDriver) => Promise<void>): () => Promise<void> {
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

function ttlMillis(ttlSeconds?: number): number | null {
  if (ttlSeconds !== undefined && !Number.isFinite(ttlSeconds)) {
    throw new RangeError("ttlSeconds must produce a finite expiration timestamp");
  }
  if (!ttlSeconds) return null;
  const expiry = ttlSeconds * 1000;
  if (!Number.isFinite(expiry)) {
    throw new RangeError("ttlSeconds must produce a finite expiration timestamp");
  }
  return Math.ceil(expiry);
}

/** The two drivers, as `describe()` names them. */
export type SqlKind = "d1" | "sqlite";

/** `KVStorage` over one `connecta_kv` table. */
export function sqlStorage(driver: SqlDriver, kind: SqlKind): KVStorage {
  const ensure = schemaOnce(driver, async (d) => {
    await d.batch(KV_SCHEMA.map((statement) => sql(statement)));
  });
  // SQLite and D1 evaluate 'now' in the database, never in a caller isolate.
  const now = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
  const live = `(expires_at_ms IS NULL OR expires_at_ms > ${now})`;
  const expiryOptions = (opts?: Parameters<KVStorage["set"]>[2]) => {
    if (opts?.expiresAtMs !== undefined) {
      if (!Number.isSafeInteger(opts.expiresAtMs) || opts.ttlSeconds !== undefined) {
        throw new RangeError("expiresAtMs must be a safe integer epoch timestamp without ttlSeconds");
      }
      return { value: opts.expiresAtMs, expression: "?" };
    }
    return { value: ttlMillis(opts?.ttlSeconds), expression: `(${now} + ?)` };
  };
  const current = async (key: string) => {
    const [row] = await driver.all<{ value: string; value_bytes: TextBytes | null }>(
      sql(`SELECT ${textColumn("value")} FROM connecta_kv WHERE key = ? AND ${live}`, key),
    );
    return row ? textOf(row.value, row.value_bytes, `the stored value of ${JSON.stringify(key)}`) : null;
  };
  return {
    capabilities: { absoluteExpiry: true },
    describe: () => ({ kind }),
    async get(key) {
      validateStorageKey(key);
      await ensure();
      return current(key);
    },
    async set(key, value, opts) {
      validateStorageKey(key);
      await ensure();
      const expiry = expiryOptions(opts);
      await driver.batch([
        sql(
          `DELETE FROM connecta_kv WHERE key IN (
            SELECT key FROM connecta_kv WHERE expires_at_ms <= ${now} LIMIT ${SWEEP_ROWS}
          )`,
        ),
        sql(
          `INSERT INTO connecta_kv (key, value, expires_at_ms)
           VALUES (?, ?, ${expiry.expression})
           ON CONFLICT (key) DO UPDATE SET
             value = excluded.value, expires_at_ms = excluded.expires_at_ms`,
          key,
          value,
          expiry.value,
        ),
      ]);
    },
    async delete(key) {
      validateStorageKey(key);
      await ensure();
      await driver.run(sql("DELETE FROM connecta_kv WHERE key = ?", key));
    },
    async list(prefix) {
      validateStorageKey(prefix);
      await ensure();
      const rows = await driver.all<{ key: string }>(
        sql(
          `SELECT key FROM connecta_kv
           WHERE key >= ?
             AND substr(CAST(key AS BLOB), 1, length(CAST(? AS BLOB))) = CAST(? AS BLOB)
             AND ${live}`,
          prefix,
          prefix,
          prefix,
        ),
      );
      // Sort in JavaScript: SQLite orders UTF-8 bytes, the contract orders
      // the UTF-16 code units every other adapter sorts by.
      return rows.map((row) => row.key).sort();
    },
    async compareAndSet(key, expected, next, opts) {
      validateStorageKey(key);
      await ensure();
      if (next === null && expected === null) {
        // Nothing to write; the claim holds exactly when no live row exists.
        return (await current(key)) === null;
      }
      if (next === null) {
        return (
          (await driver.run(sql(`DELETE FROM connecta_kv WHERE key = ? AND ${live} AND value = ?`, key, expected))) > 0
        );
      }
      let expiry: ReturnType<typeof expiryOptions>;
      try {
        expiry = expiryOptions(opts);
      } catch (error) {
        // Invalid write options do not change a failed comparison's result.
        // Ordinary claims still use one atomic statement without this read.
        if ((await current(key)) !== expected) return false;
        throw error;
      }
      if (expected === null) {
        // Insert, or take over a row that has expired. A live row makes the
        // upsert's WHERE false, so nothing changes and the claim is refused.
        return (
          (await driver.run(
            sql(
              `INSERT INTO connecta_kv (key, value, expires_at_ms)
           VALUES (?, ?, ${expiry.expression})
           ON CONFLICT (key) DO UPDATE SET
             value = excluded.value, expires_at_ms = excluded.expires_at_ms
           WHERE connecta_kv.expires_at_ms IS NOT NULL
             AND connecta_kv.expires_at_ms <= ${now}`,
              key,
              next,
              expiry.value,
            ),
          )) > 0
        );
      }
      return (
        (await driver.run(
          sql(
            `UPDATE connecta_kv SET value = ?, expires_at_ms = ${expiry.expression}
         WHERE key = ? AND ${live} AND value = ?`,
            next,
            expiry.value,
            key,
            expected,
          ),
        )) > 0
      );
    },
  };
}

/** One entry copied from another store, with its absolute expiry. */
export interface SqlCopyEntry {
  readonly key: string;
  readonly value: string;
  /** Epoch milliseconds; null never expires. */
  readonly expiresAtMs: number | null;
}

/**
 * What a copy did with one entry: written where no live row was, left alone
 * because the live row already held the value, refused because it held
 * another (`conflict`), or replaced under `overwrite` (`overwritten`).
 */
export type SqlCopyOutcome = "copied" | "unchanged" | "conflict" | "overwritten";

/** Keys one read compares: D1 binds at most 100 parameters, one is `now`. */
const COPY_READ_KEYS = 99;
/** Writes one transaction carries, by count and by UTF-8 bytes. */
const COPY_BATCH_STATEMENTS = 50;
const COPY_BATCH_BYTES = 4 * 1024 * 1024;

/**
 * Copy entries into the key-value table, verbatim: same key, same value,
 * same absolute expiry. A live row holding a different value is kept unless
 * `overwrite` is set, so a second copy of the same entries writes nothing.
 * Writes go out in bounded transactions; the outcomes follow `entries`.
 */
export async function copyIntoSql(
  driver: SqlDriver,
  entries: readonly SqlCopyEntry[],
  options: { overwrite: boolean; now: number },
): Promise<SqlCopyOutcome[]> {
  const { overwrite, now } = options;
  for (const entry of entries) validateStorageKey(entry.key);
  await driver.batch(KV_SCHEMA.map((statement) => sql(statement)));
  const live = "(expires_at_ms IS NULL OR expires_at_ms > ?)";
  const currentValues = async (keys: readonly string[]) => {
    const values = new Map<string, { value: string; expiresAtMs: number | null }>();
    for (let start = 0; start < keys.length; start += COPY_READ_KEYS) {
      const chunk = keys.slice(start, start + COPY_READ_KEYS);
      const rows = await driver.all<{
        key: string;
        value: string;
        value_bytes: TextBytes | null;
        expires_at_ms: number | null;
      }>(
        sql(
          `SELECT key, ${textColumn("value")}, expires_at_ms FROM connecta_kv
         WHERE key IN (${chunk.map(() => "?").join(", ")}) AND ${live}`,
          ...chunk,
          now,
        ),
      );
      // The message names no key: a copy's errors reach operator output.
      for (const row of rows) {
        values.set(row.key, {
          value: textOf(row.value, row.value_bytes, "a stored value") ?? "",
          expiresAtMs: row.expires_at_ms,
        });
      }
    }
    return values;
  };

  const outcomes = Array.from<SqlCopyOutcome>({ length: entries.length });
  const writes: { index: number; statement: SqlStatement; bytes: number }[] = [];
  const existing = await currentValues(entries.map((entry) => entry.key));
  for (const [index, entry] of entries.entries()) {
    const current = existing.get(entry.key);
    if (current?.value === entry.value && current.expiresAtMs === entry.expiresAtMs) {
      outcomes[index] = "unchanged";
    } else if (current !== undefined && !overwrite) {
      outcomes[index] = "conflict";
    } else {
      outcomes[index] = current === undefined ? "copied" : "overwritten";
      writes.push({
        index,
        bytes: new TextEncoder().encode(entry.key).byteLength + new TextEncoder().encode(entry.value).byteLength + 32,
        statement: overwrite
          ? sql(
              `INSERT INTO connecta_kv (key, value, expires_at_ms)
               VALUES (?, ?, ?)
               ON CONFLICT (key) DO UPDATE SET
                 value = excluded.value, expires_at_ms = excluded.expires_at_ms`,
              entry.key,
              entry.value,
              entry.expiresAtMs,
            )
          : // Absent when read; a live row written since is kept, not replaced.
            sql(
              `INSERT INTO connecta_kv (key, value, expires_at_ms)
               VALUES (?, ?, ?)
               ON CONFLICT (key) DO UPDATE SET
                 value = excluded.value, expires_at_ms = excluded.expires_at_ms
               WHERE connecta_kv.expires_at_ms IS NOT NULL
                 AND connecta_kv.expires_at_ms <= ?`,
              entry.key,
              entry.value,
              entry.expiresAtMs,
              now,
            ),
      });
    }
  }

  const raced: number[] = [];
  let batch: typeof writes = [];
  let batchBytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const changes = await driver.batch(batch.map((write) => write.statement));
    for (const [position, write] of batch.entries()) {
      if (!(changes[position]! > 0)) raced.push(write.index);
    }
    batch = [];
    batchBytes = 0;
  };
  for (const write of writes) {
    if (batch.length > 0 && (batch.length >= COPY_BATCH_STATEMENTS || batchBytes + write.bytes > COPY_BATCH_BYTES)) {
      await flush();
    }
    batch.push(write);
    batchBytes += write.bytes;
  }
  await flush();

  // A row another writer added between the read and the write: report what
  // it holds, and leave it.
  if (raced.length > 0) {
    const after = await currentValues(raced.map((index) => entries[index]!.key));
    for (const index of raced) {
      const entry = entries[index]!;
      const current = after.get(entry.key);
      outcomes[index] =
        current?.value === entry.value && current.expiresAtMs === entry.expiresAtMs ? "unchanged" : "conflict";
    }
  }
  return outcomes;
}

// --- activity -----------------------------------------------------------

/**
 * The activity table, with keyset paging on `(occurred_at_ms, id)`. Its shape
 * is the 0.28 Worker example's `tool_call_activity`; a table created before
 * later actor, friction, approval, client, or package columns existed gets
 * those columns added without changing old rows.
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
    package_version TEXT,
    server_name     TEXT NOT NULL,
    server_version  TEXT NOT NULL,
    client_name     TEXT,
    client_version  TEXT,
    deployment_id   TEXT,
    classification  TEXT,
    result_bytes    INTEGER,
    event_kind      TEXT,
    drift_kind      TEXT,
    added_tools     INTEGER,
    removed_tools   INTEGER,
    changed_tools   INTEGER,
    pool_name       TEXT,
    actor_basis     TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS tool_call_activity_recent
    ON tool_call_activity (occurred_at_ms DESC, id DESC)`,
];

/** Columns added after the table first shipped, in the order they arrived. */
const LATER_ACTIVITY_COLUMNS = [
  "actor_namespace",
  "friction",
  "approval",
  "client_name",
  "client_version",
  "package_version",
  "classification",
  "result_bytes",
  "event_kind",
  "drift_kind",
  "added_tools",
  "removed_tools",
  "changed_tools",
  "pool_name",
  "actor_basis",
];

interface ActivityRow {
  classification: string | null;
  result_bytes: number | null;
  event_kind: string | null;
  drift_kind: string | null;
  added_tools: number | null;
  removed_tools: number | null;
  changed_tools: number | null;
  pool_name: string | null;
  actor_basis: string | null;
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
  package_version: string | null;
  server_name: string;
  server_version: string;
  client_name: string | null;
  client_version: string | null;
  deployment_id: string | null;
}

/** Every activity column but the three integers, read through `textOf`. */
const ACTIVITY_TEXT_COLUMNS = [
  "id",
  "request_id",
  "actor_kind",
  "actor_id",
  "actor_namespace",
  "connector_id",
  "tool_name",
  "source",
  "outcome",
  "error_code",
  "friction",
  "approval",
  "package_version",
  "server_name",
  "server_version",
  "client_name",
  "client_version",
  "deployment_id",
  "classification",
  "event_kind",
  "drift_kind",
  "pool_name",
  "actor_basis",
] as const;

const ACTIVITY_SELECT = `SELECT occurred_at_ms, duration_ms, attempts, result_bytes, added_tools, removed_tools, changed_tools,
  ${ACTIVITY_TEXT_COLUMNS.map(textColumn).join(",\n  ")}
  FROM tool_call_activity`;

function activityRow(read: Record<string, unknown>): ActivityRow {
  const row: Record<string, unknown> = {
    occurred_at_ms: read.occurred_at_ms,
    duration_ms: read.duration_ms,
    attempts: read.attempts,
    result_bytes: read.result_bytes,
    added_tools: read.added_tools,
    removed_tools: read.removed_tools,
    changed_tools: read.changed_tools,
  };
  for (const column of ACTIVITY_TEXT_COLUMNS) {
    row[column] = textOf(
      read[column] as string | null,
      read[`${column}_bytes`] as TextBytes | null,
      `activity column ${column}`,
    );
  }
  return row as unknown as ActivityRow;
}

function rowToEvent(row: ActivityRow): ToolCallActivityEvent {
  // Rows written before `friction` had a column derive it from the code.
  // Friction without a code — an oversized but successful result — exists
  // only in the column, which is why the column exists.
  const friction = row.friction ?? agentFrictionForCode(row.error_code ?? undefined);
  const packageVersion = activityPackageVersion(row.package_version);
  const clientName = activityClientFact(row.client_name, "name");
  const clientVersion = activityClientFact(row.client_version, "version");
  return {
    schemaVersion: 1,
    id: row.id,
    occurredAt: new Date(row.occurred_at_ms).toISOString(),
    requestId: row.request_id,
    ...activityBehaviorFacts({
      classification: row.classification,
      resultBytes: row.result_bytes,
      kind: row.event_kind,
      pool: row.pool_name,
      actorBasis: row.actor_basis,
      drift: {
        kind: row.drift_kind,
        addedTools: row.added_tools,
        removedTools: row.removed_tools,
        changedTools: row.changed_tools,
      },
    }),
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
    ...(packageVersion !== undefined ? { packageVersion } : {}),
    serverName: row.server_name,
    serverVersion: row.server_version,
    ...(clientName !== undefined ? { clientName } : {}),
    ...(clientVersion !== undefined ? { clientVersion } : {}),
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
  if (separator < 1 || !Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0 || !/^[0-9a-f-]{36}$/i.test(id)) {
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

/** The closed options both activity factories accept; see `assertKnownOptions`. */
const SQL_ACTIVITY_OPTIONS = optionsOf<SqlActivityOptions>()(keys("retentionDays"));

/** Older rows one write removes on its way. Above one: writes catch up. */
const RETENTION_SWEEP_ROWS = 16;

/**
 * One append-only row per completed downstream call. Rows carry no arguments,
 * results, generated code, or raw error messages — the store never has a
 * payload to leak.
 */
export function sqlActivityStore(driver: SqlDriver, kind: SqlKind, options: SqlActivityOptions = {}): ActivityStore {
  const factory = kind === "d1" ? "d1ActivityStore()" : "sqliteActivityStore()";
  const { retentionDays = 90 } = assertKnownOptions(options, factory, SQL_ACTIVITY_OPTIONS);
  if (typeof retentionDays !== "number" || !(retentionDays > 0) || !Number.isFinite(retentionDays)) {
    throw new ConfigError(`${factory}.retentionDays must be a positive number of days.`);
  }
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const ensure = schemaOnce(driver, async (d) => {
    await d.batch(ACTIVITY_SCHEMA.map((statement) => sql(statement)));
    const columns = async () =>
      new Set(
        (await d.all<{ name: string }>(sql("PRAGMA table_info(tool_call_activity)"))).map((column) => column.name),
      );
    // Isolates and processes upgrade an old table concurrently, each from its
    // own read of the columns. One column per statement, and a refused ALTER
    // re-reads the table: if another upgrader added the column, this one
    // moves on to the next instead of failing the write that started it.
    let present = await columns();
    for (const name of LATER_ACTIVITY_COLUMNS) {
      if (present.has(name)) continue;
      try {
        await d.run(
          sql(
            `ALTER TABLE tool_call_activity ADD COLUMN ${name} ${["result_bytes", "added_tools", "removed_tools", "changed_tools"].includes(name) ? "INTEGER" : "TEXT"}`,
          ),
        );
      } catch (error) {
        present = await columns();
        if (!present.has(name)) throw error;
      }
    }
  });
  return {
    describe: () => ({ kind, retentionDays }),
    async record(event) {
      await ensure();
      const occurredAtMs = Date.parse(event.occurredAt);
      const facts = activityBehaviorFacts(event);
      await driver.batch([
        sql(
          `INSERT INTO tool_call_activity (
            id, occurred_at_ms, request_id, actor_kind, actor_id,
            actor_namespace, connector_id, tool_name, source, outcome,
            duration_ms, attempts, error_code, friction, approval,
            package_version, server_name, server_version, client_name, client_version, deployment_id,
            classification, result_bytes, event_kind, drift_kind, added_tools, removed_tools, changed_tools, pool_name, actor_basis
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          activityPackageVersion(event.packageVersion) ?? null,
          event.serverName,
          event.serverVersion,
          activityClientFact(event.clientName, "name") ?? null,
          activityClientFact(event.clientVersion, "version") ?? null,
          event.deploymentId ?? null,
          facts.classification ?? null,
          facts.resultBytes ?? null,
          facts.kind ?? null,
          facts.drift?.kind ?? null,
          facts.drift?.addedTools ?? null,
          facts.drift?.removedTools ?? null,
          facts.drift?.changedTools ?? null,
          facts.pool ?? null,
          facts.actorBasis ?? null,
        ),
        sql(
          `DELETE FROM tool_call_activity WHERE id IN (
            SELECT id FROM tool_call_activity
            WHERE occurred_at_ms < ?
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
      const rows = (
        await driver.all<Record<string, unknown>>(
          position
            ? sql(
                `${ACTIVITY_SELECT}
             WHERE occurred_at_ms < ?
                OR (occurred_at_ms = ? AND id < ?)
             ORDER BY occurred_at_ms DESC, id DESC
             LIMIT ?`,
                position.occurredAtMs,
                position.occurredAtMs,
                position.id,
                pageSize,
              )
            : sql(
                `${ACTIVITY_SELECT}
             ORDER BY occurred_at_ms DESC, id DESC
             LIMIT ?`,
                pageSize,
              ),
        )
      ).map(activityRow);
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
