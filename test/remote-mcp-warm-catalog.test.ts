import type { Tool } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { createMetaTools } from "../src/meta-tools.js";
import { memoryStorage } from "../src/storage/memory.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { makeRegistry, required, seedCatalog } from "./helpers.js";

const BASE = "https://connecta.test";
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function fixture(legacy = false) {
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

describe.each(["same request", "memory", "storage"] as const)("downstream definitions from %s", (cache) => {
  async function prepared(legacy = false) {
    const f = fixture(legacy);
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
    f.requests.length = 0;
    return { ...f, meta, registry };
  }

  it("validates invalid, missing, and conforming structured output", async () => {
    const f = await prepared();
    f.setOutput({ n: "wrong" });
    const invalid = await f.meta.callTool({ address: "down.numeric", args: {} });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid)).toMatch(/output schema/i);
    f.setOutput(undefined);
    const missing = await f.meta.callTool({ address: "down.numeric", args: {} });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing)).toMatch(/did not return structured content/i);
    f.setOutput({ n: 42 });
    const valid = await f.meta.callTool({ address: "down.numeric", args: {} });
    expect(valid.isError).toBeFalsy();
    expect(required(valid.content[0]).text).toBe("ran");
    expect(f.requests.filter((r) => r.method === "tools/list")).toHaveLength(0);
    expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(3);
  });

  it("mirrors parameters on the first modern HTTP call without relisting or retry", async () => {
    const f = await prepared();
    const result = await f.meta.callTool({ address: "down.mirrored", args: { tenant: "acme" } });
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
    const result = await f.meta.callTool({ address: "down.task_required", args: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/requires task-based execution/i);
    expect(f.requests.filter((r) => r.method === "tools/call" || r.method === "tools/list")).toHaveLength(0);
  });

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
