import { describe, expect, it, vi } from "vitest";
import { CatalogService } from "../src/catalog-service.js";
import { ConnectorCallError } from "../src/errors.js";
import { InvocationService } from "../src/invocation.js";
import { bearerToken } from "../src/auth/bearer.js";
import { connectorWith } from "./fixtures/connectors.js";
import { activitySink, createTestConnecta, makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";

describe("repairing error envelopes", () => {
  it("INV-4: an unknown connector lists only connectors in this endpoint's registry view", async () => {
    const registry = makeRegistry(["visible", "private"].map((id) => connectorWith({ id, kind: "api" })));
    const scoped = registry.scoped({ connectorIds: ["visible"] });
    const catalog = new CatalogService(scoped, BASE);
    const outcome = await new InvocationService(scoped, catalog).invoke("missing.read", {}, { source: "call_tool" });
    expect(outcome).toMatchObject({ ok: false, error: { code: "unknown_address", configuredConnectors: ["visible"] } });
    expect(JSON.stringify(outcome)).not.toContain("private");
    const descriptions = await catalog.describe({ addresses: ["missing.read"] });
    expect(descriptions[0]?.errorDetails?.configuredConnectors).toEqual(["visible"]);
    const search = await catalog.search({ query: "read", connector: "private" });
    expect(search.queryAnalysis).toMatchObject({ unknownConnector: true, configuredConnectors: ["visible"] });
    expect(search.queryAnalysis?.guidance).toContain("Configured connectors for this endpoint: visible");
  });

  it("INV-6 INV-9: a dispatched write timeout echoes the uncertain call only to the agent and is never repeated", async () => {
    const warn = vi.fn();
    const call = vi.fn(async (_name: string, args: unknown) => {
      (args as { title: string }).title = "mutated-by-connector";
      throw new ConnectorCallError("timeout", "upstream deadline");
    });
    const registry = makeRegistry([connectorWith({ id: "notes", kind: "api", tools: [{ name: "create", annotations: { readOnlyHint: false } }], call })], { logger: { ...silentLogger, warn } });
    const target = activitySink();
    const invocation = new InvocationService(registry, new CatalogService(registry, BASE), target.activity);
    const args = { title: "argument-sentinel" };
    const outcome = await invocation.invoke("notes.create", args, { source: "call_destructive_tool" });
    expect(outcome).toMatchObject({
      ok: false, dispatched: true, attempts: 1,
      error: { code: "write_outcome_unknown", retryable: false, uncertainCall: { address: "notes.create", args: { title: "argument-sentinel" } } },
    });
    if (outcome.ok) throw new Error("Expected failure");
    expect(outcome.error.message).toContain("outcome is unknown");
    expect(call).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("argument-sentinel");
    expect(JSON.stringify(target.events)).not.toContain("argument-sentinel");
    const oversized = await invocation.invoke("notes.create", { title: "x".repeat(2000) }, { source: "call_destructive_tool" });
    expect(oversized).toMatchObject({ ok: false, error: { uncertainCall: { address: "notes.create", argsOmitted: true } } });
    if (!oversized.ok) expect(oversized.error.uncertainCall).not.toHaveProperty("args");
  });

  it("INV-9: a write that times out before dispatch has no uncertain call", async () => {
    const call = vi.fn();
    const registry = makeRegistry([connectorWith({ id: "notes", kind: "api", tools: async () => { throw new ConnectorCallError("timeout", "catalog deadline"); }, call })]);
    const outcome = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke("notes.create", {}, { source: "call_destructive_tool" });
    expect(outcome).toMatchObject({ ok: false, dispatched: false, error: { code: "timeout" } });
    if (!outcome.ok) expect(outcome.error).not.toHaveProperty("uncertainCall");
    expect(call).not.toHaveBeenCalled();
  });

  it("INV-6: OAuth and provider permissions have different recovery actions", async () => {
    const registry = makeRegistry([connectorWith({
      id: "oauth", kind: "mcp", tools: [{ name: "read", annotations: { readOnlyHint: true } }],
      startAuth: async () => ({ state: "auth_required" }),
      call: async () => { throw new ConnectorCallError("auth_required", "missing grant"); },
    }), connectorWith({
      id: "permission", kind: "api", tools: [{ name: "read", annotations: { readOnlyHint: true } }],
      call: async () => { throw new ConnectorCallError("provider_permission_denied", "scope denied"); },
    })]);
    const invocation = new InvocationService(registry, new CatalogService(registry, BASE));
    const oauth = await invocation.invoke("oauth.read", {}, { source: "call_tool" });
    expect(oauth).toMatchObject({ ok: false, error: { code: "downstream_oauth_required", recovery: "oauth", nextAction: { tool: "authorize_connector", arguments: { connector: "oauth" } } } });
    const permission = await invocation.invoke("permission.read", {}, { source: "call_tool" });
    expect(permission).toMatchObject({ ok: false, error: { code: "provider_permission_denied", retryable: false, retry: expect.stringContaining("administrator") } });
    if (!permission.ok) expect(permission.error).not.toHaveProperty("nextAction");
  });

  it("INV-4: host authentication carries its own code and preserves the HTTP challenge", async () => {
    const connecta = createTestConnecta({ connectors: [], auth: bearerToken("test-token"), publicUrl: BASE, logger: silentLogger });
    const response = await connecta.fetch(new Request(`${BASE}/mcp`));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual({ error: {
      code: "host_auth_required", message: expect.stringContaining("host"), retryable: false, recovery: "host_connection",
    } });
    await connecta.close();
  });
});
