import { describe, expect, it } from "vitest";
import { KvOAuthProvider } from "../src/auth/downstream-oauth.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { memoryStorage } from "../src/storage/memory.js";
import { oauthGrantKeys, oauthRefreshSpentKeys } from "../src/storage/keys.js";
import type { KVStorage } from "../src/types.js";
import { connectorContext } from "./fixtures/misc.js";
import { nativeOAuthServer } from "./fixtures/oauth-native-sdk.js";
import { seedGrant } from "./fixtures/oauth.js";

const scope = (storage: KVStorage) => ({ ...connectorContext(storage), requestScope: {} });
for (const status of [200, 301, 302, 303, 307, 308, 400, 503]) {
  it(`INV-5 INV-9: native HTTP ${status} revocation removes the grant with one send and no redirect follow`, async () => {
    const server = await nativeOAuthServer(`sdk-revoke-${status}`);
    const storage = memoryStorage();
    const connector = remoteMcp("svc", { url: `${server.issuer}/mcp`, auth: { type: "oauth" }, redirects: "same-origin", versionNegotiation: "legacy" });
    const started = await connector.startAuth!(scope(storage));
    const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
    const ctx = scope(storage);
    expect(await connector.verifyState!(state, ctx)).toBe(true);
    await connector.finishAuth!("code", ctx, new URLSearchParams({ code: "code", state }));
    const disconnect = connector.disconnectAuth!(scope(storage));
    if (status === 200) await disconnect;
    else {
      const error = await disconnect.catch(error => error);
      expect(error.code).toBe("oauth_revocation_failed");
      expect(error.cause).toBeUndefined();
      expect(error.message).not.toContain("REVOCATION_BODY_SENTINEL");
    }
    expect(JSON.parse((await storage.get(oauthGrantKeys.grant))!).body).toBeUndefined();
    await connector.disconnectAuth!(scope(storage));
    const sends = await server.sent();
    expect(sends.filter(request => request.path === "revoke")).toEqual([{ path: "revoke", grant: null, credential: "old-refresh" }]);
    expect(sends.some(request => request.path === "revoke-final")).toBe(false);
  });
}

describe("reset revocation snapshot", () => {
  it("INV-5 INV-9: concurrent disconnects revoke only the snapshot removed by a winning CAS", async () => {
    const server = await nativeOAuthServer("sdk-revoke-200");
    const storage = memoryStorage();
    await seedGrant(storage, {
      issuer: server.issuer, client: { value: { client_id: "native-client" } },
      tokens: { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer" },
      discovery: { authorizationServerUrl: server.issuer, authorizationServerMetadata: { issuer: server.issuer, revocation_endpoint: `${server.issuer}/revoke` } },
    });
    await storage.set(oauthRefreshSpentKeys.spent("permanent-fingerprint"), "permanent-record");
    const first = new KvOAuthProvider("svc", storage, "https://connecta.test/oauth/callback/svc");
    const second = new KvOAuthProvider("svc", storage, "https://connecta.test/oauth/callback/svc");
    const send = async (input: string | URL, init?: RequestInit) => {
      expect(JSON.parse((await storage.get(oauthGrantKeys.grant))!).body).toBeUndefined();
      return fetch(input, init);
    };
    await Promise.all([first.disconnectAuthorization(send), second.disconnectAuthorization(send)]);
    expect((await server.sent()).filter(request => request.path === "revoke")).toHaveLength(1);
    expect(await storage.get(oauthRefreshSpentKeys.spent("permanent-fingerprint"))).toBe("permanent-record");
  });
});
