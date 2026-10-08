// `@zackbart/connecta/sqlite`: connecta's storage on Node, in one SQLite file.
//
// Built on `node:sqlite` (Node 22.13 or later), so there is nothing to
// install. `sqliteStorage` is the deployment's `KVStorage` and
// `sqliteActivityStore` its activity history; both create their tables on
// first use. Node-only: nothing reachable from the root entry imports this.

import { chmodSync, closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ActivityStore } from "./activity.js";
import type { KVStorage } from "./types.js";
import { validateStorageKey } from "./storage/keys.js";
import {
  KV_SCHEMA,
  sqlActivityStore,
  type SqlActivityOptions,
  type SqlDriver,
  type SqlStatement,
  sqlStorage,
} from "./storage/sql.js";

export type SqliteActivityOptions = SqlActivityOptions;

/** A database path, or a `DatabaseSync` that `openSqlite` (or you) opened. */
export type SqliteDatabase = string | DatabaseSync;

/** Milliseconds a write waits for another process's write lock. */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * Open (creating if needed) a SQLite database for connecta. The directory is
 * created owner-only and the file is owner-only before SQLite first writes
 * it, because it holds downstream OAuth state and sealed credentials; SQLite
 * gives its `-wal` and `-shm` files the database file's mode. Write-ahead
 * logging lets activity reads proceed beside writes, and a busy timeout lets a
 * second process on the same file wait for a lock instead of failing.
 *
 * `":memory:"` opens a private in-memory database, for tests.
 */
export function openSqlite(path: string): DatabaseSync {
  if (path !== ":memory:") {
    path = resolve(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, "a", 0o600));
    try {
      chmodSync(path, 0o600);
    } catch {
      // Non-POSIX filesystem — leave the mode as it is.
    }
  }
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  return db;
}

const drivers = new WeakMap<DatabaseSync, SqlDriver>();

interface Positional {
  sync: StatementSync;
  /** For each `?` in order, the index of the parameter it binds. */
  order: number[];
}

/**
 * Prepare `text` with each numbered parameter `?N` as a plain `?`. Before
 * Node 22.20 and through at least 24.6, `node:sqlite` refuses any `?N` with
 * "column index out of range", and ./sql.ts binds by number so one value can
 * appear twice. Its statements hold no string literal containing `?`.
 */
function positional(db: DatabaseSync, text: string): Positional {
  const order: number[] = [];
  const sync = db.prepare(text.replace(/\?(\d+)/g, (_, number: string) => {
    order.push(Number(number) - 1);
    return "?";
  }));
  return { sync, order };
}

function sqliteDriver(database: SqliteDatabase): SqlDriver {
  const db = typeof database === "string" ? openSqlite(database) : database;
  const existing = drivers.get(db);
  if (existing) return existing;
  // The statement set is the fixed SQL in ./sql.ts, so the cache is bounded.
  const statements = new Map<string, Positional>();
  const prepare = (statement: SqlStatement) => {
    let prepared = statements.get(statement.sql);
    if (!prepared) {
      prepared = positional(db, statement.sql);
      statements.set(statement.sql, prepared);
    }
    return {
      sync: prepared.sync,
      params: prepared.order.map((index) =>
        statement.params[index] as SqlStatement["params"][number]),
    };
  };
  const run = (statement: SqlStatement) => {
    const { sync, params } = prepare(statement);
    return Number(sync.run(...params).changes);
  };
  const driver: SqlDriver = {
    async all<Row>(statement: SqlStatement) {
      const { sync, params } = prepare(statement);
      return sync.all(...params) as Row[];
    },
    async run(statement) {
      return run(statement);
    },
    async batch(batch) {
      // Synchronous from BEGIN to COMMIT: no other call on this connection
      // can interleave, and IMMEDIATE takes the write lock up front so
      // another process cannot either.
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of batch) run(statement);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  drivers.set(db, driver);
  return driver;
}

/**
 * `KVStorage` in a SQLite file, with the atomic `compareAndSet` every
 * subsystem relies on. Each write commits one row; nothing rewrites the file.
 */
export function sqliteStorage(database: SqliteDatabase): KVStorage {
  return sqlStorage(sqliteDriver(database));
}

/**
 * Payload-free activity history in the same SQLite file, for
 * `activityHistory({ store })`. Each write prunes a bounded batch of rows
 * older than `retentionDays`.
 */
export function sqliteActivityStore(
  database: SqliteDatabase,
  options?: SqliteActivityOptions,
): ActivityStore {
  return sqlActivityStore(sqliteDriver(database), options);
}

export interface StateFileImport {
  /** Entries copied into the database. */
  imported: number;
  /** Entries left alone because the database already held their key. */
  kept: number;
  /** Entries whose TTL had already passed. */
  expired: number;
}

/**
 * One-shot migration from the 0.28 `fileStorage` JSON state file: copy every
 * live entry, with its expiry, into the database's key-value table. Run it
 * once, with the old deployment stopped, before the first start on SQLite.
 *
 * Keys the database already holds are kept, so a second run copies nothing
 * twice and never overwrites state written since. The file is read, never
 * changed; delete it once the deployment is verified. A file that is not a
 * state file throws before anything is written.
 */
export function importStateFile(
  database: SqliteDatabase,
  statePath: string,
  now: number = Date.now(),
): StateFileImport {
  const loaded = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
  if (loaded === null || typeof loaded !== "object" || Array.isArray(loaded)) {
    throw new TypeError(`${statePath} is not a connecta state file`);
  }
  const entries = Object.entries(loaded as Record<string, unknown>);
  for (const [key, entry] of entries) {
    validateStorageKey(key);
    const valid = entry !== null && typeof entry === "object" &&
      typeof (entry as { value?: unknown }).value === "string" &&
      (!("exp" in entry) || Number.isFinite((entry as { exp?: unknown }).exp));
    if (!valid) {
      throw new TypeError(
        `${statePath} is not a connecta state file: entry ${JSON.stringify(key)} has no string value`,
      );
    }
  }
  const db = typeof database === "string" ? openSqlite(database) : database;
  const result: StateFileImport = { imported: 0, kept: 0, expired: 0 };
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of KV_SCHEMA) db.exec(statement);
    const insert = db.prepare(
      `INSERT INTO connecta_kv (key, value, expires_at_ms) VALUES (?, ?, ?)
       ON CONFLICT (key) DO NOTHING`,
    );
    for (const [key, entry] of entries) {
      const { value, exp } = entry as { value: string; exp?: number };
      if (exp !== undefined && exp <= now) {
        result.expired += 1;
        continue;
      }
      if (Number(insert.run(key, value, exp === undefined ? null : Math.ceil(exp)).changes) > 0) {
        result.imported += 1;
      } else {
        result.kept += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return result;
}
