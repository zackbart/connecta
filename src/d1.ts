// `@zackbart/connecta/d1`: connecta's storage on Cloudflare Workers.
//
// One D1 database holds everything: `d1Storage(db)` is the deployment's
// `KVStorage`, and `d1ActivityStore(db)` its activity history. Both create
// their tables on first use, so binding the database is the whole setup.
// `copyKvToD1` moves a 0.28 deployment's Workers KV state into it once.

import { errorLabel } from "./operator-record.js";
import type { ActivityStore } from "./activity.js";
import type { KVStorage } from "./types.js";
import {
  familyOfKey, KEY_FAMILIES, KV_COPY_CURSOR_TTL_SECONDS, kvCopyKeys, kvCutoverKeys,
} from "./storage/keys.js";
import {
  copyIntoSql,
  type SqlCopyEntry,
  type SqlCopyOutcome,
  sqlActivityStore,
  type SqlActivityOptions,
  type SqlDriver,
  type SqlStatement,
  sqlStorage,
} from "./storage/sql.js";

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

function d1Driver(db: D1DatabaseBinding): SqlDriver {
  const prepare = (statement: SqlStatement) =>
    statement.params.length > 0
      ? db.prepare(statement.sql).bind(...statement.params)
      : db.prepare(statement.sql);
  return {
    async all<Row>(statement: SqlStatement) {
      return (await prepare(statement).all()).results as Row[];
    },
    async run(statement) {
      return (await prepare(statement).run()).meta.changes ?? 0;
    },
    async batch(statements) {
      // D1 runs a batch as one transaction, in order.
      return (await db.batch(statements.map(prepare)))
        .map((result) => result.meta.changes ?? 0);
    },
  };
}

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
export function d1ActivityStore(
  db: D1DatabaseBinding,
  options?: D1ActivityOptions,
): ActivityStore {
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

/** D1 string and row limit, in UTF-8 bytes.
 * https://developers.cloudflare.com/d1/platform/limits/
 */
const D1_MAX_ROW_BYTES = 2_000_000;
/** Buffered entries, excluding the single value currently being read. */
const COPY_BUFFER_BYTES = 4 * 1024 * 1024;
const COPY_GROUP_KEYS = 50;
const KV_LIST_LIMIT = 1000;
const encoder = new TextEncoder();

// SQLite record header, two TEXT serial types, and an eight-byte expiry.
// Reserve the worst-case header rather than accepting a row at the boundary.
const ROW_OVERHEAD_BYTES = 32;

const emptyCounts = (): KvToD1Counts => ({
  copied: 0, unchanged: 0, conflicts: 0, overwritten: 0, expired: 0, invalid: 0,
  verified: 0, mismatches: 0,
});

const OUTCOME_COUNT: Record<SqlCopyOutcome, keyof KvToD1Counts> = {
  copied: "copied",
  unchanged: "unchanged",
  conflict: "conflicts",
  overwritten: "overwritten",
};

function errorClass(error: unknown): string {
  const label = errorLabel(error);
  return label ? ` (${label})` : "";
}

const valueHash = async (value: string) => {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Mark cutover before reopening traffic. The marker stays in D1 permanently. */
export async function markKvToD1Live(db: D1DatabaseBinding, source: string): Promise<void> {
  if (typeof source !== "string" || !source || source.includes("\0")) {
    throw new TypeError("copyKvToD1 source must be a namespace id");
  }
  try {
    await d1Storage(db).set(kvCutoverKeys.source(source), "live");
  } catch (error) {
    throw new KvToD1CopyError(`Workers KV to D1 copy stopped: recording cutover failed${errorClass(error)}`, undefined);
  }
}

/**
 * Copy live KV entries verbatim while all writers and traffic are stopped.
 * A live D1 row is kept unless its family is explicitly allowed to overwrite.
 * `verify` reads hashes and absolute expiries without changing copied entries.
 * Results contain counts only. Resume tokens are source-bound atomic claims.
 */
export async function copyKvToD1(
  kv: KVNamespaceBinding,
  db: D1DatabaseBinding,
  options: KvToD1CopyOptions,
): Promise<KvToD1CopyResult> {
  if (!options?.source || typeof options.source !== "string" || options.source.includes("\0")) {
    throw new TypeError("copyKvToD1 source must be a namespace id");
  }
  const maxKeys = options.maxKeys ?? 500;
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) {
    throw new TypeError("copyKvToD1 maxKeys must be a positive integer");
  }
  const allowed = new Set([...KEY_FAMILIES.map((family) => family.name), "connector-owned", "unclassified"]);
  if (options.overwriteFamilies?.some((family) => !allowed.has(family))) {
    throw new TypeError("copyKvToD1 overwriteFamilies contains an unknown family");
  }
  const overwrite = new Set(options.overwriteFamilies ?? []);
  const driver = d1Driver(db);
  const storage = sqlStorage(driver, "d1");
  const remember = async (kvCursor: string) => {
    const token = crypto.randomUUID();
    await storage.set(kvCopyKeys.cursor(token), JSON.stringify({ source: options.source, cursor: kvCursor }), {
      ttlSeconds: KV_COPY_CURSOR_TTL_SECONDS,
    });
    return token;
  };
  let cursor: string | undefined;
  let pageCursor: string | undefined;
  const families: Record<string, KvToD1Counts> = {};
  const count = (key: string, field: keyof KvToD1Counts) => {
    (families[familyOfKey(key)] ??= emptyCounts())[field] += 1;
  };
  const unknown = new TypeError("copyKvToD1 cursor is unknown, expired, spent, or belongs to another source; restart under maintenance");
  const stale = new TypeError("copyKvToD1 refuses stale KV after cutover");
  // Validate before any D1 access so a failing binding cannot return raw input
  // as an error's resume point.
  if (options.cursor !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.cursor)) {
    throw unknown;
  }
  const failures = new WeakSet<KvToD1CopyError>();
  const failure = (message: string) => {
    const error = new KvToD1CopyError(message, undefined);
    failures.add(error);
    return error;
  };

  try {
    if (!options.allowStale && await storage.get(kvCutoverKeys.source(options.source)) !== null) {
      throw stale;
    }
    if (options.cursor !== undefined) {
      const key = kvCopyKeys.cursor(options.cursor);
      const stored = await storage.get(key);
      let record: { source?: string; cursor?: string } | null = null;
      try { record = stored === null ? null : JSON.parse(stored); } catch { /* refused below */ }
      if (!record || record.source !== options.source || typeof record.cursor !== "string") {
        throw unknown;
      }
      // Delete only the exact record read: concurrent consumers cannot both win.
      if (!await storage.compareAndSet(key, stored, null)) throw unknown;
      cursor = record.cursor;
    }
  } catch (error) {
    if (error === unknown || error === stale) throw error;
    throw new KvToD1CopyError(`Workers KV to D1 copy stopped: claiming the resume point in D1 failed${errorClass(error)}`, options.cursor);
  }

  const flush = async (buffer: SqlCopyEntry[]) => {
    const entries = buffer.filter((entry) => {
      if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
        count(entry.key, "expired");
        return false;
      }
      return true;
    });
    if (!entries.length) return;
    try {
      if (options.verify) {
        for (const entry of entries) {
          const [row] = await driver.all<{ value_bytes: readonly number[]; expires_at_ms: number | null }>({
            // Read bytes, including NUL, and hash in JS. D1 has no SHA-256 function.
            sql: "SELECT CAST(value AS BLOB) AS value_bytes, expires_at_ms FROM connecta_kv WHERE key = ?",
            params: [entry.key],
          });
          const bytes = row ? Uint8Array.from(row.value_bytes) : undefined;
          const hash = bytes ? await crypto.subtle.digest("SHA-256", bytes) : undefined;
          const hex = hash ? Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("") : undefined;
          count(entry.key, row && row.expires_at_ms === entry.expiresAtMs && hex === await valueHash(entry.value)
            ? "verified" : "mismatches");
        }
      } else {
        // Partition only this bounded buffer by overwrite permission.
        for (const replace of [false, true]) {
          const group = entries.filter((entry) => overwrite.has(familyOfKey(entry.key)) === replace);
          if (!group.length) continue;
          const outcomes = await copyIntoSql(driver, group, { overwrite: replace, now: Date.now() });
          for (const [index, outcome] of outcomes.entries()) count(group[index]!.key, OUTCOME_COUNT[outcome]);
        }
      }
    } catch (error) {
      throw failure(`Workers KV to D1 copy stopped: ${options.verify ? "verifying" : "writing to"} D1 failed${errorClass(error)}`);
    }
  };

  let read = 0;
  try {
    for (;;) {
      pageCursor = cursor;
      let page: Awaited<ReturnType<KVNamespaceBinding["list"]>>;
      try {
        page = await kv.list({ limit: Math.min(KV_LIST_LIMIT, maxKeys - read), ...(cursor ? { cursor } : {}) });
      } catch (error) {
        throw failure(`Workers KV to D1 copy stopped: listing Workers KV failed${errorClass(error)}`);
      }
      read += page.keys.length;
      let entries: SqlCopyEntry[] = [];
      let bufferedBytes = 0;
      for (const key of page.keys) {
        const keyBytes = encoder.encode(key.name).byteLength;
        if (key.name.includes("\0") || keyBytes + ROW_OVERHEAD_BYTES > D1_MAX_ROW_BYTES) {
          count(key.name, "invalid");
          continue;
        }
        const expiresAtMs = key.expiration === undefined ? null : key.expiration * 1000;
        if (expiresAtMs !== null && expiresAtMs <= Date.now()) {
          count(key.name, "expired");
          continue;
        }
        let value: string | null;
        try { value = await kv.get(key.name, "text"); } catch (error) {
          throw failure(`Workers KV to D1 copy stopped: reading an entry of the ${familyOfKey(key.name)} family from Workers KV failed${errorClass(error)}`);
        }
        if (value === null || (expiresAtMs !== null && expiresAtMs <= Date.now())) {
          count(key.name, "expired");
          continue;
        }
        const valueBytes = encoder.encode(value).byteLength;
        const bytes = keyBytes + valueBytes + ROW_OVERHEAD_BYTES;
        if (valueBytes > D1_MAX_ROW_BYTES || bytes > D1_MAX_ROW_BYTES) {
          count(key.name, "invalid");
          continue;
        }
        if (entries.length >= COPY_GROUP_KEYS || bufferedBytes + bytes > COPY_BUFFER_BYTES) {
          await flush(entries);
          entries = [];
          bufferedBytes = 0;
        }
        entries.push({ key: key.name, value, expiresAtMs });
        bufferedBytes += bytes;
      }
      await flush(entries);
      if (page.list_complete || !page.cursor) return { done: true, families };
      cursor = page.cursor;
      if (read >= maxKeys) return { done: false, cursor: await remember(cursor), families };
    }
  } catch (error) {
    // The old token was claimed atomically. Replace it on failure, if D1 works.
    const resume = pageCursor === undefined ? undefined : await remember(pageCursor).catch(() => undefined);
    throw new KvToD1CopyError(error instanceof KvToD1CopyError && failures.has(error) ? error.message
      : `Workers KV to D1 copy stopped: recording the resume point in D1 failed${errorClass(error)}`, resume);
  }
}
