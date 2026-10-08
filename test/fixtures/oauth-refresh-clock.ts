import { expect, vi } from "vitest";
import { KvOAuthProvider, OAuthRefreshCoordinator } from "../../src/auth/downstream-oauth.js";
import type { KVStorage } from "../../src/types.js";
import { deferred } from "./misc.js";
import { seedGrant, storedGrant } from "./oauth.js";

/** Two SQL adapters share a database while their caller clocks disagree. */
export async function skewedRefresh(storage: KVStorage, contenderStorage: KVStorage): Promise<void> {
  const issuer = "https://issuer.example";
  const tokens = { access_token: "old", refresh_token: "old-refresh", token_type: "Bearer" };
  const rotated = { ...tokens, access_token: "new", refresh_token: "new-refresh" };
  await seedGrant(storage, { issuer, tokens });
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now - 300_000);
  const a = new OAuthRefreshCoordinator();
  const owner = new KvOAuthProvider("svc", storage, "https://connecta.test/callback", a, false);
  await owner.beginFlow(); await owner.tokens({ issuer });
  const entered = deferred<void>();
  const gate = deferred<void>();
  const send = vi.fn(async () => { entered.resolve(); await gate.promise; return Response.json(rotated); });
  const init = { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }) };
  const first = a.coordinatedFetch(owner, send)(`${issuer}/token`, init);
  await entered.promise;
  vi.spyOn(Date, "now").mockReturnValue(now + 300_000);
  const b = new OAuthRefreshCoordinator();
  const waiter = new KvOAuthProvider("svc", contenderStorage, "https://connecta.test/callback", b, false);
  await waiter.beginFlow(); await waiter.tokens({ issuer });
  const second = b.coordinatedFetch(waiter, send)(`${issuer}/token`, init);
  second.catch(() => {});
  try {
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(send).toHaveBeenCalledTimes(1);
    expect((await storedGrant(storage))!.body!.tokens).toEqual(tokens);
  } finally {
    gate.resolve();
  }
  await Promise.all([first, second]);
  expect(send).toHaveBeenCalledTimes(1);
  expect((await storedGrant(storage))!.body!.tokens).toMatchObject(rotated);
}
