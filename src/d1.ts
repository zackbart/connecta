// `@zackbart/connecta/d1`: connecta's storage on Cloudflare Workers.
//
// One D1 database holds everything: `d1Storage(db)` is the deployment's
// `KVStorage`, and `d1ActivityStore(db)` its activity history. Both create
// their tables on first use, so binding the database is the whole setup.
// `copyKvToD1` moves a 0.28 deployment's Workers KV state into it once.

import type { ActivityStore } from "./activity.js";
import type { KVStorage } from "./types.js";
import { familyOfKey, KV_COPY_CURSOR_TTL_SECONDS, kvCopyKeys } from "./storage/keys.js";
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
  /**
   * Where to resume: the `cursor` of a previous result or error, against the
   * same database, within seven days.
   */
  cursor?: string;
  /**
   * Replace a live D1 entry that holds a different value. Off by default: the
   * entry is kept and counted as a conflict.
   */
  overwrite?: boolean;
  /**
   * Keys one call reads before it returns a cursor. Default 500, which keeps
   * a call inside a Worker invocation's KV and D1 operation limits.
   */
  maxKeys?: number;
}

/** What a copy did with one family's keys. */
export interface KvToD1Counts {
  /** Written where D1 held no live entry. */
  copied: number;
  /** D1 already held the same value. */
  unchanged: number;
  /** D1 held a different value and kept it. */
  conflicts: number;
  /** D1 held a different value, replaced under `overwrite`. */
  overwritten: number;
  /** Expired or deleted in Workers KV before it could be read. */
  expired: number;
  /** A key D1 storage cannot hold (it contains U+0000), left in Workers KV. */
  invalid: number;
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
 * rerunning from it is safe because the copy is idempotent.
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

/** KV reads in flight at once: a Worker holds six connections. */
const KV_READ_CONCURRENCY = 6;
/** Keys read and written as one group, bounding memory on large values. */
const COPY_GROUP_KEYS = 50;
/** Workers KV returns at most this many keys per list call. */
const KV_LIST_LIMIT = 1000;

const emptyCounts = (): KvToD1Counts => ({
  copied: 0, unchanged: 0, conflicts: 0, overwritten: 0, expired: 0, invalid: 0,
});

const OUTCOME_COUNT: Record<SqlCopyOutcome, keyof KvToD1Counts> = {
  copied: "copied",
  unchanged: "unchanged",
  conflict: "conflicts",
  overwritten: "overwritten",
};

/** An error's class for an operator message, when it is a plain identifier. */
function errorClass(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return /^[A-Za-z]{1,64}$/.test(name) ? ` (${name})` : "";
}

/**
 * Copy a 0.28 deployment's Workers KV state into D1, once, so OAuth grants,
 * vault credentials, and `cta_` tokens survive the move to `d1Storage`.
 * Physical keys did not change, so each live entry is written verbatim: same
 * key, same value (NUL included), same absolute expiry. Expired entries are
 * skipped. A D1 entry holding a different value is kept unless `overwrite`
 * is set, so rerunning copies nothing twice.
 *
 * One call reads at most `maxKeys` keys and returns `done: false` with a
 * cursor when more remain; loop until `done`. The result counts keys by
 * family and names none, so it can be logged as is.
 */
export async function copyKvToD1(
  kv: KVNamespaceBinding,
  db: D1DatabaseBinding,
  options: KvToD1CopyOptions = {},
): Promise<KvToD1CopyResult> {
  const maxKeys = options.maxKeys ?? 500;
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) {
    throw new TypeError("copyKvToD1 maxKeys must be a positive integer");
  }
  const overwrite = options.overwrite ?? false;
  const driver = d1Driver(db);
  const storage = sqlStorage(driver);
  /** A token for a Workers KV cursor, which stays in D1. */
  const remember = async (kvCursor: string) => {
    const token = crypto.randomUUID();
    await storage.set(kvCopyKeys.cursor(token), kvCursor, {
      ttlSeconds: KV_COPY_CURSOR_TTL_SECONDS,
    });
    return token;
  };
  /** An error's resume point, when D1 can still record one. */
  const resumePoint = (kvCursor: string | undefined) =>
    kvCursor === undefined ? undefined : remember(kvCursor).catch(() => undefined);
  const families: Record<string, KvToD1Counts> = {};
  const count = (key: string, field: keyof KvToD1Counts) => {
    (families[familyOfKey(key)] ??= emptyCounts())[field] += 1;
  };

  /** Read and write one group of a page; failures resume at the page. */
  const copyGroup = async (
    keys: readonly { name: string; expiration?: number }[],
    pageCursor: string | undefined,
  ) => {
    const now = Date.now();
    const live = keys.filter((key) => {
      if (key.name.includes("\0")) {
        count(key.name, "invalid");
        return false;
      }
      if (key.expiration !== undefined && key.expiration * 1000 <= now) {
        count(key.name, "expired");
        return false;
      }
      return true;
    });
    // A few readers drain the group. The first failure stops the rest, and
    // every read settles before this returns, so none outlives the call.
    const values = Array.from<string | null>({ length: live.length });
    let next = 0;
    let failure: string | undefined;
    const reader = async () => {
      while (!failure && next < live.length) {
        const index = next++;
        const key = live[index]!;
        try {
          values[index] = await kv.get(key.name, "text");
        } catch (error) {
          failure ??= `Workers KV to D1 copy stopped: reading an entry of the ${familyOfKey(key.name)} family from Workers KV failed${errorClass(error)}`;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(KV_READ_CONCURRENCY, live.length) }, reader),
    );
    if (failure) throw new KvToD1CopyError(failure, await resumePoint(pageCursor));
    const entries: SqlCopyEntry[] = [];
    for (const [index, key] of live.entries()) {
      const value = values[index];
      const expiresAtMs = key.expiration === undefined ? null : key.expiration * 1000;
      // Gone since the list, or lapsed while reading.
      if (value == null || (expiresAtMs !== null && expiresAtMs <= Date.now())) {
        count(key.name, "expired");
        continue;
      }
      entries.push({ key: key.name, value, expiresAtMs });
    }
    if (entries.length === 0) return;
    let outcomes: SqlCopyOutcome[];
    try {
      outcomes = await copyIntoSql(driver, entries, { overwrite, now: Date.now() });
    } catch (error) {
      throw new KvToD1CopyError(
        `Workers KV to D1 copy stopped: writing to D1 failed${errorClass(error)}`,
        await resumePoint(pageCursor),
      );
    }
    for (const [index, outcome] of outcomes.entries()) {
      count(entries[index]!.key, OUTCOME_COUNT[outcome]);
    }
  };

  let cursor: string | undefined;
  if (options.cursor !== undefined) {
    // The message never repeats what it was given.
    const unknown = "copyKvToD1 cursor is unknown or expired; start over, which is safe";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.cursor)) {
      throw new TypeError(unknown);
    }
    let stored: string | null;
    try {
      stored = await storage.get(kvCopyKeys.cursor(options.cursor));
    } catch (error) {
      throw new KvToD1CopyError(
        `Workers KV to D1 copy stopped: reading the resume point from D1 failed${errorClass(error)}`,
        options.cursor,
      );
    }
    if (stored === null) throw new TypeError(unknown);
    cursor = stored;
  }
  /** Retire the token this call resumed from; a stale one expires anyway. */
  const finish = async (result: KvToD1CopyResult) => {
    if (options.cursor !== undefined) {
      await storage.delete(kvCopyKeys.cursor(options.cursor)).catch(() => undefined);
    }
    return result;
  };

  let read = 0;
  for (;;) {
    // A page's starting cursor is the resume point for everything in it.
    const pageCursor = cursor;
    let page: Awaited<ReturnType<KVNamespaceBinding["list"]>>;
    try {
      page = await kv.list({
        limit: Math.min(KV_LIST_LIMIT, maxKeys - read),
        ...(cursor ? { cursor } : {}),
      });
    } catch (error) {
      throw new KvToD1CopyError(
        `Workers KV to D1 copy stopped: listing Workers KV failed${errorClass(error)}`,
        await resumePoint(pageCursor),
      );
    }
    read += page.keys.length;
    for (let start = 0; start < page.keys.length; start += COPY_GROUP_KEYS) {
      await copyGroup(page.keys.slice(start, start + COPY_GROUP_KEYS), pageCursor);
    }
    if (page.list_complete || !page.cursor) return finish({ done: true, families });
    cursor = page.cursor;
    if (read >= maxKeys) {
      let token: string;
      try {
        token = await remember(cursor);
      } catch (error) {
        throw new KvToD1CopyError(
          `Workers KV to D1 copy stopped: recording the resume point in D1 failed${errorClass(error)}`,
          options.cursor,
        );
      }
      return finish({ done: false, cursor: token, families });
    }
  }
}
