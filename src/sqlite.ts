// `@zackbart/connecta/sqlite`: connecta's storage on Node, in one SQLite file.
//
// Built on `node:sqlite` (Node 22.13 or later), so there is nothing to
// install. `sqliteStorage` is the deployment's `KVStorage` and
// `sqliteActivityStore` its activity history; both create their tables on
// first use. Node-only: nothing reachable from the root entry imports this.

import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { effectSqlDriver, sqlDriverEdge, sqlSync } from "./storage/sql-driver.js";
import type { ActivityStore } from "./activity.js";
import type { KVStorage } from "./types.js";
import {
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

function sqliteDriver(database: SqliteDatabase): SqlDriver {
  const db = typeof database === "string" ? openSqlite(database) : database;
  const existing = drivers.get(db);
  if (existing) return existing;
  // The statement set is the fixed SQL in ./sql.ts, so the cache is bounded.
  const statements = new Map<string, StatementSync>();
  const prepare = (statement: SqlStatement) => {
    let prepared = statements.get(statement.sql);
    if (!prepared) {
      prepared = db.prepare(statement.sql);
      statements.set(statement.sql, prepared);
    }
    return prepared;
  };
  const run = (statement: SqlStatement) => {
    return Number(prepare(statement).run(...statement.params).changes);
  };
  const driver = sqlDriverEdge(
    effectSqlDriver({
      all: (statement) => sqlSync(() => prepare(statement).all(...statement.params)),
      run: (statement) => sqlSync(() => run(statement)),
      batch: (batch) =>
        sqlSync(() => {
          // One synchronous native leaf: no fiber can yield between BEGIN and
          // COMMIT and let another caller interleave on this DatabaseSync.
          db.exec("BEGIN IMMEDIATE");
          try {
            const changes = batch.map(run);
            db.exec("COMMIT");
            return changes;
          } catch (error) {
            try {
              db.exec("ROLLBACK");
            } catch {
              /* Preserve the original failure. */
            }
            throw error;
          }
        }),
    }),
  );
  drivers.set(db, driver);
  return driver;
}

/**
 * `KVStorage` in a SQLite file, with the atomic `compareAndSet` every
 * subsystem relies on. Each write commits one row; nothing rewrites the file.
 */
export function sqliteStorage(database: SqliteDatabase): KVStorage {
  return sqlStorage(sqliteDriver(database), "sqlite");
}

/**
 * Payload-free activity history in the same SQLite file, for
 * `activityHistory({ store })`. Each write prunes a bounded batch of rows
 * older than `retentionDays`.
 */
export function sqliteActivityStore(database: SqliteDatabase, options?: SqliteActivityOptions): ActivityStore {
  return sqlActivityStore(sqliteDriver(database), "sqlite", options);
}
