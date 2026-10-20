import { describe, expect, it } from "vitest";
import { authoredTools, pendingAdditions, surfaceViolations, type ToolFacts } from "./provider-standard.js";
import { memoryStorage } from "../src/storage/memory.js";
import { silentLogger } from "./helpers.js";

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});
const strings = { type: "array", items: { type: "string" } };
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
      inputSchema: object({ path: { type: "string" }, ...(part !== "upload" ? { fields: strings } : {}) }),
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
        fields: strings,
      }),
      outputSchema: object({ items: { type: "array" }, page: page(), truncated: strings }, ["items", "page"]),
    },
    {
      name: "get_charge",
      annotations: READ,
      inputSchema: object({ chargeId: { type: "string" }, fields: strings }),
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
      "optional items",
      "S3",
      (tool: any) => {
        tool.outputSchema.required = ["page"];
      },
    ],
    [
      "optional page",
      "S3",
      (tool: any) => {
        tool.outputSchema.required = ["items"];
      },
    ],
    [
      "page: string",
      "S2",
      (tool: any) => {
        tool.outputSchema.properties.page.type = "string";
      },
    ],
    [
      "hasMore: string",
      "S2",
      (tool: any) => {
        tool.outputSchema.properties.page.properties.hasMore = { type: "string" };
      },
    ],
    [
      "optional hasMore",
      "S2",
      (tool: any) => {
        tool.outputSchema.properties.page.required = [];
      },
    ],
    [
      "nextCursor: number",
      "S2",
      (tool: any) => {
        tool.outputSchema.properties.page.properties.nextCursor = { type: "number" };
      },
    ],
    [
      "total: string",
      "S2",
      (tool: any) => {
        tool.outputSchema.properties.page.properties.total = { type: "string" };
      },
    ],
    [
      "fields: number",
      "S5",
      (tool: any) => {
        tool.inputSchema.properties.fields = { type: "number" };
      },
    ],
    [
      "fields: number[]",
      "S5",
      (tool: any) => {
        tool.inputSchema.properties.fields = { type: "array", items: { type: "number" } };
      },
    ],
    [
      "truncated: number[]",
      "S3",
      (tool: any) => {
        tool.outputSchema.properties.truncated = { type: "array", items: { type: "number" } };
      },
    ],
    [
      "truncated without item type",
      "S3",
      (tool: any) => {
        tool.outputSchema.properties.truncated = { type: "array" };
      },
    ],
    [
      "cursor: number",
      "S2",
      (tool: any) => {
        tool.inputSchema.properties.cursor = { type: "number" };
      },
    ],
    [
      "limit: string",
      "S2",
      (tool: any) => {
        tool.inputSchema.properties.limit.type = "string";
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
      "missing cursor",
      "S2",
      (tool: any) => {
        delete tool.inputSchema.properties.cursor;
      },
    ],
    [
      "select",
      "S5",
      (tool: any) => {
        tool.inputSchema.properties.select = strings;
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

  it.each(["page", "perPage", "per_page", "page_size", "pageSize", "offset", "start_cursor", "maxRows"])(
    "rejects retired input paging key %s",
    (key) => {
      expect(
        surfaceViolations(
          changed("list_charges", (tool) => {
            tool.inputSchema.properties[key] = { type: "integer" };
          }),
        ),
      ).toContain(`S2: list_charges takes ${key}; page with limit and cursor`);
    },
  );

  it.each(["nextPage", "nextOffset", "next", "param", "in", "path", "totalCount", "page", "limit"])(
    "rejects retired named-page key %s",
    (key) => {
      expect(
        surfaceViolations(
          changed("list_charges", (tool) => {
            tool.outputSchema.properties.page.properties[key] = {};
          }),
        ),
      ).toContain(`S2: list_charges page reports retired key ${key}`);
    },
  );

  it.each(["read", "write", "upload"])("rejects a %s hatch with a result wrapper", (part) => {
    expect(
      surfaceViolations(
        changed(`acme_api_${part}`, (tool) => {
          tool.outputSchema = object({ result: {} }, ["result"]);
        }),
      ),
    ).toContain(`S3: acme_api_${part} returns { status: integer, data, page? }, with status and data required`);
  });

  it.each([
    [
      "status: string",
      (tool: any) => {
        tool.outputSchema.properties.status = { type: "string" };
      },
    ],
    [
      "optional status",
      (tool: any) => {
        tool.outputSchema.required = ["data"];
      },
    ],
    [
      "optional data",
      (tool: any) => {
        tool.outputSchema.required = ["status"];
      },
    ],
    [
      "absent data",
      (tool: any) => {
        delete tool.outputSchema.properties.data;
      },
    ],
  ])("rejects hatch %s", (_label, update) => {
    expect(surfaceViolations(changed("acme_api_read", update))).toContain(
      "S3: acme_api_read returns { status: integer, data, page? }, with status and data required",
    );
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

  it.each(["api", "dual", "composed"])(
    "rejects %s without an authored fixture, even without H metadata",
    async (kind) => {
      await expect(authoredTools(kind, { name: "acme" }, context)).rejects.toThrow(
        "needs an offline createAuthored() fixture",
      );
    },
  );

  it("rejects empty authored fixtures and accepts hosted-only absence", async () => {
    await expect(
      authoredTools("api", { name: "acme", createAuthored: () => ({ listTools: async () => [] }) }, context),
    ).rejects.toThrow("not an empty catalog");
    expect(await authoredTools("mcp", { name: "acme" }, context)).toBeUndefined();
  });

  it("checks authored tools independently of missing H metadata", async () => {
    const tools = await authoredTools(
      "dual",
      {
        name: "acme",
        createAuthored: () => ({ listTools: async () => [{ name: "acme_api_get", inputSchema: { type: "object" } }] }),
      },
      context,
    );
    expect(surfaceViolations(tools!)).toContain("S1: acme_api_get is not a standard hatch tool");
  });

  it("rejects additions and reinsertions even if both pending lists and their baseline are edited", () => {
    const previous = { step1: ["alice"], step2: ["alice", "bob"] };
    // These represent the baseline committed alongside the corresponding PENDING edit.
    expect(
      pendingAdditions({ step1: ["alice", "new-provider"], step2: ["alice", "bob", "new-provider"] }, previous),
    ).toEqual(["step1: added or reinserted new-provider", "step2: added or reinserted new-provider"]);
    expect(pendingAdditions({ step1: ["alice", "bob"], step2: ["alice", "bob"] }, previous)).toEqual([
      "step1: added or reinserted bob",
    ]);
    expect(pendingAdditions({ step1: [], step2: ["bob"] }, previous)).toEqual([]);
  });
});
