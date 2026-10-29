/**
 * Eval-only D1 round-trip latency for local workerd, where D1 is an in-process
 * SQLite file. Each round trip waits `ms` before it runs: a statement's
 * `all`/`run`/`first`/`raw`, an `exec`, or a whole `batch` (one round trip
 * carrying several statements, as on the edge).
 */
const ROUND_TRIPS = new Set(["all", "run", "first", "raw"]);
const INNER = Symbol("inner statement");

export function withD1Latency(db: D1Database, ms: number): D1Database {
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const statement = (inner: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(inner, {
      get(target, property) {
        if (property === INNER) return target;
        if (property === "bind") return (...values: unknown[]) => statement(target.bind(...values));
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof property === "string" && ROUND_TRIPS.has(property) && typeof value === "function")
          return async (...args: unknown[]) => {
            await wait();
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (query: string) => statement(target.prepare(query));
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          await wait();
          return target.batch(
            statements.map((item) => (item as unknown as Record<symbol, D1PreparedStatement>)[INNER] ?? item),
          );
        };
      if (property === "exec")
        return async (query: string) => {
          await wait();
          return target.exec(query);
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
