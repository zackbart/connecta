import { Effect, Option } from "effect";
import { RequestScope } from "../runtime/request-scope.js";
import { hasTimingTraces, traceFor, type TimingFamily } from "../timing-trace.js";
import { utf8Length } from "../bytes.js";

function timedD1<A, E>(family: TimingFamily, statements: number, operation: Effect.Effect<A, E>): Effect.Effect<A, E> {
  return Effect.suspend(() => {
    if (!hasTimingTraces()) return operation;
    return Effect.flatMap(Effect.serviceOption(RequestScope), (owner) => {
      const trace = Option.isSome(owner) ? traceFor(owner.value.identity) : undefined;
      if (!trace) return operation;
      const start = performance.now();
      let bytes = 0;
      return operation.pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            // Count serialized application result bytes, not D1 wire bytes.
            try {
              bytes = utf8Length(JSON.stringify(value) ?? "");
            } catch {
              /* no payload retained */
            }
          }),
        ),
        Effect.ensuring(Effect.sync(() => trace.record(family, performance.now() - start, bytes, statements))),
      );
    });
  });
}
import { effectSqlDriver, sqlDriverEdge, sqlPromise } from "./sql-driver.js";
import type { SqlDriver, SqlStatement } from "./sql.js";
import type { D1DatabaseBinding } from "../d1.js";

export function d1Driver(db: D1DatabaseBinding): SqlDriver {
  const prepare = (statement: SqlStatement) =>
    statement.params.length > 0 ? db.prepare(statement.sql).bind(...statement.params) : db.prepare(statement.sql);
  return sqlDriverEdge(
    effectSqlDriver({
      all: (statement) =>
        timedD1(
          "d1.read",
          1,
          sqlPromise(() =>
            prepare(statement)
              .all()
              .then((result) => result.results),
          ),
        ),
      run: (statement) =>
        timedD1(
          "d1.write",
          1,
          sqlPromise(() =>
            prepare(statement)
              .run()
              .then((result) => result.meta.changes ?? 0),
          ),
        ),
      // D1's public binding API preserves per-statement changes, including zero;
      // execute the whole array once. No withTransaction, RETURNING, or replay.
      batch: (statements) =>
        timedD1(
          "d1.batch",
          statements.length,
          sqlPromise(() =>
            db.batch(statements.map(prepare)).then((results) => results.map((result) => result.meta.changes ?? 0)),
          ),
        ),
    }),
  );
}
