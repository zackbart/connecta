import { describe, expect, it } from "vitest";
import { compactSchema } from "../src/catalog.js";
import type { JsonSchema } from "../src/types.js";

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
      "{ id: string, createdAt?: string } & { name: string, tags?: string[] }",
    );
  });

  it("renders an empty allOf as unknown", () => {
    expect(compactSchema({ allOf: [] })).toBe("unknown");
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
