import { describe, expect, it } from "vitest";
import { memoryStorage } from "../src/storage/memory.js";
import { silentLogger } from "./helpers.js";
import { authoredTools, surfaceViolations, type ToolFacts } from "./provider-standard.js";

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});
const strings = { type: "array", items: { type: "string" } };
const fieldsAt = (anchor: string, example: string) => ({
  ...strings,
  description: `Dot paths to keep. Paths start at ${anchor}, e.g. ["${example}"]. It only narrows the result.`,
});
const page = () =>
  object({ hasMore: { type: "boolean" }, nextCursor: { type: "string" }, total: { type: "integer" } }, ["hasMore"]);
const READ = { readOnlyHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true };

function standard(): ToolFacts[] {
  return [
    {
      name: "acme_api_search",
      annotations: READ,
      inputSchema: object({ query: { type: "string" } }),
      outputSchema: object({ operations: { type: "array" }, revision: { type: "string" } }, ["operations", "revision"]),
    },
    {
      name: "acme_api_details",
      annotations: READ,
      inputSchema: object({ method: { type: "string" }, path: { type: "string" } }),
    },
    ...["read", "write", "upload"].map((part) => ({
      name: `acme_api_${part}`,
      annotations: part === "read" ? READ : DESTRUCTIVE,
      inputSchema: object({
        path: { type: "string" },
        ...(part !== "upload"
          ? { fields: fieldsAt("the response body in data, each item when the body is a list", "id") }
          : {}),
      }),
      outputSchema: object(
        {
          status: { type: "integer" },
          data: {},
          page: object(
            { ...page().properties, param: { type: "string" }, in: { type: "string", enum: ["query", "body"] } },
            ["hasMore", "param", "in"],
          ),
        },
        ["status", "data"],
      ),
    })),
    {
      name: "list_charges",
      annotations: READ,
      inputSchema: object({
        limit: { type: "integer", default: 25, maximum: 100 },
        cursor: { type: "string" },
        fields: fieldsAt("each item in items", "amount.currency"),
      }),
      outputSchema: object(
        {
          items: {
            type: "array",
            items: object({ id: { type: "string" }, amount: object({ currency: { type: "string" } }) }),
          },
          page: page(),
          truncated: strings,
        },
        ["items", "page"],
      ),
    },
    {
      name: "get_charge",
      annotations: READ,
      inputSchema: object({ chargeId: { type: "string" }, fields: fieldsAt("the result", "id") }),
      outputSchema: object({ id: { type: "string" } }, ["id"]),
    },
  ];
}

function changed(name: string, update: (tool: any) => void): ToolFacts[] {
  const tools = structuredClone(standard());
  update(tools.find((tool) => tool.name === name)!);
  return tools;
}

describe("standard authored tool surfaces on both runtimes (decision 0011)", () => {
  it("accepts typed envelopes, optional cursors, projections, and hatch pages", () => {
    expect(surfaceViolations(standard())).toEqual([]);
    const capped = changed("list_charges", (tool) => {
      delete tool.inputSchema.properties.cursor;
      tool.outputSchema.properties.page = object({ hasMore: { const: false } }, ["hasMore"]);
    });
    capped.push({
      name: "update_person",
      annotations: DESTRUCTIVE,
      inputSchema: object({ values: { type: "array", items: object({ fieldId: { type: "string" } }) } }),
    });
    expect(surfaceViolations(capped)).toEqual([]);
    const mutable = structuredClone(capped) as any[];
    mutable.find((t) => t.name === "list_charges").outputSchema.properties.page.properties.hasMore = {
      type: "boolean",
    };
    expect(surfaceViolations(mutable)).toContain("S2: list_charges pages with limit and cursor");
    for (const [label, fields, read, accepted] of [
      ["fields-enabled read with optional nested page", true, true, true],
      ["read without fields still requires hasMore", false, true, false],
      ["write with fields still requires hasMore", true, false, false],
    ] as const) {
      const fixture = {
        name: "inspect_document",
        annotations: read ? READ : DESTRUCTIVE,
        inputSchema: object(fields ? { fields: fieldsAt("the result", "page.hasMore") } : {}),
        outputSchema: object({ page: object(page().properties) }),
      };
      const findings = surfaceViolations([fixture]);
      expect(findings, label).toEqual(
        accepted
          ? []
          : ["S2: inspect_document page requires hasMore: boolean, with nextCursor?: string and total?: integer"],
      );
    }
    for (const name of ["list_charges", "acme_api_read"])
      expect(
        surfaceViolations(
          changed(name, (tool) => {
            tool.outputSchema.properties.page.required = [];
          }),
        ),
      ).toContain(`S2: ${name} page requires hasMore: boolean, with nextCursor?: string and total?: integer`);
  });

  it.each([
    [
      "items: number",
      "S3",
      (tool: any) => {
        tool.outputSchema.properties.items = { type: "number" };
      },
    ],
    [
      "unbounded limit",
      "S2",
      (tool: any) => {
        delete tool.inputSchema.properties.limit.maximum;
      },
    ],
    [
      "raw",
      "S6",
      (tool: any) => {
        tool.inputSchema.properties.raw = { type: "boolean" };
      },
    ],
  ])("rejects %s (%s)", (_label, rule, update) => {
    expect(surfaceViolations(changed("list_charges", update))).toEqual(
      expect.arrayContaining([expect.stringMatching(new RegExp(`^${rule}:`))]),
    );
  });

  it.each(["page"])("rejects retired input paging key %s", (key) => {
    expect(
      surfaceViolations(
        changed("list_charges", (tool) => {
          tool.inputSchema.properties[key] = { type: "integer" };
        }),
      ),
    ).toContain(`S2: list_charges takes ${key}; page with limit and cursor`);
  });

  it.each(["nextPage"])("rejects retired named-page key %s", (key) => {
    expect(
      surfaceViolations(
        changed("list_charges", (tool) => {
          tool.outputSchema.properties.page.properties[key] = {};
        }),
      ),
    ).toContain(`S2: list_charges page reports retired key ${key}`);
  });

  it.each([
    [
      "status: string",
      (tool: any) => {
        tool.outputSchema.properties.status = { type: "string" };
      },
    ],
  ])("rejects hatch %s", (_label, update) => {
    expect(surfaceViolations(changed("acme_api_read", update))).toContain(
      "S3: acme_api_read returns { status: integer, data, page? }, with status and data required",
    );
  });

  it.each([
    [
      "list_charges",
      "names no anchor",
      (tool: any) => (tool.inputSchema.properties.fields = strings),
      "description names its anchor and one example path",
    ],
    [
      "get_charge",
      "names the wrong anchor",
      (tool: any) => (tool.inputSchema.properties.fields = fieldsAt("each item in items", "id")),
      "paths start at result, not item",
    ],
    [
      "acme_api_read",
      "names a result anchor",
      (tool: any) => (tool.inputSchema.properties.fields = fieldsAt("the result", "id")),
      "paths start at data, not result",
    ],
    [
      "list_charges",
      "gives an undeclared example",
      (tool: any) => (tool.inputSchema.properties.fields = fieldsAt("each item in items", "amount.value")),
      "example amount.value is not a declared path at its anchor",
    ],
    [
      "get_charge",
      "gives a nested leaf example",
      (tool: any) => (tool.inputSchema.properties.fields = fieldsAt("the result", "id.value")),
      "example id.value is not a declared path at its anchor",
    ],
  ])("rejects a %s fields description that %s (S5)", (name, _label, update, finding) => {
    expect(surfaceViolations(changed(name, update))).toEqual([`S5: ${name} fields ${finding}`]);
  });

  it("requires typed operation-search results and hatch page routing", () => {
    expect(
      surfaceViolations(
        changed("acme_api_search", (tool) => {
          tool.outputSchema.required = [];
        }),
      ),
    ).toContain("S3: acme_api_search returns required operations: array and revision: string");
    expect(
      surfaceViolations(
        changed("acme_api_read", (tool) => {
          delete tool.outputSchema.properties.page.properties.param;
        }),
      ),
    ).toContain("S2: acme_api_read hatch page requires param and in strings");
  });

  it("rejects legacy hatch names and incomplete safety splits", () => {
    expect(surfaceViolations([{ name: "acme_api_get" }])).toContain("S1: acme_api_get is not a standard hatch tool");
    expect(
      surfaceViolations(
        changed("acme_api_write", (tool) => {
          tool.annotations = READ;
        }),
      ),
    ).toContain("S1: acme_api_write is annotated destructive");
  });
});

describe("provider migration enforcement cannot be bypassed by metadata", () => {
  const context = { storage: memoryStorage(), logger: silentLogger, baseUrl: "https://connecta.example" };

  it.each(["api"])("rejects %s without an authored fixture, even without H metadata", async (kind) => {
    await expect(authoredTools(kind, { name: "acme" }, context)).rejects.toThrow(
      "needs an offline createAuthored() fixture",
    );
  });

  it("rejects empty authored fixtures", async () => {
    await expect(
      authoredTools("api", { name: "acme", createAuthored: () => ({ listTools: async () => [] }) }, context),
    ).rejects.toThrow("not an empty catalog");
  });
});
