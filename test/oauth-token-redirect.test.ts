import { describe, expect, inject, it, onTestFinished } from "vitest";
import { KvOAuthProvider, OAuthRefreshCoordinator, oauthStateDigest } from "../src/auth/downstream-oauth.js";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { classifyCallError } from "../src/errors.js";
import { oauthRefreshSpentKeys } from "../src/storage/keys.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { KVStorage } from "../src/types.js";
import { connectorContext } from "./fixtures/misc.js";
import { seedGrant, storedGrant } from "./fixtures/oauth.js";

const tokens = { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer" };
const scope = (storage: KVStorage) => ({ ...connectorContext(storage), requestScope: {} });
function store(delayed: boolean): KVStorage {
  const backing = memoryStorage();
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const hop = <Args extends unknown[], R>(op: (...args: Args) => Promise<R>) => async (...args: Args): Promise<R> => {
    if (delayed) await pause();
    const result = await op(...args);
    if (delayed) await pause();
    return result;
  };
  return { get: hop(backing.get), set: hop(backing.set), delete: hop(backing.delete), list: hop(backing.list), compareAndSet: hop(backing.compareAndSet) };
}
async function server(status: number) {
  const base = inject("oauthHttpServer");
  const { id } = await (await fetch(`${base}/new`, { method: "POST", body: `sdk-redirect-${status}` })).json() as { id: string };
  const issuer = `${base}/session/${id}`;
  onTestFinished(async () => { await fetch(`${issuer}/finish`, { method: "POST" }); });
  return {
    issuer,
    success: async () => { await fetch(`${issuer}/mode`, { method: "POST", body: "sdk-success" }); },
    sent: async () => (await (await fetch(issuer)).json() as { requests: Array<{ path: string; grant: string | null; credential: string | null }> }).requests,
  };
}
async function adapter(kind: "remoteMcp" | "api", issuer: string, storage: KVStorage, seed = true) {
  const connector = kind === "remoteMcp"
    ? remoteMcp("svc", { url: `${issuer}/mcp`, auth: { type: "oauth" }, redirects: "same-origin", versionNegotiation: "legacy" })
    : api("svc", {
      oauth: { authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`, clientId: "native-client", apiOrigins: [new URL(issuer).origin] },
      tools: [{ name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: async (_args, ctx) => (await ctx.oauth!.fetch(`${issuer}/api`)).json() }],
    });
  if (seed) await seedGrant(storage, {
    issuer: kind === "remoteMcp" ? issuer : `${issuer}/token`, tokens,
    ...(kind === "remoteMcp" ? { client: { value: { client_id: "native-client", redirect_uris: ["https://connecta.test/oauth/callback/svc"], token_endpoint_auth_method: "none" } } } : {}),
  });
  const contexts: ReturnType<typeof scope>[] = [];
  const context = () => { const ctx = scope(storage); contexts.push(ctx); return ctx; };
  onTestFinished(async () => { for (const ctx of contexts) await connector.closeScope?.(ctx); });
  return {
    connector, context,
    read: () => kind === "remoteMcp" ? connector.listTools(context()) : connector.callTool("read", {}, context()),
    exchange: async () => {
      const started = await connector.startAuth!(context(), { force: true });
      expect(started.state).toBe("auth_required");
      const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
      const ctx = context();
      expect(await connector.verifyState!(state, ctx)).toBe(true);
      return connector.finishAuth!("native-code", ctx, new URLSearchParams({ code: "native-code", state }));
    },
  };
}

describe.each([["memory", false], ["delayed", true]] as const)("native SDK token redirects on %s storage", (_label, delayed) => {
  describe.each(["remoteMcp", "api"] as const)("%s", (kind) => {
    it.each([307, 308])("requires re-consent after HTTP %s refresh with one send and no follow (INV-5) (INV-9)", async (status) => {
      const endpoint = await server(status);
      const storage = store(delayed);
      const a = await adapter(kind, endpoint.issuer, storage);
      const oldEpoch = (await storedGrant(storage))!.epoch;
      await expect(a.read()).rejects.toSatisfy((error: unknown) => classifyCallError(error).code === "auth_required");
      expect((await storedGrant(storage))!.body?.tokens).toBeUndefined();
      const spentKey = oauthRefreshSpentKeys.spent(oldEpoch, await oauthStateDigest(tokens.refresh_token));
      expect(await storage.get(spentKey)).not.toBeNull();
      for (let attempt = 0; attempt < 3; attempt++) {
        // Even after the lease is removed, a same-epoch stale grant cannot resend.
        if (attempt) await a.connector.disconnectAuth!(a.context());
        await seedGrant(storage, { issuer: kind === "remoteMcp" ? endpoint.issuer : `${endpoint.issuer}/token`, tokens,
          ...(kind === "remoteMcp" ? { client: { value: { client_id: "native-client", token_endpoint_auth_method: "none" } } } : {}),
        }, oldEpoch);
        const newcomer = await adapter(kind, endpoint.issuer, storage, false);
        await expect(newcomer.read()).rejects.toSatisfy((error: unknown) => classifyCallError(error).code === "auth_required");
        expect(await storage.get(spentKey)).not.toBeNull();
      }
      expect(await endpoint.sent()).toEqual([{ path: "token", grant: "refresh_token", credential: "old-refresh" }]);
    });

    it.each([307, 308])("refuses HTTP %s code exchange without following or retrying the form (INV-5) (INV-9)", async (status) => {
      const endpoint = await server(status);
      const storage = store(delayed);
      const a = await adapter(kind, endpoint.issuer, storage, false);
      await expect(a.exchange()).rejects.toBeInstanceOf(Error);
      expect((await storedGrant(storage))!.body?.tokens).toBeUndefined();
      expect(await endpoint.sent()).toEqual([{ path: "token", grant: "authorization_code", credential: "native-code" }]);
    });

    it.each([307, 308])("allows an identical refresh token after new-epoch re-consent following HTTP %s (INV-5)", async (status) => {
      const endpoint = await server(status);
      const storage = store(delayed);
      const a = await adapter(kind, endpoint.issuer, storage);
      const oldEpoch = (await storedGrant(storage))!.epoch;
      await expect(a.read()).rejects.toBeInstanceOf(Error);
      const oldKey = oauthRefreshSpentKeys.spent(oldEpoch, await oauthStateDigest(tokens.refresh_token));
      const spent = await storage.get(oldKey);
      expect(spent).not.toBeNull();
      await endpoint.success();
      await a.exchange();
      const grant = (await storedGrant(storage))!;
      expect(grant.epoch).not.toBe(oldEpoch);
      expect(grant.body!.tokens!.refresh_token).toBe(tokens.refresh_token);
      const fresh = await adapter(kind, endpoint.issuer, storage, false);
      await fresh.read();
      expect((await storedGrant(storage))!.body!.tokens).toMatchObject({ access_token: "new-access", refresh_token: "new-refresh" });
      expect(await storage.get(oldKey)).toBe(spent);
      expect(await storage.get(oauthRefreshSpentKeys.spent(grant.epoch, await oauthStateDigest(tokens.refresh_token)))).not.toBeNull();
      expect(await endpoint.sent()).toEqual([
        { path: "token", grant: "refresh_token", credential: "old-refresh" },
        { path: "token", grant: "authorization_code", credential: "native-code" },
        { path: "token", grant: "refresh_token", credential: "old-refresh" },
      ]);
    });
  });
});

it.each([307, 308])("never follows HTTP %s for client credentials or token revocation (INV-5) (INV-9)", async (status) => {
  for (const body of [new URLSearchParams({ grant_type: "client_credentials", client_secret: "client-secret" }), "token=revoked-token&token_type_hint=refresh_token"]) {
    const endpoint = await server(status);
    const provider = new KvOAuthProvider("svc", memoryStorage(), "https://connecta.test/oauth/callback/svc");
    const resourceFetch = () => { throw new Error("credential request reached redirect-following resource path"); };
    const response = await new OAuthRefreshCoordinator().coordinatedFetch(provider, fetch, undefined, undefined, resourceFetch)(`${endpoint.issuer}/token`, { method: "POST", body, redirect: "follow" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect((await endpoint.sent()).map((request) => request.path)).toEqual(["token"]);
  }
});
