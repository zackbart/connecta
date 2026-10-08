import { responseCacheKeys } from "../src/storage/keys.js";
import { oauthVault, connectRequest } from "./fixtures/oauth.js";
// Behavior the operator and activity data routes gained when they moved onto
// Effect (P1-S18). Each case failed against the async handlers it replaced.
import { describe, expect, it, vi } from "vitest";
import { activityHistory } from "../src/activity.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import type { ToolCallActivityEvent } from "../src/activity.js";
import { memoryStorage } from "../src/storage/memory.js";
import { oauthGrantKeys, scopes } from "../src/storage/keys.js";
import type { Connector, InboundAuth, KVStorage } from "../src/types.js";
import { createTestConnecta } from "./helpers.js";
import { calcApi, fakeClerkAuth } from "./fixtures/http.js";
import { BASE, CLERK_OPTIONS, credentialRequest, makeCredentialConnecta } from "./fixtures/ui.js";

async function settle(turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("operator data routes", () => {
  it("stops reading a credential body once it is past the size limit", async () => {
    const { connecta } = makeCredentialConnecta();
    // Five megabytes of JSON-looking text, pulled a kilobyte at a time. The
    // limit is 20,000 characters, so nothing past the first few dozen
    // kilobytes can change the answer.
    const chunk = new TextEncoder().encode("a".repeat(1_024));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 5 * 1_024 * 1_024) {
          controller.close();
          return;
        }
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const response = await credentialRequest(connecta, "/ui/credentials/vaulted", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "request body is too large",
    });
    expect(pulled).toBeLessThan(200 * 1_024);
  });

  it("still measures a credential body in characters, not bytes", async () => {
    const { connecta } = makeCredentialConnecta();
    // 19,000 three-byte characters: 57,000 bytes, but under the route's
    // limit, so the answer comes from the vault's own byte cap instead.
    const value = "€".repeat(19_000);
    const response = await credentialRequest(connecta, "/ui/credentials/vaulted", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/^Credential cannot exceed/);
  });

  it("reports a disconnect that rejects without a reason as a failure", async () => {
    const connector: Connector = {
      id: "oauth",
      kind: "mcp",
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
      // A hook that rejects with no reason still failed. Before, a falsy
      // rejection read as success and the page reported a disconnect that
      // never happened.
      disconnectAuth: () => Promise.reject(),
      async startAuth() {
        return { state: "auth_required" };
      },
    };
    const storage = memoryStorage();
    const connecta = createTestConnecta({
      connectors: [connector],
      auth: fakeClerkAuth(CLERK_OPTIONS),
      vault: oauthVault(storage),
      storage,
      publicUrl: BASE,
    });
    await storage.set(responseCacheKeys.generation("oauth"), "stale catalog");

    const disconnected = await credentialRequest(connecta, "/ui/oauth/oauth", {
      method: "DELETE",
    });

    expect(disconnected.status).toBe(400);
    await expect(disconnected.json()).resolves.toEqual({ error: "OAuth disconnect failed" });
    expect(await storage.get(responseCacheKeys.generation("oauth"))).not.toBe("stale catalog");
  });

  describe("POST /ui/oauth/<id> start modes", () => {
    function oauthConnecta(status: Awaited<ReturnType<NonNullable<Connector["startAuth"]>>>) {
      const starts: Array<{ force?: boolean } | undefined> = [];
      const connector: Connector = {
        id: "oauth",
        kind: "mcp",
        async listTools() {
          return [];
        },
        async callTool() {
          return null;
        },
        async disconnectAuth() {},
        async startAuth(_ctx, opts) {
          starts.push(opts);
          return status;
        },
      };
      const storage = memoryStorage();
      const connecta = createTestConnecta({
        connectors: [connector],
        auth: fakeClerkAuth(CLERK_OPTIONS),
        vault: oauthVault(storage),
        storage,
        publicUrl: BASE,
      });
      return { connecta, storage, starts };
    }
    const fresh = {
      state: "auth_required" as const,
      authorizationUrl: "https://auth.example/authorize?state=fresh",
    };

    it("restarts when no mode is given, as it always has", async () => {
      const { connecta, storage, starts } = oauthConnecta(fresh);
      await storage.set(responseCacheKeys.generation("oauth"), "stale catalog");

      const response = await connectRequest(connecta, "/ui/oauth/oauth", {
        method: "POST",
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(fresh.authorizationUrl);
      expect(starts).toEqual([{ force: true }]);
      expect(await storage.get(responseCacheKeys.generation("oauth"))).not.toBe("stale catalog");
    });

    it("maps mode=restart to a forced start and mode=continue to an unforced one", async () => {
      const { connecta, starts } = oauthConnecta(fresh);

      for (const mode of ["restart", "continue"]) {
        const response = await connectRequest(connecta, `/ui/oauth/oauth?mode=${mode}`, { method: "POST" });
        expect(response.status).toBe(302);
      }

      expect(starts).toEqual([{ force: true }, { force: false }]);
    });

    it("keeps the catalog when a continued browser visit reuses the consent URL", async () => {
      const { connecta, storage, starts } = oauthConnecta({
        ...fresh,
        authorizationReused: true,
      });
      await storage.set(responseCacheKeys.generation("oauth"), "still valid catalog");

      const response = await connectRequest(connecta, "/ui/oauth/oauth?mode=continue", { method: "POST" });

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(fresh.authorizationUrl);
      expect(starts).toEqual([{ force: false }]);
      expect(await storage.get(responseCacheKeys.generation("oauth"))).toBe("still valid catalog");
    });

    it("keeps the catalog when a continued start finds the connection healthy", async () => {
      const { connecta, storage } = oauthConnecta({ state: "ok" });
      await storage.set(responseCacheKeys.generation("oauth"), "still valid catalog");

      const continued = await connectRequest(connecta, "/ui/oauth/oauth?mode=continue", { method: "POST" });
      expect(continued.status).toBe(200);
      expect(await continued.text()).toContain("already connected");
      expect(await storage.get(responseCacheKeys.generation("oauth"))).toBe("still valid catalog");

      // A restart that ends healthy still reset the grant under the catalog.
      const restarted = await connectRequest(connecta, "/ui/oauth/oauth?mode=restart", { method: "POST" });
      expect(restarted.status).toBe(200);
      expect(await storage.get(responseCacheKeys.generation("oauth"))).not.toBe("still valid catalog");
    });

    it("invalidates the catalog when a continued start had to begin a new flow", async () => {
      const { connecta, storage } = oauthConnecta(fresh);
      await storage.set(responseCacheKeys.generation("oauth"), "stale catalog");

      const continued = await connectRequest(connecta, "/ui/oauth/oauth?mode=continue", { method: "POST" });
      expect(continued.status).toBe(302);
      expect(await storage.get(responseCacheKeys.generation("oauth"))).not.toBe("stale catalog");
    });

    it("refuses an unknown or repeated mode before starting anything", async () => {
      const { connecta, starts } = oauthConnecta(fresh);

      for (const query of ["?mode=resume", "?mode=", "?mode=continue&mode=restart"]) {
        const response = await connectRequest(connecta, `/ui/oauth/oauth${query}`, { method: "POST" });
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          error: 'mode must be "continue" or "restart"',
        });
      }
      expect(starts).toEqual([]);
    });
  });

  it("aborts a stalled downstream OAuth start at the deadline and invalidates the catalog", async () => {
    vi.useFakeTimers();
    const mcpUrl = "https://downstream.example/mcp";
    const metadataUrl = "https://downstream.example/.well-known/oauth-protected-resource";
    let reachedMetadata!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedMetadata = resolve;
    });
    let aborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === mcpUrl) {
          return new Response(null, {
            status: 401,
            headers: { "www-authenticate": `Bearer resource_metadata="${metadataUrl}"` },
          });
        }
        if (url === metadataUrl) {
          reachedMetadata();
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(init.signal?.reason);
              },
              { once: true },
            );
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    try {
      const storage = memoryStorage();
      await storage.set(responseCacheKeys.generation("oauth"), "stale catalog");
      const connecta = createTestConnecta({
        connectors: [
          remoteMcp("oauth", {
            url: mcpUrl,
            auth: { type: "oauth" },
            versionNegotiation: "legacy",
          }),
        ],
        auth: fakeClerkAuth(CLERK_OPTIONS),
        vault: oauthVault(storage),
        storage,
        publicUrl: BASE,
      });
      const started = connectRequest(connecta, "/ui/oauth/oauth", { method: "POST" });
      await reached;
      await vi.advanceTimersByTimeAsync(30_000);
      const response = await started;

      expect(response.status).toBe(504);
      await expect(response.json()).resolves.toEqual({ error: "OAuth authorization start timed out" });
      expect(aborted).toBe(true);
      expect(await storage.get(responseCacheKeys.generation("oauth"))).not.toBe("stale catalog");
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("drains an uncancellable grant write before returning a timeout", async () => {
    vi.useFakeTimers();
    const inner = memoryStorage();
    let entered!: () => void;
    const reachedWrite = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stall = true;
    const grantKey = `${scopes.connector("oauth")}${oauthGrantKeys.grant}`;
    const storage: KVStorage = {
      list: (prefix) => inner.list(prefix),
      get: (key) => inner.get(key),
      delete: (key) => inner.delete(key),
      set: (key, value, options) => inner.set(key, value, options),
      // The restart replaces the grant's epoch with a compare-and-set.
      async compareAndSet(key, expected, next, options) {
        if (key === grantKey && stall) {
          stall = false;
          entered();
          await blocked;
        }
        return inner.compareAndSet(key, expected, next, options);
      },
    };
    let networkStarts = 0;
    try {
      const connecta = createTestConnecta({
        connectors: [
          remoteMcp("oauth", {
            url: "https://downstream.example/mcp",
            auth: { type: "oauth" },
            _transportFactory: () => {
              networkStarts++;
              throw new Error("network began after cancellation");
            },
          }),
        ],
        auth: fakeClerkAuth(CLERK_OPTIONS),
        vault: oauthVault(storage),
        storage,
        publicUrl: BASE,
      });
      await storage.set(responseCacheKeys.generation("oauth"), "stale");
      const started = connectRequest(connecta, "/ui/oauth/oauth", { method: "POST" });
      let answered = false;
      void started.then(
        () => {
          answered = true;
        },
        () => {
          answered = true;
        },
      );
      await reachedWrite;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(answered).toBe(false);
      release();
      const response = await started;
      expect(response.status).toBe(504);
      expect(networkStarts).toBe(0);
      expect(await storage.get(responseCacheKeys.generation("oauth"))).not.toBe("stale");
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it("cancels a browser-abandoned start but lets disconnect finish", async () => {
    let reachedStart!: () => void;
    const startedHook = new Promise<void>((resolve) => {
      reachedStart = resolve;
    });
    let startAborted = false;
    let finishDisconnect!: () => void;
    const disconnectGate = new Promise<void>((resolve) => {
      finishDisconnect = resolve;
    });
    let reachedDisconnect!: () => void;
    const disconnectStarted = new Promise<void>((resolve) => {
      reachedDisconnect = resolve;
    });
    const connector: Connector = {
      id: "oauth",
      kind: "mcp",
      listTools: async () => [],
      callTool: async () => null,
      startAuth: (ctx) =>
        new Promise((_, reject) => {
          reachedStart();
          ctx.signal?.addEventListener(
            "abort",
            () => {
              startAborted = true;
              reject(ctx.signal?.reason);
            },
            { once: true },
          );
        }),
      disconnectAuth: () => {
        reachedDisconnect();
        return disconnectGate;
      },
    };
    const storage = memoryStorage();
    await storage.set(responseCacheKeys.generation("oauth"), "stale");
    const connecta = createTestConnecta({
      connectors: [connector],
      auth: fakeClerkAuth(CLERK_OPTIONS),
      vault: oauthVault(storage),
      storage,
      publicUrl: BASE,
    });
    const browser = new AbortController();
    const starting = connectRequest(connecta, "/ui/oauth/oauth", {
      method: "POST",
      signal: browser.signal,
    });
    await startedHook;
    browser.abort();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(startAborted).toBe(true);
    expect(await storage.get(responseCacheKeys.generation("oauth"))).not.toBe("stale");

    await storage.set(responseCacheKeys.generation("oauth"), "stale again");
    const abandonedDisconnect = new AbortController();
    const disconnecting = credentialRequest(connecta, "/ui/oauth/oauth", {
      method: "DELETE",
      signal: abandonedDisconnect.signal,
    });
    await disconnectStarted;
    abandonedDisconnect.abort();
    finishDisconnect();
    await expect(disconnecting).rejects.toMatchObject({ name: "AbortError" });
    await settle(2);
    expect(await storage.get(responseCacheKeys.generation("oauth"))).not.toBe("stale again");
  });

  it("stops resolving activity labels once the reader has gone", async () => {
    const pending: Array<() => void> = [];
    const activityActorLabel = vi.fn(
      (id: string) =>
        new Promise<string>((resolve) => {
          pending.push(() => resolve(`Label ${id}`));
        }),
    );
    const auth: InboundAuth = {
      interactiveOperator: true,
      kind: "oidc",
      activityActorNamespace: "https://identity.example",
      activityActorLabel,
      authorize: () => ({ ok: true, userId: "operator" }),
    };
    const events: ToolCallActivityEvent[] = Array.from({ length: 12 }, (_, i) => ({
      schemaVersion: 1,
      id: `event-${i}`,
      occurredAt: "2026-07-23T12:00:00.000Z",
      requestId: `request-${i}`,
      actor: { kind: "oidc", id: `user-${i}`, namespace: "https://identity.example" },
      connectorId: "calc",
      toolName: "add",
      address: "calc.add",
      source: "call_tool",
      outcome: "success",
      durationMs: 1,
      attempts: 1,
      serverName: "connecta",
      serverVersion: "0.1.0",
    }));
    const connecta = createTestConnecta({
      connectors: [calcApi({ title: "Calculator", inputSchema: "object" })],
      auth,
      activity: activityHistory({
        store: {
          record() {},
          async list() {
            return { events };
          },
        },
      }),
      publicUrl: BASE,
    });

    const controller = new AbortController();
    const reading = connecta.fetch(
      new Request(`${BASE}/ui/activity`, {
        headers: { Authorization: "Bearer operator" },
        signal: controller.signal,
      }),
    );
    reading.catch(() => {});
    for (let turn = 0; turn < 200 && activityActorLabel.mock.calls.length < 8; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // Eight lookups in flight, four still queued.
    expect(activityActorLabel).toHaveBeenCalledTimes(8);

    controller.abort();
    await expect(reading).rejects.toBeDefined();
    for (const release of pending.splice(0)) release();
    await settle();

    // Nobody is waiting for the page, so the queued four never reach the
    // identity provider.
    expect(activityActorLabel).toHaveBeenCalledTimes(8);
  });
});
