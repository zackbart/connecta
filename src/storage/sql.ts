// Promise compatibility edges. All SQL orchestration lives in sql-native.ts.
// Keep these types free of Effect: SqlActivityOptions is publicly reachable.
import type { ActivityStore } from "../activity.js";
import type { KVStorage } from "../types.js";
import { runEdge } from "../runtime/run.js";
import { registerNativeStorage, registerNativeActivity } from "../runtime/native-storage.js";
import { nativeSqlDriver } from "./sql-driver.js";
import { nativeSqlStorage, nativeSqlActivityStore, copyIntoSqlEffect } from "./sql-native.js";
/** The 0.28-compatible key-value table and expiry index. */
export { KV_SCHEMA } from "./sql-schema.js";

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

/** The two drivers, as `describe()` names them. */
export type SqlKind = "d1" | "sqlite";

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

export interface SqlActivityOptions {
  /**
   * Days of history kept. Each write removes a bounded batch of older rows,
   * so the table stays near this window without a scheduled job. Default 90.
   */
  retentionDays?: number;
}

/** `KVStorage` over one `connecta_kv` table. */
export function sqlStorage(driver: SqlDriver, kind: SqlKind): KVStorage {
  const native = nativeSqlStorage(nativeSqlDriver(driver));
  return registerNativeStorage(
    {
      capabilities: { absoluteExpiry: true },
      describe: () => ({ kind }),
      get: (key) => runEdge(native.get(key)),
      set: (key, value, options) => runEdge(native.set(key, value, options)),
      delete: (key) => runEdge(native.delete(key)),
      list: (prefix) => runEdge(native.list(prefix)),
      compareAndSet: (key, expected, next, options) => runEdge(native.compareAndSet(key, expected, next, options)),
    },
    native,
  );
}

/**
 * One append-only row per completed downstream call. Rows carry no arguments,
 * results, generated code, or raw error messages — the store never has a
 * payload to leak.
 */
export function sqlActivityStore(driver: SqlDriver, kind: SqlKind, options: SqlActivityOptions = {}): ActivityStore {
  const native = nativeSqlActivityStore(nativeSqlDriver(driver), kind, options);
  return registerNativeActivity(
    {
      describe: native.describe,
      record: (event) => runEdge(native.record(event)),
      list: (options) => runEdge(native.list(options)),
    },
    native,
  );
}

/**
 * Copy entries into the key-value table, verbatim: same key, same value,
 * same absolute expiry. A live row holding a different value is kept unless
 * `overwrite` is set, so a second copy of the same entries writes nothing.
 * Writes go out in bounded transactions; the outcomes follow `entries`.
 */
export function copyIntoSql(
  driver: SqlDriver,
  entries: readonly SqlCopyEntry[],
  options: { overwrite: boolean; now: number },
): Promise<SqlCopyOutcome[]> {
  return runEdge(copyIntoSqlEffect(nativeSqlDriver(driver), entries, options));
}
