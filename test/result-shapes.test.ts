import { describe, expect, it, vi } from "vitest";
import { CatalogService } from "../src/catalog-service.js";
import { InvocationService } from "../src/invocation.js";
import { ObservedOutputSchemas } from "../src/result-shapes.js";
import type { Connector, JsonSchema, ToolDef } from "../src/types.js";
import { makeRegistry, required } from "./helpers.js";

const BASE = "https://connecta.test";

function shapeTool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: "list_issues",
    description: "List issues",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
    annotations: { readOnlyHint: true },
    ...overrides,
  };
}

function shapeConnector(tool: ToolDef, values: unknown[]): Connector {
  let call = 0;
  return {
    id: "linear",
    kind: "api",
    description: "Linear",
    async listTools() {
      return [tool];
    },
    async callTool() {
      return values[Math.min(call++, values.length - 1)];
    },
  };
}

async function invokeOnce(
  registry: ReturnType<typeof makeRegistry>,
): Promise<Awaited<ReturnType<InvocationService["invoke"]>>> {
  return new InvocationService(
    registry,
    new CatalogService(registry, BASE),
  ).invoke("linear.list_issues", { limit: 1 }, {
    source: "call_tool",
    unwrapResult: true,
  });
}

describe("observed output schemas", () => {
  it("keeps field names and broad JSON types without retaining scalar values", () => {
    const shapes = new ObservedOutputSchemas();
    const tool = shapeTool();
    shapes.observe("linear", tool, {
      cursor: "secret-cursor",
      hasNextPage: true,
      issues: [
        {
          id: "BP-442",
          priority: { name: "Urgent", value: 1 },
          metadata: { Salary: "private" },
          labels: ["customer"],
          nullable: null,
        },
      ],
    });

    const schema = required(shapes.get("linear", tool));
    expect(schema).toEqual({
      type: "object",
      properties: {
        cursor: { type: "string" },
        hasNextPage: { type: "boolean" },
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              labels: { type: "array", items: { type: "string" } },
              metadata: {
                type: "object",
                properties: { Salary: { type: "string" } },
              },
              nullable: { type: "null" },
              priority: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  value: { type: "number" },
                },
              },
            },
          },
        },
      },
    });
    const serialized = JSON.stringify(schema);
    expect(serialized).not.toContain("secret-cursor");
    expect(serialized).not.toContain("BP-442");
    expect(serialized).not.toContain("Urgent");
    expect(serialized).not.toContain("customer");
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain('"required"');
    expect(serialized).not.toContain('"additionalProperties"');
  });

  it("merges fields and broad types across observations", () => {
    const shapes = new ObservedOutputSchemas();
    const tool = shapeTool();
    shapes.observe("linear", tool, {
      issues: [{ id: "one", title: "First", state: null, details: null }],
    });
    shapes.observe("linear", tool, {
      issues: [
        {
          id: "two",
          comments: 3,
          state: "started",
          details: { team: "BP" },
        },
      ],
    });
    shapes.observe("linear", tool, {
      issues: [{ id: "three", details: { project: "Connecta" } }],
    });

    expect(shapes.get("linear", tool)).toEqual({
      type: "object",
      properties: {
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              comments: { type: "number" },
              details: {
                anyOf: [
                  { type: "null" },
                  {
                    type: "object",
                    properties: {
                      project: { type: "string" },
                      team: { type: "string" },
                    },
                  },
                ],
              },
              id: { type: "string" },
              state: {
                anyOf: [{ type: "null" }, { type: "string" }],
              },
              title: { type: "string" },
            },
          },
        },
      },
    });
  });

  it("bounds hostile breadth, depth, property names, and cycles after merges", () => {
    const shapes = new ObservedOutputSchemas();
    const tool = shapeTool();
    const value: Record<string, unknown> = {};
    for (let index = 0; index < 80; index++) value[`field_${index}`] = index;
    value["x".repeat(129)] = "hidden";
    Object.defineProperty(value, "__proto__", {
      configurable: true,
      enumerable: true,
      value: "ignored",
    });
    value["constructor"] = "ignored";
    value["prototype"] = "ignored";
    let nested: Record<string, unknown> = value;
    for (let depth = 0; depth < 20; depth++) {
      nested.child = {};
      nested = nested.child as Record<string, unknown>;
    }
    value.cycle = value;
    shapes.observe("linear", tool, value);

    const second: Record<string, unknown> = {};
    for (let index = 80; index < 160; index++) {
      second[`field_${index}`] = index;
    }
    shapes.observe("linear", tool, second);

    const schema = required(shapes.get("linear", tool));
    const properties = required(
      schema.properties as Record<string, JsonSchema> | undefined,
    );
    expect(Object.keys(properties).length).toBeLessThanOrEqual(48);
    expect(properties["x".repeat(129)]).toBeUndefined();
    expect(Object.hasOwn(properties, "__proto__")).toBe(false);
    expect(Object.hasOwn(properties, "constructor")).toBe(false);
    expect(Object.hasOwn(properties, "prototype")).toBe(false);
    expect(JSON.stringify(schema).length).toBeLessThan(16 * 1024);
    expect(() => JSON.stringify(schema)).not.toThrow();
  });

  it("ignores declarations, destructive tools, and changed definitions", () => {
    const shapes = new ObservedOutputSchemas();
    const original = shapeTool();
    shapes.observe("linear", original, { issues: [{ id: "one" }] });
    expect(shapes.get("linear", original)).toBeDefined();

    const declared = shapeTool({
      outputSchema: {
        type: "object",
        properties: { declared: { type: "boolean" } },
      },
    });
    shapes.observe("linear", declared, { actual: "ignored" });
    expect(shapes.get("linear", declared)).toBeUndefined();
    expect(shapes.get("linear", original)).toBeUndefined();

    shapes.observe("linear", original, { issues: [{ id: "two" }] });
    const changed = shapeTool({ description: "List current workspace issues" });
    expect(shapes.get("linear", changed)).toBeUndefined();

    shapes.observe("linear", original, { issues: [{ id: "three" }] });
    const oversized = shapeTool({ description: "x".repeat(64 * 1024) });
    expect(shapes.get("linear", oversized)).toBeUndefined();
    expect(shapes.get("linear", original)).toBeUndefined();

    const destructive = shapeTool({
      annotations: { readOnlyHint: false, destructiveHint: true },
    });
    shapes.observe("linear", original, { issues: [{ id: "four" }] });
    shapes.observe("linear", destructive, { created: { id: "one" } });
    expect(shapes.get("linear", destructive)).toBeUndefined();
    expect(shapes.get("linear", original)).toBeUndefined();
  });

  it("expires after 24 hours and never crosses runtime instances", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const shapes = new ObservedOutputSchemas();
      const tool = shapeTool();
      shapes.observe("linear", tool, { issues: [{ id: "one" }] });
      expect(shapes.get("linear", tool)).toBeDefined();
      expect(new ObservedOutputSchemas().get("linear", tool)).toBeUndefined();

      vi.setSystemTime(new Date("2026-01-02T00:00:00.001Z"));
      expect(shapes.get("linear", tool)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the LRU and returns copies that callers cannot use to poison it", () => {
    const shapes = new ObservedOutputSchemas();
    for (let index = 0; index < 256; index++) {
      const tool = shapeTool({ name: `tool_${index}` });
      shapes.observe("linear", tool, { index });
    }
    expect(
      shapes.get("linear", shapeTool({ name: "tool_0" })),
    ).toBeDefined();
    const newest = shapeTool({ name: "tool_256" });
    shapes.observe("linear", newest, { index: 256 });
    expect(
      shapes.get("linear", shapeTool({ name: "tool_1" })),
    ).toBeUndefined();
    expect(
      shapes.get("linear", shapeTool({ name: "tool_0" })),
    ).toBeDefined();
    const first = required(shapes.get("linear", newest));
    (first.properties as Record<string, unknown>).poisoned = {
      type: "boolean",
    };
    expect(shapes.get("linear", newest)).toEqual({
      type: "object",
      properties: { index: { type: "number" } },
    });
  });

  it("adds an explicitly observed shape to later search and describe calls", async () => {
    const tool = shapeTool();
    const registry = makeRegistry([
      shapeConnector(tool, [
        { cursor: "next", issues: [{ id: "one", title: "First" }] },
      ]),
    ]);
    const catalog = new CatalogService(registry, BASE);

    const before = await catalog.search({
      query: "list issues",
      connector: "linear",
      includeSchemas: "json",
      includeSchemaKeys: true,
    });
    expect(required(before.entries[0]).tool.outputSchema).toBeUndefined();

    expect((await invokeOnce(registry)).ok).toBe(true);
    const observedLookup = vi.spyOn(registry, "observedOutputSchema");
    await catalog.search({ query: "list issues", connector: "linear" });
    expect(observedLookup).not.toHaveBeenCalled();
    observedLookup.mockRestore();

    const after = await catalog.search({
      query: "list issues",
      connector: "linear",
      includeSchemas: "json",
      includeSchemaKeys: true,
    });
    const discovered = required(after.entries[0]).tool;
    expect(discovered.outputSchemaSource).toBe("observed");
    expect(discovered.outputKeys).toEqual(["cursor", "issues"]);

    const [described] = await catalog.describe({
      address: "linear.list_issues",
      format: "json",
    });
    expect(required(described).outputSchemaSource).toBe("observed");
    expect(required(described).outputSchema).toEqual(discovered.outputSchema);
  });

  it("learns the unwrapped MCP value rather than its content envelope", async () => {
    const tool = shapeTool();
    const connector: Connector = {
      id: "linear",
      kind: "mcp",
      description: "Linear",
      async listTools() {
        return [tool];
      },
      async callTool() {
        return {
          content: [{ type: "text", text: "fallback" }],
          structuredContent: {
            issues: [{ id: "one" }],
            hasNextPage: false,
          },
        };
      },
    };
    const registry = makeRegistry([connector]);
    const outcome = await new InvocationService(
      registry,
      new CatalogService(registry, BASE),
    ).invoke("linear.list_issues", {}, {
      source: "call_tool",
      unwrapResult: false,
    });
    expect(outcome.ok).toBe(true);

    const page = await new CatalogService(registry, BASE).search({
      query: "list issues",
      connector: "linear",
      includeSchemas: "json",
      includeSchemaKeys: true,
    });
    const discovered = required(page.entries[0]).tool;
    expect(discovered.outputKeys).toEqual(["hasNextPage", "issues"]);
    expect(JSON.stringify(discovered.outputSchema)).not.toContain("content");
    expect(JSON.stringify(discovered.outputSchema)).not.toContain("fallback");
  });

  it("keeps completed calls successful when observation cannot inspect a result", async () => {
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, "hostile", {
      enumerable: true,
      get() {
        throw new Error("do not inspect me");
      },
    });
    const tool = shapeTool();
    const registry = makeRegistry([shapeConnector(tool, [value])]);

    expect((await invokeOnce(registry)).ok).toBe(true);
    expect(registry.observedOutputSchema("linear", tool)).toBeUndefined();
    const observer = vi.spyOn(registry, "observeOutputShape");
    observer.mockImplementation(() => {
      throw new Error("observation unavailable");
    });
    expect((await invokeOnce(registry)).ok).toBe(true);
    observer.mockRestore();
  });

  it("keeps provider declarations authoritative in discovery", async () => {
    const declaredSchema: JsonSchema = {
      type: "object",
      properties: { declared: { type: "boolean" } },
      required: ["declared"],
      additionalProperties: false,
    };
    const tool = shapeTool({ outputSchema: declaredSchema });
    const registry = makeRegistry([
      shapeConnector(tool, [{ actual: "different" }]),
    ]);
    expect((await invokeOnce(registry)).ok).toBe(true);

    const page = await new CatalogService(registry, BASE).search({
      query: "list issues",
      connector: "linear",
      includeSchemas: "json",
      includeSchemaKeys: true,
    });
    expect(required(page.entries[0]).tool.outputSchema).toEqual(declaredSchema);
    expect(
      required(page.entries[0]).tool.outputSchemaSource,
    ).toBeUndefined();
  });
});
