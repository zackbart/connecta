import { hasMethodOverride } from "../provider-call.js";

/** Internal Promise contract; the public OAuth facade continues to expose only fetch. */
export interface RenewableGrant {
  readonly token: () => Promise<string>;
  readonly refresh: (stale: string) => Promise<string>;
  readonly rejected: () => Promise<never>;
}

const grants = new WeakMap<object, RenewableGrant>();

/** The raw OAuth facade has no provider response ceiling; bound discarded 401 challenges independently. */
export const OAUTH_CHALLENGE_MAX_BYTES = 1024 * 1024;

export function bindRenewableGrant<A extends object>(facade: A, grant: RenewableGrant): A {
  grants.set(facade, grant);
  return facade;
}

export function renewableGrantFor(facade: object): RenewableGrant | undefined {
  return grants.get(facade);
}

/** Both transports renew once, but only a read may replay its resource request. */
export function replayAfterUnauthorized(
  classification: "read" | "write",
  effect: "call" | "read",
  headers: HeadersInit,
): boolean {
  // Overrides can turn even a nominal auxiliary read into a write.
  return !hasMethodOverride(headers) && (effect === "read" || classification === "read");
}
