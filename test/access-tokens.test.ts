import { describe, expect, it, vi } from "vitest";
import { AccessTokenManager } from "../src/access-tokens.js";
import { createTestConnecta } from "./helpers.js";
import { memoryStorage } from "../src/storage/memory.js";
import type {
  ActivityPage,
  ActivityStore,
} from "../src/activity.js";
import type { KVStorage } from "../src/types.js";
import { fakeClerkAuth } from "./fixtures/http.js";

const BASE = "https://connecta.test";

function request(token?: string): Request {
  return new Request(`${BASE}/mcp`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

describe("AccessTokenManager", () => {
  it("creates a one-time secret, authenticates it, renames it, and revokes it", async () => {
    const storage = memoryStorage();
    const manager = new AccessTokenManager(storage);
    const created = await manager.create("Claude desktop", "user_1");

    expect(created.token).toMatch(/^cta_[A-Za-z0-9_-]{43}$/);
    expect(created.accessToken).toMatchObject({
      name: "Claude desktop",
      tokenPrefix: created.token.slice(0, 12),
    });
    expect(JSON.stringify(await manager.list())).not.toContain(created.token);
    const stored = await Promise.all(
      (await storage.list!("access-token:")).map((key) => storage.get(key)),
    );
    expect(JSON.stringify(stored)).not.toContain(created.token);

    await expect(manager.auth.authorize(request(created.token), BASE))
      .resolves.toEqual({
        ok: true,
        subjectId: created.accessToken.id,
      });
    expect(
      await manager.auth.activityActorLabel!(created.accessToken.id),
    ).toBe("Claude desktop");

    await expect(
      manager.rename(created.accessToken.id, "ChatGPT production"),
    ).resolves.toMatchObject({ name: "ChatGPT production" });
    expect(
      await manager.auth.activityActorLabel!(created.accessToken.id),
    ).toBe("ChatGPT production");

    await expect(
      manager.revoke(created.accessToken.id, "user_2"),
    ).resolves.toMatchObject({ revokedAt: expect.any(String) });
    expect((await manager.auth.authorize(request(created.token), BASE)).ok)
      .toBe(false);
    // Tombstone metadata keeps historical activity labels readable.
    expect(
      await manager.auth.activityActorLabel!(created.accessToken.id),
    ).toBe("ChatGPT production");
  });

  it("bounds names and active token count", async () => {
    const manager = new AccessTokenManager(memoryStorage(), { maxActive: 1 });
    await expect(manager.create("   ", "user")).rejects.toThrow(
      "cannot be empty",
    );
    await manager.create("one", "user");
    await expect(manager.create("two", "user")).rejects.toThrow(
      "maximum of 1",
    );
  });

  it("requires enumerable storage", () => {
    const storage: KVStorage = {
      async get() { return null; },
      async set() {},
      async delete() {},
    };
    expect(() => new AccessTokenManager(storage)).toThrow("list(prefix)");
  });
});

describe("managed access token routes", () => {
  it("refuses a deployment with no Clerk operator", () => {
    expect(() =>
      createTestConnecta({
        connectors: [],
        storage: memoryStorage(),
        accessTokens: {},
      }),
    ).toThrow("requires a Clerk auth provider");
  });

  it("reveals token configuration only to an eligible Clerk operator", async () => {
    const connecta = createTestConnecta({
      connectors: [],
      auth: [fakeClerkAuth({ unauthorized: () => new Response("unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } }) })],
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const response = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-operator" },
      }),
    );
    expect(await response.json()).toMatchObject({
      accessTokenManagement: "not_configured",
    });
  });

  it("creates with Clerk, admits MCP reads, renames, and revokes", async () => {
    const connecta = createTestConnecta({
      connectors: [],
      auth: [fakeClerkAuth({ unauthorized: () => new Response("unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } }) })],
      storage: memoryStorage(),
      accessTokens: {},
      publicUrl: BASE,
    });
    const operatorHeaders = {
      Authorization: "Bearer clerk-operator",
      Origin: BASE,
      "Content-Type": "application/json",
    };
    expect(
      (
        await connecta.fetch(
          new Request(`${BASE}/ui/access-tokens`, { method: "OPTIONS" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await connecta.fetch(
          new Request(`${BASE}/ui/access-tokens`, {
            method: "POST",
            headers: {
              Authorization: "Bearer clerk-operator",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ name: "cross-origin" }),
          }),
        )
      ).status,
    ).toBe(403);
    const createdResponse = await connecta.fetch(
      new Request(`${BASE}/ui/access-tokens`, {
        method: "POST",
        headers: operatorHeaders,
        body: JSON.stringify({ name: "Claude" }),
      }),
    );
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as {
      token: string;
      accessToken: { id: string };
    };

    const admitted = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: `Bearer ${created.token}` },
      }),
    );
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toMatchObject({
      accessTokenManagement: "requires_clerk",
    });

    const renamed = await connecta.fetch(
      new Request(
        `${BASE}/ui/access-tokens/${created.accessToken.id}`,
        {
          method: "PUT",
          headers: operatorHeaders,
          body: JSON.stringify({ name: "Claude desktop" }),
        },
      ),
    );
    expect(await renamed.json()).toMatchObject({
      accessToken: { name: "Claude desktop" },
    });

    const refusedAdmin = await connecta.fetch(
      new Request(`${BASE}/ui/access-tokens`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${created.token}`,
          Origin: BASE,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "not allowed" }),
      }),
    );
    expect(refusedAdmin.status).toBe(401);

    const revoked = await connecta.fetch(
      new Request(
        `${BASE}/ui/access-tokens/${created.accessToken.id}`,
        {
          method: "DELETE",
          headers: operatorHeaders,
        },
      ),
    );
    expect(revoked.status).toBe(200);
    expect(
      (
        await connecta.fetch(
          new Request(`${BASE}/ui/data`, {
            headers: { Authorization: `Bearer ${created.token}` },
          }),
        )
      ).status,
    ).toBe(401);
  });

  it("resolves historical activity to a revoked token name", async () => {
    let page: ActivityPage = { events: [] };
    const activity: ActivityStore = {
      record: vi.fn(),
      async list() { return page; },
    };
    const connecta = createTestConnecta({
      connectors: [],
      auth: [fakeClerkAuth({ unauthorized: () => new Response("unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } }) })],
      storage: memoryStorage(),
      accessTokens: {},
      activity: { store: activity },
      publicUrl: BASE,
    });
    const headers = {
      Authorization: "Bearer clerk-operator",
      Origin: BASE,
      "Content-Type": "application/json",
    };
    const created = await (
      await connecta.fetch(
        new Request(`${BASE}/ui/access-tokens`, {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "ChatGPT production" }),
        }),
      )
    ).json() as { accessToken: { id: string } };
    page = {
      events: [{
        schemaVersion: 1,
        id: "event-1",
        occurredAt: "2026-07-30T12:00:00.000Z",
        requestId: "request-1",
        actor: {
          kind: "access_token",
          id: created.accessToken.id,
          namespace: "connecta:access-tokens:v1",
        },
        connectorId: "example",
        toolName: "read",
        address: "example.read",
        source: "call_tool",
        outcome: "success",
        durationMs: 1,
        attempts: 1,
        serverName: "connecta",
        serverVersion: "test",
      }],
    };
    await connecta.fetch(
      new Request(
        `${BASE}/ui/access-tokens/${created.accessToken.id}`,
        { method: "DELETE", headers },
      ),
    );
    const response = await connecta.fetch(
      new Request(`${BASE}/ui/activity`, {
        headers: { Authorization: "Bearer clerk-operator" },
      }),
    );
    expect(await response.json()).toMatchObject({
      events: [{
        actor: {
          id: created.accessToken.id,
          label: "ChatGPT production",
        },
      }],
    });
  });
});
