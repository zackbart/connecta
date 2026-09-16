import { describe, expect, it } from "vitest";
import {
  compactSchema,
  compactDiscoverySchema,
  schemaObjectKeys,
  lexicalCorpusStatistics,
  rankTools,
} from "../src/catalog.js";
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

    expect(
      rankTools(tools, "search drive file").map(({ tool }) => tool.name),
    ).toEqual(["searchDriveFiles"]);
    expect(
      rankTools(tools, "url metadata").map(({ tool }) => tool.name),
    ).toEqual(["getURLMetadata"]);
    expect(
      rankTools(tools, "created drive file").map(({ tool }) => tool.name),
    ).toEqual(["createDriveFiles"]);
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

  it("keeps action terms as ranking evidence", () => {
    const tools: ToolDef[] = [
      {
        name: "list_invoices",
        description: "List invoices",
      },
      {
        name: "get_invoice",
        description: "Get one invoice",
      },
    ];

    expect(
      rankTools(tools, "get invoice", "partial")
        .sort((a, b) => b.score - a.score)
        .map(({ tool }) => tool.name),
    ).toEqual(["get_invoice", "list_invoices"]);
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
    expect(rendered).toBe(
      '{ type: "emoji", emoji: string } | ' +
        '{ type: "external", external: { url: string } }',
    );
    expect(rendered).toContain('"emoji"');
    expect(rendered).toContain('"external"');
  });

  it("renders const literals of every JSON type", () => {
    expect(compactSchema({ const: "emoji" })).toBe('"emoji"');
    expect(compactSchema({ const: 7 })).toBe("7");
    expect(compactSchema({ const: false })).toBe("false");
    expect(compactSchema({ const: null })).toBe("null");
    expect(compactSchema({ const: { kind: "page" } })).toBe('{"kind":"page"}');
  });

  it("falls back to the declared type when const is undefined", () => {
    // JSON.stringify(undefined) returns the value undefined rather than a
    // string, so an unguarded const branch would splice the literal text
    // "undefined" into the rendered schema.
    const rendered = compactSchema({ type: "string", const: undefined });
    expect(rendered).toBe("string");
    expect(rendered).not.toContain("undefined");

    const bare = compactSchema({ const: undefined });
    expect(bare).not.toContain("undefined");
  });

  it("still renders enum unions", () => {
    expect(compactSchema({ type: "string", enum: ["a", "b"] })).toBe(
      '"a" | "b"',
    );
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
      '{ id: string, createdAt?: string /* format "date-time" */ } & ' +
        "{ name: string, tags?: string[] }",
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
    expect(rendered).toBe(
      "{ localOnly: string, id?: number } & { inherited?: string }",
    );
    for (const key of ["localOnly", "id", "inherited"]) {
      expect(rendered).toContain(key);
    }
  });

  it("keeps a sibling $ref alongside allOf members", () => {
    const schema: JsonSchema = {
      $defs: {
        Base: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
      $ref: "#/$defs/Base",
      allOf: [
        { type: "object", properties: { extra: { type: "boolean" } } },
      ],
    };

    expect(compactSchema(schema)).toBe(
      "{ id: string } & { extra?: boolean }",
    );
  });

  it("keeps a sibling enum, const, or items alongside allOf members", () => {
    // These can't be dropped either. A union half is parenthesized so the
    // rendering doesn't read as `"a" | ("b" & …)`.
    expect(
      compactSchema({
        enum: ["a", "b"],
        allOf: [{ type: "string" }],
      }),
    ).toBe('("a" | "b") & string');

    expect(
      compactSchema({
        const: "emoji",
        allOf: [{ type: "string" }],
      }),
    ).toBe('"emoji" & string');

    expect(
      compactSchema({
        type: "array",
        items: { type: "string" },
        allOf: [{ type: "array" }],
      }),
    ).toBe("string[] & unknown[]");
  });

  it("only parenthesizes a union at the top level of a part", () => {
    // A pipe inside a property description or a nested union is not a
    // top-level separator and must not attract parentheses.
    expect(
      compactSchema({
        type: "object",
        properties: {
          mode: { type: "string", description: "fast | slow" },
        },
        allOf: [{ type: "object", properties: { id: { type: "string" } } }],
      }),
    ).toBe(
      "{ mode?: string // fast | slow } & { id?: string }",
    );
  });

  it("renders an empty allOf as unknown", () => {
    expect(compactSchema({ allOf: [] })).toBe("unknown");
  });

  it("renders an empty allOf beside properties as just the properties", () => {
    expect(
      compactSchema({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        allOf: [],
      }),
    ).toBe("{ name: string }");
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

  it("names an unresolvable $ref rather than failing", () => {
    expect(compactSchema({ $ref: "#/$defs/Missing" })).toBe("Missing");
  });

  it("resolves refs declared under definitions as well as $defs", () => {
    const schema: JsonSchema = {
      definitions: {
        Point: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
          required: ["x", "y"],
        },
      },
      $ref: "#/definitions/Point",
    };

    expect(compactSchema(schema)).toBe("{ x: number, y: number }");
  });
});

describe("compactSchema depth limit", () => {
  it("elides anything nested deeper than four levels", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        a: {
          type: "object",
          properties: {
            b: {
              type: "object",
              properties: {
                c: {
                  type: "object",
                  properties: {
                    d: {
                      type: "object",
                      properties: { e: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    expect(compactSchema(schema)).toBe(
      "{ a?: { b?: { c?: { d?: { e?: … } } } } }",
    );
  });
});

describe("compactSchema caching", () => {
  it("returns the identical string for a repeated schema object", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const first = compactSchema(schema);
    expect(compactSchema(schema)).toBe(first);
    expect(first).toBe("{ name: string }");
  });
});

describe("compactSchema 2020-12 keyword compatibility", () => {
  it("keeps the callable shape compact when schemas use exotic validation keywords", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["basic", "token"] },
        apiKey: { type: "string" },
      },
      required: ["mode"],
      dependentSchemas: {
        apiKey: {
          properties: { mode: { const: "token" } },
        },
      },
      unevaluatedProperties: false,
    };

    expect(compactSchema(schema)).toBe(
      '{ mode: "basic" | "token", apiKey?: string }',
    );
  });
});

function branchingSchema(width: number): JsonSchema {
  const $defs: Record<string, unknown> = {};
  for (let level = 0; level < 4; level += 1) {
    $defs[`Level${level}`] = {
      allOf: Array.from({ length: width }, () =>
        level === 3
          ? { type: "object", properties: { id: { type: "string" } } }
          : { $ref: `#/$defs/Level${level + 1}` },
      ),
    };
  }
  return { $defs, $ref: "#/$defs/Level0" };
}

describe("bounded catalog rendering", () => {
  it("bounds repeated allOf references in both compact routes", () => {
    for (const render of [compactDiscoverySchema, compactSchema]) {
      const schema = branchingSchema(40);
      const started = performance.now();
      const result = render(schema);
      const elapsed = performance.now() - started;
      const text = typeof result === "string" ? result : result.text;
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(1_024);
      expect(elapsed).toBeLessThan(50);
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

  it("renders a repeated reference target once per walk", () => {
    let visits = 0;
    const schema = {
      $defs: {
        Value: {
          get type() {
            visits += 1;
            return "string";
          },
        },
      },
      allOf: Array.from({ length: 20 }, () => ({ $ref: "#/$defs/Value" })),
    };
    expect(compactDiscoverySchema(schema).truncated).toBe(false);
    expect(visits).toBe(1);
  });

  it("keeps an enum complete when only the truncation marker would overflow", () => {
    const values = Array.from({ length: 20 }, (_, index) => `value-${index}`);
    expect(compactDiscoverySchema({ enum: values })).toEqual({
      text: values.map((value) => JSON.stringify(value)).join(" | "),
      truncated: false,
    });
  });

  it("bounds raw JSON fallback", () => {
    let schema: JsonSchema = { type: "string" };
    for (let depth = 0; depth < 10_000; depth += 1) {
      schema = { if: schema };
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
    expect(new TextEncoder().encode(entry!.inputSchema as string).length)
      .toBeLessThanOrEqual(1_024);
    const [exact] = await service.describe({
      address: "pathological.read", format: "json",
    });
    expect(exact!.inputSchema).toEqual(schema);
    expect(exact).not.toHaveProperty("inputSchemaTruncated");
  });

  it("omits undeclared required names from key metadata", async () => {
    const schema = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id", "ghost"],
    };
    expect(schemaObjectKeys(schema)).toEqual({
      properties: ["id"], required: ["id"],
    });
    const connector = connectorWith({
      id: "keys",
      call: async () => null,
      tools: [{ name: "read", inputSchema: schema }],
    });
    const service = new CatalogService(makeRegistry([connector]), BASE);
    const page = await service.search({
      includeSchemas: "compact", includeSchemaKeys: true,
    });
    expect(page.entries[0]!.tool.requiredInputKeys).toEqual(["id"]);
  });
});

describe("catalog search argument validation", () => {
  it.each([NaN, Infinity, -Infinity, -1, 0.5, "abc", "1", null])(
    "rejects invalid offset %s", async (offset) => {
      const service = new CatalogService(makeRegistry([calcConnector]), BASE);
      await expect(service.search({ offset: offset as number })).rejects.toMatchObject({
        code: "invalid_args",
        message: expect.stringContaining("offset must be"),
      });
    },
  );

  it.each([null, 1, false, {}, []].map((query) => [query]))(
    "rejects non-string query %s", async (query) => {
      const service = new CatalogService(makeRegistry([calcConnector]), BASE);
      await expect(service.search({ query: query as string })).rejects.toMatchObject({
        code: "invalid_args",
        message: expect.stringContaining("query must be"),
      });
    },
  );

  it("keeps omitted and whole-number offsets", async () => {
    const service = new CatalogService(makeRegistry([calcConnector]), BASE);
    expect((await service.search({})).offset).toBe(0);
    expect((await service.search({ offset: 1 })).offset).toBe(1);
  });
});
