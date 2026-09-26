// The operator route must not answer while a storage reset it started can
// still publish an older generation. Storage has no cancellation contract.
const startResets = new WeakMap<object, Promise<void>>();

export function trackOAuthStartReset(scope: object, reset: Promise<void>): void {
  startResets.set(scope, reset);
}

export function oauthStartReset(scope: object): Promise<void> | undefined {
  return startResets.get(scope);
}
