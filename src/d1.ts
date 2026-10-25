// `@zackbart/connecta/d1`: connecta's storage on Cloudflare Workers.
//
// One D1 database holds everything: `d1Storage(db)` is the deployment's
// `KVStorage`, and `d1ActivityStore(db)` its activity history. Both create
// their tables on first use, so binding the database is the whole setup.
// `copyKvToD1` moves a 0.28 deployment's Workers KV state into it once.

import { runEdge } from "./runtime/run.js";
import { d1Driver } from "./storage/d1-driver.js";
import { copyKvToD1Effect, markKvToD1LiveEffect } from "./storage/d1-copy.js";
import type { ActivityStore } from "./activity.js";
import type { KVStorage } from "./types.js";
import { sqlActivityStore, type SqlActivityOptions, sqlStorage } from "./storage/sql.js";
import { keepErrorName } from "./redaction-identity.js";

/**
 * The part of a D1 binding connecta uses. Structural, so this package's
 * declarations do not depend on `@cloudflare/workers-types`; a Worker's
 * `D1Database` satisfies it.
 */
export interface D1DatabaseBinding {
  prepare(query: string): D1StatementBinding;
  batch(statements: D1StatementBinding[]): Promise<{ meta: { changes?: number } }[]>;
}

interface D1StatementBinding {
  bind(...values: unknown[]): D1StatementBinding;
  all(): Promise<{ results: unknown[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}

export type D1ActivityOptions = SqlActivityOptions;

/**
 * `KVStorage` over a D1 database, with the atomic `compareAndSet` every
 * subsystem relies on. The `connecta_kv` table is created on first use; a
 * database that already holds the 0.28 example's table is read as is.
 */
export function d1Storage(db: D1DatabaseBinding): KVStorage {
  return sqlStorage(d1Driver(db), "d1");
}

/**
 * Payload-free activity history in the same D1 database, for
 * `activityHistory({ store })`. Keyset paging on `(occurred_at_ms, id)`; each
 * write prunes a bounded batch of rows older than `retentionDays`.
 */
export function d1ActivityStore(db: D1DatabaseBinding, options?: D1ActivityOptions): ActivityStore {
  return sqlActivityStore(d1Driver(db), "d1", options);
}

// --- Workers KV, once ---------------------------------------------------

/**
 * The part of a Workers KV binding `copyKvToD1` reads. Structural, like
 * `D1DatabaseBinding`; a Worker's `KVNamespace` satisfies it.
 */
export interface KVNamespaceBinding {
  list(options?: { limit?: number; cursor?: string | null }): Promise<{
    keys: readonly { name: string; expiration?: number }[];
    list_complete: boolean;
    cursor?: string;
  }>;
  get(key: string, type: "text"): Promise<string | null>;
}

export interface KvToD1CopyOptions {
  /** The source KV namespace id. Resume tokens are bound to this identity. */
  source: string;
  /** Resume against the same source and database within seven days. */
  cursor?: string;
  /** Explicit families whose conflicting D1 rows the operator judged stale. */
  overwriteFamilies?: readonly string[];
  /** Compare value hashes and absolute expiries without copying entries. */
  verify?: boolean;
  /** Override the cutover guard only after assessing stale KV state. */
  allowStale?: boolean;
  /** Keys read per call. Default 500; use a smaller budget for large rows. */
  maxKeys?: number;
}

/** What a copy did with one family's keys. */
export interface KvToD1Counts {
  /** Written where D1 held no live entry. */
  copied: number;
  /** D1 already held the same value. */
  unchanged: number;
  /** D1 held a different value or expiry and kept it. */
  conflicts: number;
  /** D1 held a different value or expiry, replaced under `overwriteFamilies`. */
  overwritten: number;
  /** Expired or deleted in Workers KV before it could be read. */
  expired: number;
  /** A key/value/row D1 cannot hold, left in Workers KV. */
  invalid: number;
  /** Exact value hash and expiry match during a verification pass. */
  verified: number;
  /** Missing or different value/expiry during a verification pass. */
  mismatches: number;
}

export interface KvToD1CopyResult {
  /** True once the whole namespace has been read. */
  done: boolean;
  /**
   * Pass back as `options.cursor` to continue; absent when `done`. A random
   * token: the Workers KV cursor it stands for stays in D1, because that
   * cursor can spell the last key listed.
   */
  cursor?: string;
  /**
   * Counts by key family (`src/storage/keys.ts`), plus `connector-owned` and
   * `unclassified`. Never a key or a value.
   */
  families: Record<string, KvToD1Counts>;
}

/**
 * A copy that stopped. The message is fixed wording that names a family at
 * most, never a key or value, and the binding's own error is not attached:
 * KV and D1 errors can quote either. Entries before `cursor` are copied;
 * rerunning from it is safe while the maintenance window still holds.
 */
export class KvToD1CopyError extends Error {
  override readonly name = "KvToD1CopyError";
  constructor(
    message: string,
    /** Resume point; absent means start over, which is also safe. */
    readonly cursor: string | undefined,
  ) {
    super(message);
  }
}
keepErrorName(KvToD1CopyError, "KvToD1CopyError");

/** Mark cutover before reopening traffic. The marker stays in D1 permanently. */
export function markKvToD1Live(db: D1DatabaseBinding, source: string): Promise<void> {
  return runEdge(markKvToD1LiveEffect(db, source));
}

/**
 * Copy live KV entries verbatim while all writers and traffic are stopped.
 * A live D1 row is kept unless its family is explicitly allowed to overwrite.
 * `verify` reads hashes and absolute expiries without changing copied entries.
 * Results contain counts only. Resume tokens are source-bound atomic claims.
 */
export function copyKvToD1(
  kv: KVNamespaceBinding,
  db: D1DatabaseBinding,
  options: KvToD1CopyOptions,
): Promise<KvToD1CopyResult> {
  return runEdge(copyKvToD1Effect(kv, db, options));
}
