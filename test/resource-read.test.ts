import { afterEach, expect, it, vi } from "vitest";
import { inputRequired, ProtocolError, ResourceNotFoundError } from "@modelcontextprotocol/server";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { CredentialVault } from "../src/credentials.js";
import { ConnectorCallError } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import type { RegistryView } from "../src/registry.js";
import type { Connector, ConnectorContext } from "../src/types.js";
import { memoryStorage } from "../src/storage/memory.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { deferred, scriptedExecutor } from "./fixtures/misc.js";
import { createTestConnecta, makeRegistry, required, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const qualified = (id: string, uri = "docs://manual/start") => `resource://${id}/${encodeURIComponent(uri)}`;

function fixture(overrides: Partial<Connector> = {}) {
  const readResource = vi.fn(async (uri: string, _ctx: ConnectorContext) => ({
    contents: [{ uri, mimeType: "text/plain", text: "manual" }],
  }));
  const listTools = vi.fn(async () => []);
  const connector: Connector = { id: "docs", listTools, callTool: vi.fn(), readResource, ...overrides };
  return { connector, readResource, listTools };
}

function read(registry: RegistryView, uri: unknown, config: Parameters<typeof createExecuteTool>[5] = {}) {
  return createExecuteTool(registry, BASE, scriptedExecutor(fns => required(fns.read)(uri)), silentLogger, undefined, config)({ code: "async () => null" });
}

afterEach(() => { vi.unstubAllGlobals(); });

it.each(["read-only", "trusted"] as const)("INV-2, INV-3: reads connector-qualified resources in a %s program without loading tools or fetching the resource URL", async trust => {
  const { connector, readResource, listTools } = fixture();
  const registry = makeRegistry([connector]);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const uri = "https://arbitrary.example/account?subject=other#part";
  const output = await read(registry, qualified("docs", uri), { trust, maxWrites: 1 });
  expect(output.isError).toBeUndefined();
  expect(output.structuredContent).toMatchObject({ result: { contents: [{ uri, text: "manual" }] } });
  expect(readResource).toHaveBeenCalledOnce();
  expect(readResource.mock.calls[0]?.[0]).toBe(uri);
  expect(listTools).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("INV-3, INV-4: hidden connectors and exact-tool grants cannot grant resource reads", async () => {
  const { connector, readResource } = fixture();
  const registry = makeRegistry([connector]);
  const views = [
    registry.scoped({ connectorIds: [] }),
    registry.scoped({ connectorIds: ["docs"], toolAccess: new Map([["docs", new Set(["read"])]]) }),
    registry.scoped({ connectorIds: ["docs"], guardedToolAccess: new Map([["docs", new Set(["read"])]]) }),
    registry.scoped({ connectorIds: ["docs"], toolAccess: new Map([["docs", new Set<string>()]]) }),
  ];
  for (const view of views) {
    for (const trust of ["read-only", "trusted"] as const) {
      const output = await read(view, qualified("docs"), { trust });
      expect(output.structuredContent).toMatchObject({ error: { code: "unknown_address", retryable: false } });
    }
  }
  expect(readResource).not.toHaveBeenCalled();
  expect((await read(registry.scoped({ connectorIds: ["docs"] }), qualified("docs"))).isError).toBeUndefined();
});

it.each([
  undefined, null, {}, 42, "", "https://arbitrary.example/read", "docs://manual/start",
  "resource://docs@other/docs%3A%2F%2Fmanual", "resource://docs:443/docs%3A%2F%2Fmanual",
  "resource://docs/docs://manual/start", "resource://docs/%ZZ", "resource://docs/",
  "resource://docs/docs%3A%2F%2Fmanual?subject=other", "resource://docs/docs%3A%2F%2Fmanual#other",
  "resource://docs/not-a-uri", qualified("docs", "docs://manual/\nsubject"), "resource://docs/" + "a".repeat(8192),
])("INV-3, INV-4: rejects malformed resource routing without dispatch (case %#)", async uri => {
  const { connector, readResource } = fixture();
  const registry = makeRegistry([connector]);
  const output = await read(registry, uri);
  expect(output.structuredContent).toMatchObject({ error: { code: "invalid_args", retryable: false } });
  expect(readResource).not.toHaveBeenCalled();
  expect(registry.listConnectors()).toEqual([connector]);
});

it("INV-2, INV-4: endpoint pools intersect whole-connector resource grants even when trusted", async () => {
  const { connector, readResource } = fixture();
  const app = createTestConnecta({
    connectors: [connector, fixture({ id: "other" }).connector], logger: silentLogger,
    executor: scriptedExecutor(fns => required(fns.read)(qualified("docs"))),
    identity: { connectorAccess: () => ["docs"] },
    pools: {
      whole: { tools: ["docs"], trust: "read-only", grant: () => true },
      tool: { tools: ["docs.read"], trust: "trusted", grant: () => true },
      hidden: { tools: ["other"], trust: "trusted", grant: () => true },
    },
  });
  try {
    for (const pool of ["whole", "tool", "hidden"]) {
      const request = mcpRpc("tools/call", { name: "execute_code", arguments: { code: "async () => null" } });
      const response = await app.fetch(new Request(`${BASE}/mcp/${pool}`, { method: "POST", headers: request.headers, body: await request.text() }));
      const rpc = await readJsonRpc(response) as { result: { structuredContent: unknown; isError?: boolean } };
      if (pool === "whole") expect(rpc.result.isError).toBeUndefined();
      else expect(rpc.result.structuredContent).toMatchObject({ error: { code: "unknown_address" } });
    }
    expect(readResource).toHaveBeenCalledOnce();
  } finally { await app.close(); }
});

it("INV-3, INV-4: an absent or resource-incapable connector fails without minting one", async () => {
  const { connector, readResource } = fixture();
  delete connector.readResource;
  const registry = makeRegistry([connector]);
  for (const id of ["absent", "docs"]) {
    expect((await read(registry, qualified(id))).structuredContent).toMatchObject({ error: { code: "unknown_address", retryable: false } });
  }
  expect(readResource).not.toHaveBeenCalled();
  expect(registry.listConnectors()).toEqual([connector]);
});

it("INV-3, INV-4: resource URI and extra arguments cannot change the personal credential owner", async () => {
  const vault = new CredentialVault(memoryStorage(), btoa("r".repeat(32)));
  await vault.set("docs", "personal-resource-credential", "operator", "admitted-owner");
  const getAll = vi.spyOn(vault, "getAll");
  const { connector } = fixture({
    authScope: "personal", credential: { label: "Token" },
    async readResource(uri, ctx) { await ctx.credential?.get(); return { contents: [{ uri, text: "owned" }] }; },
  });
  const registry = makeRegistry([connector], { credentialVault: vault });
  const view = registry.scoped({ connectorIds: ["docs"], principalKey: "admitted-owner", subjectKey: "admitted-subject" });
  const output = await createExecuteTool(view, BASE, scriptedExecutor(fns => required(fns.read)(
    qualified("docs", "docs://manual?subject=other"), { subject: "other", principalKey: "other", connector: "other" },
  )), silentLogger)({ code: "async () => null" });
  expect(output.isError).toBeUndefined();
  expect(getAll.mock.calls).toEqual([["docs", "admitted-owner"]]);
});

it.each(["auth_required", "provider_permission_denied", "not_found", "rate_limited", "unavailable"] as const)("INV-5: resource reads keep typed %s failures", async code => {
  const { connector } = fixture({ async readResource() { throw new ConnectorCallError(code, "Resource refused."); } });
  expect((await read(makeRegistry([connector]), qualified("docs"))).structuredContent).toMatchObject({
    error: { code, retryable: ["rate_limited", "unavailable"].includes(code) },
  });
});

it("INV-5: custom resource values, keys, failures and later guest output redact credential echoes", async () => {
  const token = "credential-resource-echo-12345";
  const { connector } = fixture({
    credential: { label: "Token" },
    async readResource(uri, ctx) {
      const credential = await ctx.credential?.get();
      if (uri === "docs://failure") throw new ConnectorCallError("not_found", `Missing ${credential}`);
      return { contents: [{ uri, text: credential, [token]: btoa(token) }] };
    },
  });
  const vault = new CredentialVault(memoryStorage(), btoa("r".repeat(32)));
  await vault.set("docs", token, "operator");
  const registry = makeRegistry([connector], { credentialVault: vault });
  const output = await createExecuteTool(registry, BASE, scriptedExecutor(async fns => {
    const value = await required(fns.read)(qualified("docs"));
    let failure: unknown;
    try { await required(fns.read)(qualified("docs", "docs://failure")); }
    catch (error) { failure = (error as { details: unknown }).details; }
    return { value, failure, reconstructed: token };
  }), silentLogger)({ code: "async () => null" });
  expect(output.isError).toBeUndefined();
  expect(JSON.stringify(output)).not.toContain(token);
  expect(JSON.stringify(output)).not.toContain(btoa(token));
  expect(output.structuredContent).toMatchObject({ result: {
    value: { contents: [{ text: "[redacted]", "[redacted]": "[redacted]" }] },
    failure: { code: "not_found", message: "Missing [redacted]" }, reconstructed: "[redacted]",
  } });
});

it("INV-7: resource reads share connector admission and release their permit after timeout", async () => {
  const readResource = vi.fn((_uri: string, _ctx: ConnectorContext): Promise<unknown> => new Promise(() => {}));
  const { connector } = fixture({
    callAdmission: { rules: [{ maxConcurrency: 1, maxQueueSize: 0 }] },
    readResource,
  });
  const registry = makeRegistry([connector]);
  const output = await read(registry, qualified("docs"), { hostCallTimeoutMs: 25 });
  expect(output.structuredContent).toMatchObject({ error: { code: "timeout", retryable: true } });
  expect(registry.callAdmissionSnapshot().docs?.active).toBe(0);
  expect(readResource).toHaveBeenCalledOnce();
  expect(readResource.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  const held = await registry.admitCall("docs", { toolName: "read", args: {} });
  try {
    expect((await read(registry, qualified("docs"))).structuredContent).toMatchObject({ error: { code: "rate_limited", retryable: true } });
    expect(readResource).toHaveBeenCalledOnce();
  } finally { held.release(); }
});

it("INV-7: cancellation aborts a resource read and closes its request scope", async () => {
  const started = deferred<ConnectorContext>();
  const closeScope = vi.fn(async () => {});
  const { connector } = fixture({
    closeScope,
    async readResource(_uri, ctx) { started.resolve(ctx); return new Promise(() => {}); },
  });
  const controller = new AbortController();
  const output = createExecuteTool(makeRegistry([connector]), BASE, scriptedExecutor(fns => required(fns.read)(qualified("docs"))), silentLogger)(
    { code: "async () => null" }, { signal: controller.signal },
  );
  const ctx = await started.promise;
  controller.abort();
  expect((await output).structuredContent).toMatchObject({ error: { code: "cancelled", retryable: false } });
  expect(ctx.signal?.aborted).toBe(true);
  expect(closeScope).toHaveBeenCalledOnce();
});

it("INV-3, INV-7: resource reads share host-call budgets and request scope, with payload-free diagnostics", async () => {
  const { connector, readResource } = fixture();
  const registry = makeRegistry([connector]);
  const execute = createExecuteTool(registry, BASE, scriptedExecutor(async fns => {
    await Promise.all([required(fns.read)(qualified("docs")), required(fns.read)(qualified("docs"))]);
    return "done";
  }), silentLogger, undefined, { maxHostCalls: 2 });
  const result = await execute({ code: "async () => null", diagnostics: true });
  expect(result.isError).toBeUndefined();
  expect(readResource.mock.calls[0]?.[1].requestScope).toBe(readResource.mock.calls[1]?.[1].requestScope);
  const diagnostics = (result.structuredContent as { diagnostics: { operations: unknown[] } }).diagnostics;
  expect(diagnostics.operations).toMatchObject([{ operation: "read", count: 2, failures: 0 }]);
  expect(JSON.stringify(diagnostics)).not.toContain("manual");
  expect(JSON.stringify(diagnostics)).not.toContain("docs://");
  const exhausted = await createExecuteTool(registry, BASE, scriptedExecutor(async fns => {
    await required(fns.read)(qualified("docs"));
    await required(fns.search)({ connector: "docs" });
    return "must not return";
  }), silentLogger, undefined, { maxHostCalls: 1 })({ code: "async () => null" });
  expect(exhausted.structuredContent).toMatchObject({ error: { code: "budget_exceeded", retryable: false }, hostCalls: { attempted: 2, admitted: 1 } });
  expect(readResource).toHaveBeenCalledTimes(3);
});

it("INV-3, INV-5, INV-7: remote resource reads use resources/read, redact sent headers and keep typed misses", async () => {
  const token = "remote-resource-sent-credential";
  const requests: Request[] = [];
  const downstream = httpDownstream(server => {
    server.registerResource("manual", "docs://manual/start", { mimeType: "text/plain", cacheHint: { ttlMs: 60_000, cacheScope: "private" } }, async uri => ({
      contents: [{ uri: uri.href, text: token }],
    }));
    server.registerResource("missing", "docs://missing", {}, async () => { throw new ResourceNotFoundError("docs://missing"); });
    server.registerResource("refused", "docs://refused", {}, async () => { throw new ProtocolError(-32602, `Refused ${token}`); });
    server.registerResource("input", "docs://input", {}, async () => inputRequired({ requestState: "resource-input-state" }));
  }, { capture: request => { requests.push(request); } });
  vi.stubGlobal("fetch", downstream.fetch);
  const connector = remoteMcp("docs", { url: downstream.url, auth: { type: "headers", headers: { "X-API-Key": token } }, logger: silentLogger });
  const registry = makeRegistry([connector]);
  const output = await createExecuteTool(registry, BASE, scriptedExecutor(async fns => {
    const first = await required(fns.read)(qualified("docs"));
    await required(fns.read)(qualified("docs"));
    return first;
  }), silentLogger)({ code: "async () => null" });
  expect(output.structuredContent).toMatchObject({ result: { contents: [{ uri: "docs://manual/start", text: "[redacted]" }] } });
  expect((await read(registry, qualified("docs", "docs://missing"))).structuredContent).toMatchObject({ error: { code: "not_found", retryable: false } });
  const refused = await read(registry, qualified("docs", "docs://refused"));
  expect(refused.structuredContent).toMatchObject({ error: { code: "invalid_args", message: "Refused [redacted]", retryable: false } });
  expect(JSON.stringify(refused)).not.toContain(token);
  expect((await read(registry, qualified("docs", "docs://input"))).structuredContent).toMatchObject({ error: { code: "input_required_unsupported", retryable: false } });
  const payloads = await Promise.all(requests.filter(request => request.method === "POST").map(request => request.json() as Promise<{ method: string; params?: { uri: string } }>));
  expect(payloads.filter(body => body.method === "resources/read").map(body => body.params?.uri)).toEqual(["docs://manual/start", "docs://manual/start", "docs://missing", "docs://refused", "docs://input"]);
  expect(payloads.some(body => body.method === "tools/list")).toBe(false);
  expect(requests.every(request => request.url.startsWith(downstream.url))).toBe(true);
  expect(requests.filter(request => request.method === "POST").every(request => request.headers.get("X-API-Key") === token)).toBe(true);
});
