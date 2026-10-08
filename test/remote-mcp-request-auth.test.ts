import { afterEach, expect, it, vi } from "vitest";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { memoryStorage } from "../src/storage/memory.js";
import { connectorContext, deferred } from "./fixtures/misc.js";
import { apiFixture, context, SENTINEL } from "./fixtures/github-api.js";
import { makeRegistry, silentLogger } from "./helpers.js";
import { classifyCatalog, reviewedCatalog, reviewedClassification } from "../src/catalog-drift.js";
import { createTestConnecta } from "./helpers.js";
import type { Connector, ToolClassification } from "../src/types.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("INV-7: request auth binds each scope to its own token and forwards only declared catalog headers", async () => {
  const fixture = apiFixture(); const first = context(); const second = context();
  const callback = vi.fn(async (ctx) => ctx === first ? "ghs_first" : "ghs_second");
  const connector = remoteMcp("github", { url: "https://api.githubcopilot.com/mcp/", auth: { type: "request", token: callback, headers: { "X-MCP-Tools": "get_file_contents" } } });
  try {
    await Promise.all([connector.callTool("get_file_contents", { owner: "acme", repo: "one" }, first), connector.callTool("get_file_contents", { owner: "other", repo: "one" }, second)]);
    const calls = fixture.requests.filter((request) => request.body?.method === "tools/call");
    expect(calls.map((request) => request.headers.get("authorization")).sort()).toEqual(["Bearer ghs_first", "Bearer ghs_second"]);
    for (const request of calls) expect(request.headers.get("X-MCP-Tools")).toBe("get_file_contents");
    expect(callback).toHaveBeenCalledWith(first); expect(callback).toHaveBeenCalledWith(second);
    const app = createTestConnecta({ connectors: [connector], logger: silentLogger, publicUrl: "https://connecta.test" });
    try {
      const config = JSON.stringify(app.describeConfig());
      expect(config).toContain('"mode":"request"'); expect(config).not.toContain("ghs_first"); expect(config).not.toContain("ghs_second");
    } finally { await app.close(); }
  } finally { await connector.closeScope?.(first); await connector.closeScope?.(second); }
});

it("INV-7: request auth cannot start a transport after cancellation or scope close", async () => {
  const fixture = apiFixture(); const pending = deferred<string>();
  const controller = new AbortController(); const ctx = context({ signal: controller.signal });
  const connector = remoteMcp("github", { url: "https://api.githubcopilot.com/mcp/", auth: { type: "request", token: () => pending.promise } });
  const call = connector.callTool("get_file_contents", {}, ctx).catch((error) => error);
  controller.abort(new Error("cancelled")); await connector.closeScope?.(ctx); pending.resolve("ghs_cancelled");
  expect(await call).toBeDefined(); expect(fixture.fetchStub).not.toHaveBeenCalled();
});

it("INV-5: malformed request tokens and resolver errors are refused without rendering secret text", async () => {
  const fixture = apiFixture();
  for (const token of [async () => `${SENTINEL}\n`, async () => { throw new Error(SENTINEL); }]) {
    const connector = remoteMcp("github", { url: "https://api.githubcopilot.com/mcp/", auth: { type: "request", token } });
    const ctx = context();
    try { await expect(connector.listTools(ctx)).rejects.toSatisfy((error: any) => error.code === "auth_required" && !error.message.includes(SENTINEL)); }
    finally { await connector.closeScope?.(ctx); }
  }
  expect(fixture.fetchStub).not.toHaveBeenCalled();
});

it("INV-11: request auth rejects personal ownership, callback/header mistakes and cleartext origins", () => {
  const options = { url: "https://api.githubcopilot.com/mcp/", auth: { type: "request" as const, token: async () => "ghs_fixture" } };
  expect(() => remoteMcp("github", { ...options, authScope: "personal" })).toThrow("shared authScope");
  expect(() => remoteMcp("github", { ...options, auth: { type: "request", token: "bad" as never } })).toThrow("callback");
  expect(() => remoteMcp("github", { ...options, auth: { ...options.auth, headers: { Authorization: SENTINEL } } })).toThrow("without Authorization");
  expect(() => remoteMcp("github", { ...options, url: "http://github.example/mcp" })).toThrow("not https");
});

it("INV-1: exact hide mode filters explicit unlisted reads on fresh and persisted catalogs", async () => {
  const storage = memoryStorage(); const ctx = connectorContext(storage);
  const calls = vi.fn(async () => ({})); const source = [
    { name: "listed", annotations: { readOnlyHint: true } },
    { name: "unlisted", annotations: { readOnlyHint: true } },
  ];
  const classify: ToolClassification = { unlisted: "hide", tools: { listed: "read" } };
  const connector: Connector = { id: "github", classification: classify, listTools: async () => source, callTool: calls };
  const first = makeRegistry([connector], { storage });
  expect((await first.getTools("github", "https://connecta.test")).map((tool) => tool.name)).toEqual(["listed"]);
  const failed = vi.fn(async () => { throw new Error("offline"); });
  const restarted = makeRegistry([{ ...connector, listTools: failed }], { storage });
  expect((await restarted.getTools("github", "https://connecta.test")).map((tool) => tool.name)).toEqual(["listed"]);
  const current = reviewedCatalog(classify, "github");
  const tools = await classifyCatalog(current, "github", source, ctx.logger);
  expect(tools.map((tool) => tool.name)).toEqual(["listed"]);
  const requestAuth = vi.fn(async () => "ghs_unused");
  const remote = remoteMcp("github", { url: "https://api.githubcopilot.com/mcp/", classify, auth: { type: "request", token: requestAuth } });
  await expect(remote.callTool("unlisted", {}, ctx)).rejects.toMatchObject({ code: "invalid_args" });
  expect(requestAuth).not.toHaveBeenCalled();
});

it("INV-11: allowlist mode is validated and deep-frozen as public classification data", () => {
  expect(() => reviewedClassification({ tools: {}, unlisted: "read" } as never, "github")).toThrow('unlisted must be "hide"');
  expect(() => reviewedClassification({ tools: {}, extra: true } as never, "github")).toThrow("unknown key");
  const input = { tools: { listed: "read" as const }, unlisted: "hide" as const };
  const frozen = reviewedClassification(input, "github");
  expect(frozen.unlisted).toBe("hide"); expect(Object.isFrozen(frozen)).toBe(true);
});

it("INV-1: a changing unlisted accessor is captured once and cannot discard the hide policy", async () => {
  let reads = 0;
  const classification = { tools: { listed: "read" }, get unlisted() { return ++reads <= 2 ? "hide" : undefined; } } as unknown as ToolClassification;
  const frozen = reviewedClassification(classification, "github");
  expect(reads).toBe(1); expect(frozen.unlisted).toBe("hide");
  const catalog = reviewedCatalog(frozen, "github");
  expect(await classifyCatalog(catalog, "github", [{ name: "unlisted", annotations: { readOnlyHint: true } }], connectorContext().logger)).toEqual([]);
});
