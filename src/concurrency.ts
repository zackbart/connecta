const DEFAULT_DISCOVERY_CONCURRENCY = 4;

export function resolveDiscoveryConcurrency(
  value: number | undefined,
): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_DISCOVERY_CONCURRENCY;
}

/** Run `fn` over `items` with at most `limit` operations in flight. */
export async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const settled = Array<PromiseSettledResult<R>>(items.length);
  const remaining = items.entries();
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const next = remaining.next();
        if (next.done) return;
        const [index, item] = next.value;
        try {
          settled[index] = {
            status: "fulfilled",
            value: await fn(item, index),
          };
        } catch (reason) {
          settled[index] = { status: "rejected", reason };
        }
      }
    },
  );
  await Promise.all(workers);
  return settled;
}
