import type { Tool } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { bearerToken } from "../src/auth/bearer.js";
import {
  MAX_CATALOG_CHUNK_BYTES,
  MAX_SERIALIZED_CATALOG_BYTES,
} from "../src/catalog-limits.js";
import { createExecuteTool } from "../src/execute.js";
import type { Executor } from "../src/types.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { createMetaTools, type ToolResult } from "../src/meta-tools.js";
import { memoryStorage } from "../src/storage/memory.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { createTestConnecta, makeRegistry, required, seedCatalog, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function fixture(legacy = false, destructive = false) {
  const requests: Array<{ method: string; headers: Headers }> = [];
  let output: unknown = { n: 42 };
  const definitions: Tool[] = [
    {
      name: "numeric",
      title: "Numeric result",
      icons: [{ src: "https://downstream.test/icon.png", mimeType: "image/png" }],
      inputSchema: { type: "object" },
      outputSchema: {
        type: "object",
        properties: { n: { type: "number" } },
        required: ["n"],
      },
      annotations: { readOnlyHint: true },
      _meta: { "example.com/unrelated": "do not persist" },
    },
    {
      name: "mirrored",
      inputSchema: {
        type: "object",
        properties: { tenant: { type: "string", "x-mcp-header": "Tenant" } },
        required: ["tenant"],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "task_required",
      inputSchema: { type: "object" },
      execution: { taskSupport: "required" },
      annotations: { readOnlyHint: true },
    },
  ];
  definitions.push({ name: "hidden", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } });
  if (destructive) {
    for (const tool of definitions) tool.annotations = { readOnlyHint: false, destructiveHint: true };
  }
  const downstream = httpDownstream((server) => {
    server.registerTool("mirrored", {
      inputSchema: z.object({ tenant: z.string().meta({ "x-mcp-header": "Tenant" }) }),
      annotations: { readOnlyHint: true },
    }, async () => ({ content: [] }));
    // Raw handlers let the server return an invalid result deliberately, while
    // its registered schema still enforces header/body parity before dispatch.
    server.server.setRequestHandler("tools/list", async () => ({ tools: definitions }));
    server.server.setRequestHandler("tools/call", async () => ({
      content: [{ type: "text", text: "ran" }],
      ...(output !== undefined ? { structuredContent: output } : {}),
    }));
  }, {
    capture: async (request) => {
      if (request.method !== "POST") return;
      const message = await request.json() as { method: string };
      requests.push({ method: message.method, headers: request.headers });
    },
  });
  const connector = remoteMcp("down", {
    url: downstream.url,
    versionNegotiation: legacy ? "legacy" : "auto",
    _transportFactory: () => {
      const transport = downstream.transport();
      closers.push(() => transport.close());
      return transport;
    },
  });
  return { connector, definitions, requests, setOutput: (value: unknown) => { output = value; } };
}

const cases = [
  { cache: "same request", caller: "call_tool", view: "root" },
  { cache: "memory", caller: "call_tool", view: "root" },
  ...(["root", "scoped", "pool"] as const).flatMap((view) =>
    (["call_tool", "call_destructive_tool", "connecta.call"] as const).map((caller) =>
      ({ cache: "storage", caller, view } as const))),
] as const;

describe.each(cases)("downstream definitions from $cache via $caller in $view", ({ cache, caller, view }) => {
  async function prepared(legacy = false) {
    const f = fixture(legacy, caller === "call_destructive_tool");
    const storage = memoryStorage();
    let registry = makeRegistry([f.connector], { storage });
    let meta = createMetaTools(registry, BASE);
    if (cache === "same request") {
      await meta.searchTools({ query: "numeric" });
    } else {
      const scope = {};
      await registry.getTools("down", BASE, scope);
      await f.connector.closeScope!(registry.contextFor("down", BASE, scope));
      if (cache === "storage") registry = makeRegistry([f.connector], { storage });
      meta = createMetaTools(registry, BASE);
    }
    // A tiny executor drives the actual program provider and returns its errors
    // just as a guest would. The sandbox itself is covered by executor suites.
    let target = { address: "", args: {} as Record<string, unknown> };
    const executor: Executor = {
      async execute(_code, providers) {
        const provider = required(providers.find((p) => p.name === "connecta"));
        try {
          return { result: await required(provider.fns.call)(target.address, target.args) };
        } catch (err) {
          return { result: undefined, error: (err as Error).message };
        }
      },
    };
    const allowed = ["down.numeric", "down.mirrored", "down.task_required"];
    const scoped = registry.scoped({
      connectorIds: ["down"],
      toolAccess: new Map([["down", new Set(["numeric", "mirrored", "task_required"])]]),
      subjectKey: "reader",
    });
    const callRegistry = view === "scoped" ? scoped : registry;
    const callMeta = view === "scoped" ? createMetaTools(callRegistry, BASE) : meta;
    const execute = createExecuteTool(callRegistry, BASE, executor, silentLogger);
    const deployment = view === "pool" ? createTestConnecta({
      connectors: [f.connector], storage, publicUrl: BASE, executor, logger: silentLogger,
      auth: bearerToken("reader", { subjectId: "reader" }),
      identity: { connectorAccess: () => allowed },
      pools: { readers: { tools: allowed, grant: () => true } },
    }) : undefined;
    if (deployment) closers.push(() => deployment.close());
    const invoke = async (address: string, args: Record<string, unknown>): Promise<ToolResult> => {
      target = { address, args };
      const code = `async () => await connecta.call(${JSON.stringify(address)}, ${JSON.stringify(args)})`;
      if (deployment) {
        const response = await mcpRpc(deployment, "tools/call", {
          name: caller === "connecta.call" ? "execute_code" : caller,
          arguments: caller === "connecta.call" ? { code } : {
            address, args,
            ...(caller === "call_destructive_tool" ? { reason: "Regression coverage" } : {}),
          },
        }, { query: "/readers", token: "reader" });
        expect(response.status).toBe(200);
        return (await readJsonRpc(response)).result as ToolResult;
      }
      if (caller === "connecta.call") return execute({ code });
      if (caller === "call_destructive_tool") return callMeta.callDestructiveTool({ address, args, reason: "Regression coverage" });
      return callMeta.callTool({ address, args });
    };
    f.requests.length = 0;
    return { ...f, invoke, registry };
  }

  it("validates invalid, missing, and conforming structured output", async () => {
    const f = await prepared();
    f.setOutput({ n: "wrong" });
    const invalid = await f.invoke("down.numeric", {});
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid)).toMatch(/output schema/i);
    f.setOutput(undefined);
    const missing = await f.invoke("down.numeric", {});
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing)).toMatch(/did not return structured content/i);
    f.setOutput({ n: 42 });
    const valid = await f.invoke("down.numeric", {});
    expect(valid.isError).toBeFalsy();
    if (caller !== "connecta.call") expect(required(valid.content[0]).text).toBe("ran");
    expect(f.requests.filter((r) => r.method === "tools/list")).toHaveLength(0);
    expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(3);
  });

  it("mirrors parameters on the first modern HTTP call without relisting or retry", async () => {
    const f = await prepared();
    const result = await f.invoke("down.mirrored", { tenant: "acme" });
    expect(result.isError).toBeFalsy();
    const calls = f.requests.filter((r) => r.method === "tools/call");
    expect(calls).toHaveLength(1);
    expect(required(calls[0]).headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
    expect(required(calls[0]).headers.get("Mcp-Param-Tenant")).toBe("acme");
    expect(f.requests.filter((r) => r.method === "tools/list")).toHaveLength(0);
  });

  it("refuses required-task tools before sending tools/call", async () => {
    // Tasks are 2025-era vocabulary; the modern SDK removes execution.
    const f = await prepared(true);
    const result = await f.invoke("down.task_required", {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/requires task-based execution/i);
    expect(f.requests.filter((r) => r.method === "tools/call" || r.method === "tools/list")).toHaveLength(0);
  });

  if (view !== "root") {
    it("refuses a stored tool outside the granted slice before dispatch", async () => {
      const f = await prepared();
      const result = await f.invoke("down.hidden", {});
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/unknown_tool/);
      expect(f.requests.filter((r) => r.method === "tools/call" || r.method === "tools/list")).toHaveLength(0);
    });
  }

  it("retains allowlisted display/execution fields and excludes unrelated metadata", async () => {
    const f = await prepared(true);
    const tools = await f.registry.getTools("down", BASE, {});
    expect(tools[0]).toMatchObject({
      title: "Numeric result",
      icons: required(f.definitions[0]).icons,
      outputSchema: required(f.definitions[0]).outputSchema,
    });
    expect(tools[0]).not.toHaveProperty("_meta");
    expect(tools[2]).toMatchObject({ execution: { taskSupport: "required" } });
  });
});

it("still calls tools from older stored catalogs without the added metadata or an input schema", async () => {
  const f = fixture();
  const storage = memoryStorage();
  await seedCatalog(storage, "down", "numeric");
  const registry = makeRegistry([f.connector], { storage });
  const meta = createMetaTools(registry, BASE);
  const result = await meta.callTool({ address: "down.numeric", args: {} });
  expect(result.isError).toBeFalsy();
  expect(f.requests.filter((r) => r.method === "tools/list")).toHaveLength(0);
});

describe.each([
  { label: "chunk boundary", iconBytes: MAX_CATALOG_CHUNK_BYTES + 1, descriptionBytes: MAX_CATALOG_CHUNK_BYTES, chunkCount: 2 },
  { label: "catalog ceiling", iconBytes: MAX_SERIALIZED_CATALOG_BYTES + 1, descriptionBytes: 0, chunkCount: 1 },
])("inline icons over the $label", ({ iconBytes, descriptionBytes, chunkCount }) => {
  it("omits data payloads, retains URL icons, and reloads a complete bounded catalog", async () => {
    const f = fixture(true);
    const numeric = required(f.definitions[0]);
    const urlIcons = required(numeric.icons);
    numeric.icons = [
      { src: `data:image/png;base64,${"A".repeat(iconBytes)}`, mimeType: "image/png" },
      // URI schemes are case-insensitive, including on the exclusion path.
      { src: "DATA:image/svg+xml,<svg/>", mimeType: "image/svg+xml" },
      ...urlIcons,
    ];
    numeric.description = "x".repeat(descriptionBytes);
    required(f.definitions[1]).icons = [{ src: "data:image/png;base64,AAAA" }];
    const storage = memoryStorage();
    const registry = makeRegistry([f.connector], { storage });
    const scope = {};
    const tools = await registry.getTools("down", BASE, scope);
    const rawTools = await f.connector.listTools(registry.contextFor("down", BASE, scope));
    await f.connector.closeScope!(registry.contextFor("down", BASE, scope));
    expect(required(tools[0]).icons).toEqual(urlIcons);
    expect(required(tools[1]).icons).toEqual([]);
    expect(numeric.icons[0]?.src.length).toBeGreaterThan(iconBytes);

    const manifest = JSON.parse((await storage.get("catalog:down"))!) as {
      revision: string; toolCount: number; byteCount: number; chunkCount: number;
    };
    expect(manifest).toMatchObject({ toolCount: f.definitions.length, chunkCount });
    const serialized = JSON.stringify(rawTools);
    expect(manifest.byteCount).toBe(new TextEncoder().encode(serialized).byteLength);
    expect(manifest.byteCount).toBeLessThan(MAX_SERIALIZED_CATALOG_BYTES);
    const chunks: string[] = [];
    for (let index = 0; index < manifest.chunkCount; index++) {
      const chunk = (await storage.get(`catalog:down:chunk:${manifest.revision}:${index}`))!;
      expect(new TextEncoder().encode(chunk).byteLength).toBeLessThanOrEqual(MAX_CATALOG_CHUNK_BYTES);
      chunks.push(chunk);
    }
    expect(chunks.join("")).toBe(serialized);
    expect(serialized).not.toMatch(/data:/i);

    f.requests.length = 0;
    const reloaded = makeRegistry([f.connector], { storage });
    expect(await reloaded.getTools("down", BASE, {})).toEqual(tools);
    f.setOutput({ n: "wrong" });
    const result = await createMetaTools(reloaded, BASE).callTool({ address: "down.numeric", args: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/output schema/i);
    expect(f.requests.filter((r) => r.method === "tools/list")).toHaveLength(0);
    expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(1);
  });
});
