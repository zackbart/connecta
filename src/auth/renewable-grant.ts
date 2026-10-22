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
