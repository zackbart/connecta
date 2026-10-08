import type { ConnectorContext } from "./types.js";

// Registry-owned identity for downstream credential coordination. Storage
// wrappers are rebuilt per context, and epochs can be identical across owners.
// Keep this beside the context rather than widening the public connector API.
const partitions = new WeakMap<ConnectorContext, object>();
const activeWork = new WeakMap<object, number>();

export function retainOAuthPartition(partition: object | undefined): () => void {
  if (!partition) return () => {};
  activeWork.set(partition, (activeWork.get(partition) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeWork.get(partition) ?? 1) - 1;
    if (remaining === 0) activeWork.delete(partition);
    else activeWork.set(partition, remaining);
  };
}

/**
 * Wrap one connector operation so its owner partition stays pinned from the
 * first asynchronous storage read to the end, not only once a refresh flight
 * exists: an idle personal registry can otherwise be evicted mid-flow. Status
 * and auth operations take no call admission, so nothing else holds it.
 */
export function retainingOAuthPartition<Args extends unknown[], Result>(
  operation: (...args: Args) => Promise<Result>,
  contextIndex: number,
): (...args: Args) => Promise<Result> {
  return async (...args: Args): Promise<Result> => {
    const release = retainOAuthPartition(oauthPartitionFor(args[contextIndex] as ConnectorContext));
    try {
      return await operation(...args);
    } finally {
      release();
    }
  };
}

export function oauthPartitionIdle(partition: object): boolean {
  return !activeWork.has(partition);
}

export function attachOAuthPartition(ctx: ConnectorContext, partition: object | undefined): ConnectorContext {
  if (partition) partitions.set(ctx, partition);
  return ctx;
}

export function oauthPartitionFor(ctx: ConnectorContext): object | undefined {
  return partitions.get(ctx);
}
