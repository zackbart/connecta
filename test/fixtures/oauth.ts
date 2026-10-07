import { encryptedCredentialVault } from "../../src/credentials.js";
import { identityStorageKey } from "../../src/identity.js";
import { fakeClerkAuth } from "./http.js";
import { BASE, CLERK_OPTIONS, CREDENTIAL_KEY } from "./ui.js";
import type { KVStorage } from "../../src/types.js";
import type { Connecta } from "../../src/index.js";

export const oauthVault = (storage: KVStorage) => encryptedCredentialVault(storage, CREDENTIAL_KEY);

/** A verified browser session for tests of the callback's downstream behavior. */
export const callbackAuth = {
  ...fakeClerkAuth(CLERK_OPTIONS),
  authorize: async () => ({ ok: true as const, userId: CLERK_OPTIONS.userId }),
};

export async function bindCallback(app: Connecta, id: string, state: string): Promise<void> {
  await app.registry.storeOAuthHandoff(id, state, await identityStorageKey({ namespace: CLERK_OPTIONS.frontendApiUrl, id: CLERK_OPTIONS.userId }));
}

/** Visit the browser handoff returned by a tool or UI action. */
async function visitConnect(app: Connecta, authorizationUrl: string, init: RequestInit = {}): Promise<Response> {
  return app.fetch(new Request(authorizationUrl, { ...init, method: "GET", headers: { Authorization: `Bearer ${CLERK_OPTIONS.token}`, ...Object.fromEntries(new Headers(init.headers)) } }));
}

/** Exercise the UI's POST followed by the verified browser's /connect visit. */
export async function connectRequest(app: Connecta, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await app.fetch(new Request(`${BASE}${path}`, { ...init, method: "POST", headers: { Authorization: `Bearer ${CLERK_OPTIONS.token}`, Origin: BASE, ...Object.fromEntries(new Headers(init.headers)) } }));
  if (response.status !== 200) return response;
  const { authorizationUrl } = await response.json() as { authorizationUrl: string };
  return visitConnect(app, authorizationUrl, init);
}
