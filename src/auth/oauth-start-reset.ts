// The operator route must not answer while a storage reset it started can
// still publish an older generation. Storage has no cancellation contract.
const startResets = new WeakMap<object, Set<Promise<void>>>();

export function trackOAuthStartReset(scope: object, reset: Promise<void>): void {
  let pending = startResets.get(scope);
  if (!pending) {
    pending = new Set();
    startResets.set(scope, pending);
  }
  pending.add(reset);
  // Both outcomes have an observer, so a rejected reset never creates an
  // unhandled rejection merely because its caller timed out first.
  void reset.then(
    () => pending.delete(reset),
    () => pending.delete(reset),
  );
}

export async function drainOAuthStartResets(scope: object): Promise<void> {
  const pending = startResets.get(scope);
  while (pending && pending.size > 0) {
    await Promise.allSettled(pending);
  }
}
