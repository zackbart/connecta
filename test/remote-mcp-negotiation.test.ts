import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { attachCaller } from "../src/connector-caller.js";
import { memoryStorage } from "../src/storage/memory.js";
import { NEGOTIATION_TTL_SECONDS } from "../src/storage/keys.js";
import { connectorContext } from "./fixtures/misc.js";
import type { Connector, ConnectorContext, KVStorage } from "../src/types.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function downstream(probeStatus?: number, ttlMs = 0) {
  const methods: string[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit) => {
    if (init.method !== "POST") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init.body));
    methods.push(request.method);
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (request.method === "server/discover" && probeStatus) return new Response("withheld probe body", { status: probeStatus });
    const token = new Headers(init.headers).get("authorization") ?? "";
    const result = request.method === "server/discover"
      ? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, instructions: `Instructions ${token}` }
      : request.method === "initialize"
        ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "legacy", version: "1" } }
        : { resultType: "complete", ttlMs, cacheScope: "private", tools: [{ name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] };
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  return methods;
}

async function list(connector: Connector, storage: KVStorage, context?: ConnectorContext) {
  const ctx = context ?? { ...connectorContext(storage), requestScope: {} };
  try { return await connector.listTools(ctx); }
  finally { await connector.closeScope?.(ctx); }
}

describe("downstream negotiation verdicts", () => {
  it("INV-7: reuses a modern verdict across request scopes until its original TTL expires", async () => {
    const methods = downstream();
    const storage = memoryStorage();
    const connector = remoteMcp("down", { url: "https://down.test/mcp" });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await list(connector, storage);
    clock.mockReturnValue(now + NEGOTIATION_TTL_SECONDS * 500);
    await list(connector, storage);
    expect(methods.filter(method => method === "server/discover")).toHaveLength(1);
    expect(methods).not.toContain("initialize");
    clock.mockReturnValue(now + NEGOTIATION_TTL_SECONDS * 1000 + 1);
    await list(connector, storage);
    expect(methods.filter(method => method === "server/discover")).toHaveLength(2);
  });

  for (const status of [405, 500, 502, 503, 599]) {
    it(`INV-7: caches the legacy verdict after probe HTTP ${status}`, async () => {
      const methods = downstream(status);
      const storage = memoryStorage();
      const connector = remoteMcp("down", { url: "https://down.test/mcp" });
      await list(connector, storage);
      await list(connector, storage);
      expect(methods.filter(method => method === "server/discover")).toHaveLength(1);
      // A legacy session still initializes on its own fresh transport.
      expect(methods.filter(method => method === "initialize")).toHaveLength(2);
    });
  }

  for (const status of [401, 403]) {
    it(`INV-4: refuses probe HTTP ${status} without legacy fallback or a cached verdict`, async () => {
      const methods = downstream(status);
      const storage = memoryStorage();
      const connector = remoteMcp("down", { url: "https://down.test/mcp" });
      await expect(list(connector, storage)).rejects.toBeDefined();
      expect(methods).not.toContain("initialize");
      expect(await storage.list("")).toEqual([]);
    });
  }

  it("INV-5: partitions verdicts by the current credential and stores only intake-redacted discovery", async () => {
    const methods = downstream();
    const storage = memoryStorage();
    let token = "request-A-secret";
    const connector = remoteMcp("down", { url: "https://down.test/mcp", auth: { type: "request", token: async () => token } });
    await list(connector, storage);
    const first = await Promise.all((await storage.list("")).map(key => storage.get(key)));
    expect(first.join("")).not.toContain(token);
    expect(first.join("")).toContain("[redacted]");
    token = "request-B-secret";
    await list(connector, storage);
    expect(methods.filter(method => method === "server/discover")).toHaveLength(2);
    expect((await Promise.all((await storage.list("")).map(key => storage.get(key)))).join("")).not.toContain(token);
  });

  it("INV-4: isolates negotiation verdicts between admitted principals and pools", async () => {
    const methods = downstream();
    const storage = memoryStorage();
    const connector = remoteMcp("down", { url: "https://down.test/mcp" });
    for (const [id, pool] of [["alice", "one"], ["bob", "one"], ["alice", "two"], ["alice", "one"]] as const) {
      const ctx = attachCaller({ ...connectorContext(storage), requestScope: {} }, {
        authenticated: true, identity: { actor: { kind: "user", id }, interactive: true }, pool,
      });
      await list(connector, storage, ctx);
    }
    expect(methods.filter(method => method === "server/discover")).toHaveLength(3);
  });

  it("INV-5: binds OAuth verdicts to the resolved metadata, redirect and static client configuration", async () => {
    const methods = downstream(undefined, 60_000);
    const storage = memoryStorage();
    const defaultClient = remoteMcp("down", { url: "https://down.test/mcp", auth: { type: "oauth" } });
    for (const publicUrl of ["https://one.example", "https://two.example", "https://one.example"]) {
      await list(defaultClient, storage, { ...connectorContext(storage), publicUrl, requestScope: {} });
    }
    for (const clientId of ["one", "two", "one"]) {
      const connector = remoteMcp("down", { url: "https://down.test/mcp", auth: { type: "oauth",
        client: { issuer: "https://auth.example", clientId, clientSecret: "confidential-client-secret" } } });
      await list(connector, storage);
    }
    expect(methods.filter(method => method === "server/discover")).toHaveLength(4);
    expect(methods.filter(method => method === "tools/list")).toHaveLength(4);
    expect((await Promise.all((await storage.list("")).map(key => storage.get(key)))).join("")).not.toContain("confidential-client-secret");
  });
});
