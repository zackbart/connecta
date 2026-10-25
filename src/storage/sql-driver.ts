// Native SQL service, private to the /d1 and /sqlite import graphs.
// SqlClient services and Statement operations execute reads and writes. Atomic
// batches retain the public platform metadata and structural D1 compatibility.
import { Effect, Stream } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Reactivity from "effect/reactivity/Reactivity";
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
 * A request-local public SqlClient service executes actual Statement Effects.
 * Native batches are deliberately separate: D1 cannot use withTransaction and
 * SQLite must not yield between BEGIN IMMEDIATE and COMMIT. The deployment
 * owns the database; the service owns no platform connection or cached I/O.
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
  const execute: Connection["execute"] = (sql, params, transform) =>
    leaves.all(input(sql, params)).pipe(Effect.map((rows) => (transform ? transform(rows as object[]) : rows)));
  const values: Connection["executeValues"] = (sql, params) =>
    leaves.all(input(sql, params)).pipe(Effect.map((rows) => rows.map((row) => Object.values(row as object))));
  const connection: Connection = {
    execute,
    executeRaw: (sql, params) => leaves.run(input(sql, params)),
    executeUnprepared: execute,
    executeValues: values,
    executeValuesUnprepared: values,
    executeStream: () => Stream.fail(sqlError(new Error("SQL streaming is not supported"))),
  };
  // This Effect constructs a fresh client and its services inside every
  // operation. No request-owned object, scope or promise is memoized here.
  const client = SqlClient.make({
    acquirer: Effect.succeed(connection),
    borrower: (use) => use(connection),
    transactionAcquirer: Effect.fail(sqlError(new Error("Use an atomic SQL batch"))),
    compiler: Statement.makeCompilerSqlite(),
    spanAttributes: [],
  }).pipe(Effect.provideServiceEffect(Reactivity.Reactivity, Reactivity.make));
  const protect = <A>(effect: Effect.Effect<A, SqlError>): Effect.Effect<A, unknown> =>
    // The yield precedes physical execution, never an atomic transaction.
    // Statement execution creates SQL spans; disable tracing before it starts,
    // and unwrap only after the private SQL operation has completed.
    Effect.andThen(Effect.yieldNow, effect).pipe(
      Effect.withTracerEnabled(false),
      Effect.mapError(original),
      Effect.catchDefect((error) => Effect.fail(error)),
    );
  const operation = <A>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, SqlError>) =>
    protect(SqlClient.SqlClient.use(use).pipe(Effect.provideServiceEffect(SqlClient.SqlClient, client)));
  return {
    all: <Row>(statement: SqlStatement) =>
      operation((sql) => Effect.map(sql.unsafe(statement.sql, statement.params), (rows) => rows as Row[])),
    run: (statement) =>
      operation((sql) => sql.unsafe(statement.sql, statement.params).raw as Effect.Effect<number, SqlError>),
    // One native transaction returns exact per-statement metadata. This
    // capability is not SqlClient.withTransaction, which D1 does not support.
    batch: (statements) => protect(Effect.suspend(() => leaves.batch(statements))),
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
