import { expect, inject, onTestFinished } from "vitest";
import { api } from "../../src/connectors/api.js";
import { remoteMcp } from "../../src/connectors/remote-mcp.js";
import { memoryStorage } from "../../src/storage/memory.js";
import type { KVStorage } from "../../src/types.js";
import { connectorContext } from "./misc.js";
import { seedGrant } from "./oauth.js";

export const tokens = { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer" };
const scope = (storage: KVStorage) => ({ ...connectorContext(storage), requestScope: {} });
export function store(delayed: boolean): KVStorage {
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
export async function nativeOAuthServer(mode: string) {
  const base = inject("oauthHttpServer");
  const { id } = await (await fetch(`${base}/new`, { method: "POST", body: mode })).json() as { id: string };
  const issuer = `${base}/session/${id}`;
  onTestFinished(async () => { await fetch(`${issuer}/finish`, { method: "POST" }); });
  return {
    issuer,
    mode: async (mode: string) => { await fetch(`${issuer}/mode`, { method: "POST", body: mode }); },
    success: async () => { await fetch(`${issuer}/mode`, { method: "POST", body: "sdk-success" }); },
    finish: async () => { await fetch(`${issuer}/finish`, { method: "POST" }); },
    sent: async () => (await (await fetch(issuer)).json() as { requests: Array<{ path: string; grant: string | null; credential: string | null }> }).requests,
  };
}
export async function adapter(kind: "remoteMcp" | "api", issuer: string, storage: KVStorage, seed = true) {
  const connector = kind === "remoteMcp"
    ? remoteMcp("svc", { url: `${issuer}/mcp`, auth: { type: "oauth" }, redirects: "same-origin", versionNegotiation: "legacy" })
    : api("svc", {
      oauth: { authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`, clientId: "native-client", apiOrigins: [new URL(issuer).origin] },
      tools: [{ name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: async (_args, ctx) => (await ctx.oauth!.fetch(`${issuer}/api`)).json() }],
    });
  if (seed) await seedGrant(storage, {
    issuer: kind === "remoteMcp" ? issuer : `${issuer}/token`, tokens,
    ...(kind === "remoteMcp" ? { client: { value: { client_id: "native-client", redirect_uris: ["https://connecta.test/oauth/callback/svc"], token_endpoint_auth_method: "none" }, binding: JSON.stringify({
      url: `${issuer}/mcp`, redirectUri: "https://connecta.test/oauth/callback/svc",
      clientMetadata: { redirect_uris: ["https://connecta.test/oauth/callback/svc"], client_name: "connecta", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
      authScope: "shared", versionNegotiation: "legacy", redirects: "same-origin",
    }) } } : {}),
  });
  const contexts: ReturnType<typeof scope>[] = [];
  const context = () => { const ctx = scope(storage); contexts.push(ctx); return ctx; };
  onTestFinished(async () => { for (const ctx of contexts) await connector.closeScope?.(ctx); });
  const result = {
    connector, context,
    read: () => kind === "remoteMcp" ? connector.listTools(context()) : connector.callTool("read", {}, context()),
    start: async () => {
      const started = await connector.startAuth!(context(), { force: true });
      expect(started.state).toBe("auth_required");
      const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
      return state;
    },
    finish: async (state: string) => {
      const ctx = context();
      expect(await connector.verifyState!(state, ctx)).toBe(true);
      return connector.finishAuth!("native-code", ctx, new URLSearchParams({ code: "native-code", state }));
    },
  };
  return { ...result, exchange: async () => result.finish(await result.start()) };
}

