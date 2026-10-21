import { describe, expect, it } from "vitest";
import { compactSchema, compactDiscoverySchema, lexicalCorpusStatistics, rankTools } from "../src/catalog.js";
import { CatalogService } from "../src/catalog-service.js";
import { BASE } from "./fixtures/meta-tools.js";
import { calcConnector, makeRegistry } from "./helpers.js";
import { connectorWith } from "./fixtures/connectors.js";
import type { JsonSchema, ToolDef } from "../src/types.js";

describe("lexical tool ranking", () => {
  it("matches whole tokens rather than arbitrary substrings", () => {
    const tools: ToolDef[] = [
      {
        name: "enlist_members",
        description: "Enroll members in a cohort",
      },
      {
        name: "blacklist_entry",
        description: "Block an entry",
      },
      {
        name: "read_record",
        description: "Read one stored record",
      },
    ];

    expect(rankTools(tools, "list", "partial")).toEqual([]);
    expect(rankTools(tools, "audio recording", "partial")).toEqual([]);
  });

  it("finds camel-case names and narrow inflectional variants", () => {
    const tools: ToolDef[] = [
      {
        name: "searchDriveFiles",
        description: "Locate documents",
      },
      {
        name: "searchMessages",
        description: "Locate conversations",
      },
      {
        name: "getURLMetadata",
        description: "Inspect a link",
      },
      {
        name: "createDriveFiles",
        description: "Add documents",
      },
    ];

    expect(rankTools(tools, "search drive file").map(({ tool }) => tool.name)).toEqual(["searchDriveFiles"]);
    expect(rankTools(tools, "url metadata").map(({ tool }) => tool.name)).toEqual(["getURLMetadata"]);
    expect(rankTools(tools, "created drive file").map(({ tool }) => tool.name)).toEqual(["createDriveFiles"]);
  });

  it("weights a rare domain term above a ubiquitous action term", () => {
    const generic: ToolDef[] = Array.from({ length: 12 }, (_, index) => ({
      name: `get_record_${index}`,
      description: "Get a record by identifier",
    }));
    const domain: ToolDef[] = [
      {
        name: "invoice_summary",
        description: "Summarize an invoice",
      },
    ];
    const query = "get invoice";
    const statistics = lexicalCorpusStatistics([generic, domain], query);
    const ranked = [
      ...rankTools(generic, query, "partial", statistics),
      ...rankTools(domain, query, "partial", statistics),
    ].sort((a, b) => b.score - a.score);

    expect(ranked[0]?.tool.name).toBe("invoice_summary");
  });
});

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

describe("compactSchema allOf", () => {
  it("intersects the branches instead of emitting raw JSON", () => {
    const schema: JsonSchema = {
      $defs: {
        Base: {
          type: "object",
          properties: {
            id: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
          required: ["id"],
        },
      },
      allOf: [
        { $ref: "#/$defs/Base" },
        {
          type: "object",
          properties: {
            name: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["name"],
        },
      ],
    };

    const rendered = compactSchema(schema);
    // Before the allOf branch existed this fell through to
    // JSON.stringify(schema), which is not a compact rendering at all — on a
    // real connector it measured *longer* than the raw schema.
    expect(rendered.length).toBeLessThan(JSON.stringify(schema).length / 2);
    expect(rendered).toBe(
      '{ id: string, createdAt?: string /* format "date-time" */ } & ' + "{ name: string, tags?: string[] }",
    );
  });

  it("keeps locally declared properties alongside allOf members", () => {
    // The usual OpenAPI-derived "extend this base" shape. allOf must compose
    // with the schema's own properties, not replace them — dropping either
    // half loses declared fields, and the local half is the more specific one.
    const schema: JsonSchema = {
      type: "object",
      properties: {
        localOnly: { type: "string" },
        id: { type: "number" },
      },
      required: ["localOnly"],
      allOf: [
        {
          type: "object",
          properties: { inherited: { type: "string" } },
        },
      ],
    };

    const rendered = compactSchema(schema);
    expect(rendered).toBe("{ localOnly: string, id?: number } & { inherited?: string }");
    for (const key of ["localOnly", "id", "inherited"]) {
      expect(rendered).toContain(key);
    }
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

  it("caps compact describe at 8,192 UTF-8 bytes including property prose", () => {
    const text = compactSchema({
      type: "object",
      properties: { id: { type: "string", description: "😀".repeat(10_000) } },
    });
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(8_192);
    expect(text).toContain("/* truncated */");
  });

  it("bounds raw JSON fallback", () => {
    let schema: JsonSchema = { type: "string" };
    for (let depth = 0; depth < 10_000; depth += 1) {
      schema = { not: schema };
    }
    expect(compactDiscoverySchema(schema)).toEqual({
      text: "unknown /* truncated */",
      truncated: true,
    });
    expect(compactSchema(schema)).toBe("unknown /* truncated */");
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
  it.each([-1, "1"])("rejects invalid offset %s", async (offset) => {
    const service = new CatalogService(makeRegistry([calcConnector]), BASE);
    await expect(service.search({ offset: offset as number })).rejects.toMatchObject({
      code: "invalid_args",
      message: expect.stringContaining("offset must be"),
    });
  });

  it.each([1].map((query) => [query]))("rejects non-string query %s", async (query) => {
    const service = new CatalogService(makeRegistry([calcConnector]), BASE);
    await expect(service.search({ query: query as string })).rejects.toMatchObject({
      code: "invalid_args",
      message: expect.stringContaining("query must be"),
    });
  });

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
      name: "dynamic reference",
      schema: { $defs: { Entry: { type: "string" } }, $dynamicRef: "#Entry" },
      text: "string",
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
