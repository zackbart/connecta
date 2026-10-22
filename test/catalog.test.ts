import { describe, expect, it } from "vitest";
import { CatalogService } from "../src/catalog-service.js";
import { compactDiscoverySchema, compactSchema } from "../src/catalog.js";
import type { JsonSchema } from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";
import { BASE } from "./fixtures/meta-tools.js";
import { calcConnector, makeRegistry } from "./helpers.js";

describe("compactSchema const", () => {
  it("renders a discriminated union with its discriminator values", () => {
    // The standard "one of these request bodies" shape. Without `const` every
    // branch renders as `{ type: string, … }` and the field that selects the
    // branch is erased, which is exactly the information the caller needs.
    const schema: JsonSchema = {
      oneOf: [
        {
          type: "object",
          properties: {
            type: { type: "string", const: "emoji" },
            emoji: { type: "string" },
          },
          required: ["type", "emoji"],
        },
        {
          type: "object",
          properties: {
            type: { type: "string", const: "external" },
            external: {
              type: "object",
              properties: { url: { type: "string" } },
              required: ["url"],
            },
          },
          required: ["type", "external"],
        },
      ],
    };

    const rendered = compactSchema(schema);
    expect(rendered).toBe('{ type: "emoji", emoji: string } | ' + '{ type: "external", external: { url: string } }');
    expect(rendered).toContain('"emoji"');
    expect(rendered).toContain('"external"');
  });
});

describe("compactSchema $ref handling", () => {
  it("stops at a recursive $ref instead of looping forever", () => {
    const schema: JsonSchema = {
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: { $ref: "#/$defs/Node" },
          },
          required: ["value"],
        },
      },
      $ref: "#/$defs/Node",
    };

    expect(compactSchema(schema)).toBe("{ value: string, next?: Node }");
  });
});

function branchingSchema(width: number, onLeafRead?: () => void): JsonSchema {
  const $defs: Record<string, unknown> = {};
  for (let level = 0; level < 4; level += 1) {
    $defs[`Level${level}`] = {
      allOf: Array.from({ length: width }, () => {
        if (level !== 3) return { $ref: `#/$defs/Level${level + 1}` };
        const leaf = { type: "object", properties: { id: { type: "string" } } };
        if (onLeafRead)
          Object.defineProperty(leaf, "type", {
            get: () => {
              onLeafRead();
              return "object";
            },
            enumerable: true,
          });
        return leaf;
      }),
    };
  }
  return { $defs, $ref: "#/$defs/Level0" };
}

describe("bounded catalog rendering", () => {
  it("bounds repeated allOf references in both compact routes", () => {
    for (const render of [compactDiscoverySchema, compactSchema]) {
      let leafReads = 0;
      const schema = branchingSchema(40, () => {
        leafReads += 1;
        // A broken work guard must not make this synchronous test walk 40⁴
        // branches before its assertion gets a chance to run.
        if (leafReads > 2_000) throw new Error("schema work guard exceeded");
      });
      const result = render(schema);
      const text = typeof result === "string" ? result : result.text;
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(1_024);
      expect(text).toContain("/* truncated */");
      expect(leafReads).toBeGreaterThan(0);
      expect(leafReads).toBeLessThanOrEqual(2_000);
      if (typeof result !== "string") expect(result.truncated).toBe(true);
    }
  });

  it("keeps multibyte composites at the byte limit and counts their punctuation", () => {
    const prefix = "{ value?: string // ";
    const suffix = " }";
    const room = 8_192 - prefix.length - suffix.length;
    const description = "😀".repeat(Math.floor(room / 4)) + "x".repeat(room % 4);
    const object = (text: string) => ({
      type: "object",
      properties: { value: { type: "string", description: text } },
    });
    const expected = `${prefix}${description}${suffix}`;
    expect(new TextEncoder().encode(expected).length).toBe(8_192);
    expect(compactSchema(object(description))).toBe(expected);
    expect(compactSchema(object(description + "x"))).toContain("/* truncated */");

    const value = "😀".repeat(2_047);
    const tuple = (text: string) => ({ prefixItems: [{ const: text }], items: false });
    const expectedTuple = `[${JSON.stringify(value)}]`;
    expect(new TextEncoder().encode(expectedTuple).length).toBe(8_192);
    expect(compactSchema(tuple(value))).toBe(expectedTuple);
    expect(compactSchema(tuple(value + "x"))).toContain("/* truncated */");
  });

  it("stops visiting a wide schema after the work budget", () => {
    let visits = 0;
    const member = {
      get type() {
        visits += 1;
        return "string";
      },
    };
    const schema = { allOf: Array.from({ length: 10_000 }, () => member) };
    expect(compactDiscoverySchema(schema).truncated).toBe(true);
    expect(visits).toBeLessThanOrEqual(2_000);
  });

  it("marks both describe schemas when their compact rendering is capped", async () => {
    const schema = branchingSchema(40);
    const connector = connectorWith({
      id: "pathological",
      call: async () => null,
      tools: [{ name: "read", inputSchema: schema, outputSchema: schema }],
    });
    const service = new CatalogService(makeRegistry([connector]), BASE);
    const [entry] = await service.describe({ address: "pathological.read" });
    expect(entry).toMatchObject({
      inputSchemaTruncated: true,
      outputSchemaTruncated: true,
    });
    expect(new TextEncoder().encode(entry!.inputSchema as string).length).toBeLessThanOrEqual(1_024);
    const [exact] = await service.describe({
      address: "pathological.read",
      format: "json",
    });
    expect(exact!.inputSchema).toEqual(schema);
    expect(exact).not.toHaveProperty("inputSchemaTruncated");
  });
});

describe("catalog search argument validation", () => {
  it("refuses an oversized connector scope instead of echoing a clipped one", async () => {
    const service = new CatalogService(makeRegistry([calcConnector]), BASE);
    await expect(service.search({ connector: "c".repeat(50_000) })).rejects.toMatchObject({
      code: "invalid_args",
      message: "connector must be at most 512 UTF-8 bytes.",
    });
    // Exactly 512 bytes is still an ordinary (unknown) scope, not a refusal.
    const analysed = await service.search({ query: "add", connector: "x".repeat(512) });
    expect(analysed.total).toBe(0);
  });
});

describe("2020-12 schemas in search and describe", () => {
  const cases: Array<{
    name: string;
    schema: JsonSchema;
    text: string;
    truncated?: boolean;
  }> = [
    {
      name: "tuple",
      schema: {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "number" }],
        items: { type: "boolean" },
      },
      text: "[string, number, ...boolean[]]",
    },
    {
      name: "open tuple",
      schema: { prefixItems: [{ type: "string" }] },
      text: "[string, ...unknown[]]",
    },
    {
      name: "closed tuple",
      schema: { prefixItems: [{ type: "string" }], items: false },
      text: "[string]",
    },
    {
      name: "union rest",
      schema: {
        prefixItems: [{ type: "string" }],
        items: { anyOf: [{ type: "number" }, { type: "boolean" }] },
      },
      text: "[string, ...(number | boolean)[]]",
    },
    {
      name: "dependentSchemas",
      schema: {
        type: "object",
        properties: { id: { type: "string" } },
        dependentSchemas: { id: { required: ["other"] } },
      },
      text: "{ id?: string } /* conditional */",
      truncated: true,
    },
    {
      name: "conditional",
      schema: {
        type: "object",
        properties: { mode: { type: "string" } },
        if: { required: ["mode"] },
        // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema keyword, not a promise method.
        then: { required: ["value"] },
        else: { required: ["fallback"] },
      },
      text: "{ mode?: string } /* conditional */",
      truncated: true,
    },
    {
      name: "bare conditional",
      schema: {
        if: { type: "string" },
        // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema keyword, not a promise method.
        then: { minLength: 2 },
        else: { type: "number" },
      },
      text: "unknown /* conditional */",
      truncated: true,
    },
    {
      name: "allOf conditional",
      schema: {
        allOf: [{ type: "string" }],
        if: { const: "a" },
        // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema keyword, not a promise method.
        then: { minLength: 2 },
      },
      text: "string /* conditional */",
      truncated: true,
    },
    {
      name: "dynamic reference",
      schema: { $defs: { Entry: { type: "string" } }, $dynamicRef: "#Entry" },
      text: "string",
    },
    {
      name: "dynamic pointer",
      schema: { $defs: { Entry: { type: "number" } }, $dynamicRef: "#/$defs/Entry" },
      text: "number",
    },
    {
      name: "unknown dynamic reference",
      schema: { $dynamicRef: "#Missing" },
      text: "unknown",
      truncated: true,
    },
  ];
  it.each(cases)("renders $name honestly in both routes", async ({ schema, text, truncated }) => {
    const service = new CatalogService(
      makeRegistry([
        connectorWith({
          id: "shapes",
          call: async () => null,
          tools: [{ name: "read", inputSchema: schema, outputSchema: schema }],
        }),
      ]),
      BASE,
    );
    const page = await service.search({ includeSchemas: "compact" });
    const [description] = await service.describe({ address: "shapes.read" });
    for (const tool of [page.entries[0]!.tool, description!]) {
      expect(tool.inputSchema).toBe(text);
      expect(tool.outputSchema).toBe(text);
      expect(tool.inputSchemaTruncated).toBe(truncated);
      expect(tool.outputSchemaTruncated).toBe(truncated);
    }
    const exactPage = await service.search({ includeSchemas: "json" });
    const [exactDescription] = await service.describe({ address: "shapes.read", format: "json" });
    for (const tool of [exactPage.entries[0]!.tool, exactDescription!]) {
      expect(tool.inputSchema).toEqual(schema);
      expect(tool.inputSchemaTruncated).toBeUndefined();
    }
  });
});
