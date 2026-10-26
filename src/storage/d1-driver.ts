import { effectSqlDriver, sqlDriverEdge, sqlPromise } from "./sql-driver.js";
import type { SqlDriver, SqlStatement } from "./sql.js";
import type { D1DatabaseBinding } from "../d1.js";

export function d1Driver(db: D1DatabaseBinding): SqlDriver {
  const prepare = (statement: SqlStatement) =>
    statement.params.length > 0 ? db.prepare(statement.sql).bind(...statement.params) : db.prepare(statement.sql);
  return sqlDriverEdge(
    effectSqlDriver({
      all: (statement) =>
        sqlPromise(() =>
          prepare(statement)
            .all()
            .then((result) => result.results),
        ),
      run: (statement) =>
        sqlPromise(() =>
          prepare(statement)
            .run()
            .then((result) => result.meta.changes ?? 0),
        ),
      // D1's public binding API preserves per-statement changes, including zero;
      // execute the whole array once. No withTransaction, RETURNING, or replay.
      batch: (statements) =>
        sqlPromise(() =>
          db.batch(statements.map(prepare)).then((results) => results.map((result) => result.meta.changes ?? 0)),
        ),
    }),
  );
}
