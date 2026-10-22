import { describe, expect, it } from "vitest";
import { CatalogService } from "../src/catalog-service.js";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { createMetaTools } from "../src/meta-tools.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { makeRegistry } from "./helpers.js";

const BASE = "https://connecta.test";

function connection(kind: "custom" | "api" | "mcp", readOnly?: boolean) {
  let dispatched = 0;
  const tools = [
    { name: "read", description: "Read a record", annotations: { readOnlyHint: true } },
    { name: "write", description: "Write a record", annotations: { readOnlyHint: false } },
    { name: "unknown", description: "An unclassified operation" },
    {
      name: "contradiction",
      description: "Contradictory behavior hints",
      annotations: { readOnlyHint: true, destructiveHint: true },
    },
  ];
  const call = () => {
    dispatched++;
    return { ok: true };
  };
  let connector: Connector;
  if (kind === "api") {
    connector = api("notes", {
      ...(readOnly !== undefined ? { readOnly } : {}),
      tools: tools
        .filter((tool) => tool.name !== "unknown")
        .map((tool) => ({ ...tool, annotations: tool.annotations!, handler: call })),
    });
  } else if (kind === "mcp") {
    const downstream = httpDownstream((server) => {
      for (const tool of tools)
        server.registerTool(
          tool.name,
          { description: tool.description, ...(tool.annotations ? { annotations: tool.annotations } : {}) },
          async () => {
            call();
            return { content: [{ type: "text", text: "ok" }] };
          },
        );
    });
    connector = remoteMcp("notes", {
      url: downstream.url,
      auth: { type: "headers", headers: {} },
      ...(readOnly !== undefined ? { readOnly } : {}),
      _transportFactory: downstream.transport,
    });
  } else {
    connector = {
      id: "notes",
      ...(readOnly !== undefined ? { readOnly } : {}),
      listTools: async () => tools,
      callTool: async () => call(),
    };
  }
  return { connector, dispatched: () => dispatched };
}

describe.each(["custom", "api", "mcp"] as const)("%s connector readOnly", (kind) => {
  it("INV-1 INV-2: omits non-read tools from discovery and refuses both direct call paths before dispatch", async () => {
    const state = connection(kind, true);
    const registry = makeRegistry([state.connector]);
    const service = new CatalogService(registry, BASE);
    const meta = createMetaTools(registry, BASE, { readOnly: false });
    const page = await service.search({ connector: "notes", safety: "all" });
    expect(page.entries.map((entry) => entry.tool.address)).toEqual(["notes.read"]);
    for (const name of ["write", "contradiction", ...(kind === "api" ? [] : ["unknown"])]) {
      const described = await service.describe({ address: `notes.${name}` });
      expect(described[0]).toMatchObject({ error: expect.anything() });
      for (const invoke of [meta.callTool, meta.callDestructiveTool]) {
        const result = await invoke({ address: `notes.${name}`, args: {} });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: { code: "read_only_endpoint", retryable: false } });
        expect(result.structuredContent).toMatchObject({
          error: { message: expect.stringContaining('connector "notes" is read-only') },
        });
      }
    }
    expect(state.dispatched()).toBe(0);
    expect((await meta.callTool({ address: "notes.read" })).isError).not.toBe(true);
    expect(state.dispatched()).toBe(1);
  });

  it("INV-2: defaults writable and connector false cannot reopen a read-only endpoint", async () => {
    for (const readOnly of [undefined, false]) {
      const state = connection(kind, readOnly);
      const registry = makeRegistry([state.connector]);
      const writable = createMetaTools(registry, BASE, { readOnly: false });
      expect((await writable.callDestructiveTool({ address: "notes.write" })).isError).not.toBe(true);
      const restricted = new CatalogService(registry, BASE, { readOnly: true });
      expect((await restricted.search({ connector: "notes" })).entries.map((entry) => entry.tool.address)).toEqual([
        "notes.read",
      ]);
      const refused = await createMetaTools(registry, BASE, { readOnly: true }).callDestructiveTool({
        address: "notes.write",
      });
      expect(refused.structuredContent).toMatchObject({ error: { code: "read_only_endpoint" } });
      expect(state.dispatched()).toBe(1);
    }
  });
});

it("INV-2 INV-4: result paging rechecks connector readOnly after a policy change", async () => {
  const storage = memoryStorage();
  const connector = api("notes", {
    tools: [
      {
        name: "read",
        description: "Read a long record",
        annotations: { readOnlyHint: true },
        handler: () => "x".repeat(5000),
      },
      {
        name: "write",
        description: "Write a long record",
        annotations: { readOnlyHint: false },
        handler: () => "x".repeat(5000),
      },
    ],
  });
  const registry = () => makeRegistry([connector], { storage, maxResultBytes: 1000 });
  const before = createMetaTools(registry(), BASE, { readOnly: false });
  const handle = async (address: string) => {
    const result = await before.callDestructiveTool({ address });
    const notice = JSON.parse(result.content[0]!.text!.split("\n")[0]!);
    expect(notice.resultId).toEqual(expect.any(String));
    return notice.resultId as string;
  };
  const writeId = await handle("notes.write");
  const readId = await handle("notes.read");
  connector.readOnly = true;
  const after = createMetaTools(registry(), BASE, { readOnly: false });
  expect((await after.readResult({ id: writeId })).isError).toBe(true);
  expect((await after.readResult({ id: readId })).isError).not.toBe(true);
});
