// Native SQL execution, private to the /d1 and /sqlite import graphs.
// The D1 Connection deliberately uses the public binding's run/batch metadata:
// @effect/sql-d1 4.0.5 discards batch meta.changes and requires a wider binding.
// Keeping a small Connection here preserves both exact counts and structural
// compatibility without RETURNING payloads, extra statements, or a new peer.
import { Effect } from "effect";
import type { Connection } from "effect/sql/SqlConnection";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";
import { runEdge } from "../runtime/run.js";
import type { SqlDriver, SqlStatement } from "./sql.js";

export interface NativeSqlDriver {
  all<Row>(statement: SqlStatement): Effect.Effect<Row[], unknown>;
  run(statement: SqlStatement): Effect.Effect<number, unknown>;
  /** One native atomic batch, never a loop of independently committed Effects. */
  batch(statements: readonly SqlStatement[]): Effect.Effect<number[], unknown>;
}

// SQL errors carry no driver cause or parameters, even inside tracing. Recover
// the original thrown object only at the private SQL boundary, as before.
const causes = new WeakMap<SqlError, unknown>();
function sqlError(cause: unknown): SqlError {
  const error = new SqlError({ reason: new UnknownError({ cause: undefined, message: "SQL operation failed" }) });
  causes.set(error, cause);
  return error;
}
const original = (error: SqlError): unknown => (causes.has(error) ? causes.get(error) : error);

export function sqlSync<A>(operation: () => A): Effect.Effect<A, SqlError> {
  return Effect.try({ try: operation, catch: sqlError });
}

/** Exactly one SDK/platform Promise leaf; no retries or shared flights. */
export function sqlPromise<A>(operation: () => Promise<A>): Effect.Effect<A, SqlError> {
  return Effect.tryPromise({ try: operation, catch: sqlError });
}

/**
 * effect/sql owns statement compilation and connection execution. Native batch
 * is a separate driver capability: D1 cannot use withTransaction; SQLite must
 * keep BEGIN IMMEDIATE through COMMIT synchronous on the shared DatabaseSync.
 * Compilation and execution happen inside the operation. Only Node's
 * prepared-statement cache and the deployment database outlive a call.
 */
export function effectSqlDriver(leaves: {
  all(statement: SqlStatement): Effect.Effect<unknown[], SqlError>;
  run(statement: SqlStatement): Effect.Effect<number, SqlError>;
  batch(statements: readonly SqlStatement[]): Effect.Effect<number[], SqlError>;
}): NativeSqlDriver {
  const input = (sql: string, params: readonly unknown[]): SqlStatement => ({
    sql,
    params: params as SqlStatement["params"],
  });
  // Fixed statements return raw rows; no caller requests row transformation.
  const connection = {
    execute: (sql: string, params: readonly unknown[]) => leaves.all(input(sql, params)),
    executeRaw: (sql: string, params: readonly unknown[]) => leaves.run(input(sql, params)),
  } satisfies Pick<Connection, "execute" | "executeRaw">;
  // These programs need fixed SQL, row reads, exact write metadata and atomic
  // batches. Use the public compiler/Connection execution API directly rather
  // than adding SqlClient's reactive queries, streams or transaction scopes.
  const compiler = Statement.makeCompilerSqlite();
  const compile = (statement: SqlStatement): SqlStatement => {
    const [sql, params] = compiler.compile(
      Statement.fragment([Statement.literal(statement.sql, statement.params)]),
      false,
    );
    return input(sql, params);
  };
  const protect = <A>(effect: Effect.Effect<A, SqlError>): Effect.Effect<A, unknown> =>
    // Let the Promise edge install its abort listener before a synchronous
    // SQLite leaf can commit. This boundary stays outside the atomic batch.
    Effect.andThen(Effect.yieldNow, effect).pipe(Effect.mapError(original), Effect.withTracerEnabled(false));
  return {
    all: <Row>(statement: SqlStatement) =>
      protect(
        Effect.suspend(() => {
          const { sql, params } = compile(statement);
          return connection.execute(sql, params) as Effect.Effect<Row[], SqlError>;
        }),
      ),
    run: (statement) =>
      protect(
        Effect.suspend(() => {
          const { sql, params } = compile(statement);
          return connection.executeRaw(sql, params);
        }),
      ),
    batch: (statements) => protect(Effect.suspend(() => leaves.batch(statements.map(compile)))),
  };
}

const natives = new WeakMap<SqlDriver, NativeSqlDriver>();

/** Promise compatibility view, including private adapter characterization. */
export function sqlDriverEdge(native: NativeSqlDriver): SqlDriver {
  const driver: SqlDriver = {
    all: (statement) => runEdge(native.all(statement)),
    run: (statement) => runEdge(native.run(statement)),
    batch: (statements) => runEdge(native.batch(statements)),
  };
  natives.set(driver, native);
  return driver;
}

/** Custom/private Promise drivers retain their original fallback behavior. */
export function nativeSqlDriver(driver: SqlDriver): NativeSqlDriver {
  return (
    natives.get(driver) ?? {
      all: <Row>(statement: SqlStatement) =>
        Effect.tryPromise({ try: () => Promise.resolve(driver.all<Row>(statement)), catch: (e) => e }),
      run: (statement) => Effect.tryPromise({ try: () => Promise.resolve(driver.run(statement)), catch: (e) => e }),
      batch: (statements) =>
        Effect.tryPromise({ try: () => Promise.resolve(driver.batch(statements)), catch: (e) => e }),
    }
  );
}
