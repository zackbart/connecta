// `@zackbart/connecta/d1`: connecta's storage on Cloudflare Workers.
//
// One D1 database holds everything: `d1Storage(db)` is the deployment's
// `KVStorage`, and `d1ActivityStore(db)` its activity history. Both create
// their tables on first use, so binding the database is the whole setup.

import type { ActivityStore } from "./activity.js";
import type { KVStorage } from "./types.js";
import {
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
  batch(statements: D1StatementBinding[]): Promise<unknown[]>;
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
      await db.batch(statements.map(prepare));
    },
  };
}

/**
 * `KVStorage` over a D1 database, with the atomic `compareAndSet` every
 * subsystem relies on. The `connecta_kv` table is created on first use; a
 * database that already holds the 0.28 example's table is read as is.
 */
export function d1Storage(db: D1DatabaseBinding): KVStorage {
  return sqlStorage(d1Driver(db));
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
  return sqlActivityStore(d1Driver(db), options);
}
