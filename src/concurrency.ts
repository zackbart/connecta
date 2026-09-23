import { Effect } from "effect";
import { runEdge } from "./runtime/run.js";

const DEFAULT_DISCOVERY_CONCURRENCY = 4;

export function resolveDiscoveryConcurrency(
  value: number | undefined,
): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_DISCOVERY_CONCURRENCY;
}

/**
 * Run `fn` over `items` with at most `limit` operations in flight, settling
 * every one: a rejection lands in its slot instead of cancelling the rest.
 * Results keep input order whatever order the work finishes in. A limit below
 * one runs the items one at a time.
 */
export function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return runEdge(
    Effect.forEach(
      items,
      (item, index) =>
        Effect.tryPromise({
          // Promise.resolve keeps a non-promise return from `fn` working, as
          // `await` did; a synchronous throw is caught either way.
          try: () => Promise.resolve(fn(item, index)),
          catch: (reason) => reason,
        }).pipe(
          Effect.match({
            onSuccess: (value): PromiseSettledResult<R> => ({
              status: "fulfilled",
              value,
            }),
            onFailure: (reason): PromiseSettledResult<R> => ({
              status: "rejected",
              reason,
            }),
          }),
        ),
      { concurrency: limit >= 1 ? Math.floor(limit) : 1 },
    ),
  );
}
