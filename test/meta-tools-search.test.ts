import { describe, expect, it } from "vitest";
import { connectorWith } from "./fixtures/connectors.js";
import { BASE, connectorIds, toolsByConnector, type SearchResult, textOf } from "./fixtures/meta-tools.js";
import { api } from "../src/connectors/api.js";
import { compactDiscoverySchema, compactSchema, MAX_COMPACT_DISCOVERY_SCHEMA_BYTES } from "../src/catalog.js";
import { CatalogService } from "../src/catalog-service.js";
import { ConnectorCallError } from "../src/errors.js";
import { createMetaTools, MAX_DISCOVERY_RESULT_BYTES, MAX_SEARCH_LIMIT } from "../src/meta-tools.js";
import type { Connector } from "../src/types.js";
import { required, calcConnector, makeRegistry, remoteConnector } from "./helpers.js";

function expectStructurallyCompleteTypeShape(text: string): void {
  const pairs = new Map([
    ["}", "{"],
    ["]", "["],
    [")", "("],
  ]);
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[" || char === "(") {
      stack.push(char);
    } else {
      const opener = pairs.get(char);
      if (opener) expect(stack.pop()).toBe(opener);
    }
  }
  expect(inString).toBe(false);
  expect(stack).toEqual([]);
  expect(text).not.toContain("\uFFFD");
}

describe("structured result compatibility", () => {});

describe("describe recovery", () => {
  it("classifies and bounds catalog failures without call-path detail", async () => {
    const unavailable: Connector = connectorWith({
      id: "billing",
      kind: "api",
      tools: async () => {
        throw new ConnectorCallError("unavailable", `Upstream unavailable. ${"x".repeat(1_000)}`, {
          retryAfterMs: 30_000,
        });
      },
      call: async () => null,
    });
    const [entry] = await new CatalogService(makeRegistry([unavailable]), BASE).describe({
      addresses: ["billing.read"],
    });
    const details = required(required(entry).errorDetails);
    expect(details).toMatchObject({
      code: "unavailable",
      retryable: true,
      retryAfterMs: 30_000,
    });
    expect(Object.keys(details).sort()).toEqual(["code", "message", "retryAfterMs", "retryable"]);
    expect(Buffer.byteLength(details.message)).toBeLessThanOrEqual(515);
    expect(required(entry).error).toBe(details.message);
  });

  it("clamps several hostile misses without discarding successful descriptions", async () => {
    const unavailable: Connector = connectorWith({
      id: "billing",
      kind: "api",
      tools: async () => {
        throw new Error("catalog is unreachable");
      },
      call: async () => null,
    });
    const hostile = Array.from({ length: 6 }, (_, index) =>
      index < 2
        ? `ghost${index}.${"x".repeat(50_000)}`
        : index < 4
          ? `calc.${"y".repeat(50_000)}${index}`
          : `billing.${"z".repeat(50_000)}${index}`,
    );
    const addresses = [hostile[0]!, "calc.add", ...hostile.slice(1), "calc.add"];
    const described = await new CatalogService(makeRegistry([calcConnector, unavailable]), BASE).describe({
      addresses,
    });

    expect(described).toHaveLength(addresses.length);
    expect(required(described[1])).toMatchObject({
      address: "calc.add",
      name: "add",
    });
    expect(required(described[1]).inputSchema).toBeDefined();
    expect(required(described[7])).toEqual(required(described[1]));
    for (const index of [0, 2, 3, 4, 5, 6]) {
      const failure = required(described[index]);
      expect(failure.address).not.toBe(addresses[index]);
      expect(failure.address.endsWith("…")).toBe(true);
      expect(Buffer.byteLength(failure.address)).toBeLessThanOrEqual(515);
      expect(Buffer.byteLength(required(failure.error))).toBeLessThanOrEqual(560);
      expect(Buffer.byteLength(required(failure.errorDetails).message)).toBeLessThanOrEqual(560);
    }
    expect(Buffer.byteLength(JSON.stringify(described))).toBeLessThan(MAX_DISCOVERY_RESULT_BYTES);
  });
});

describe("search_tools", () => {
  it("does not turn a non-empty Unicode-only query into a browse", async () => {
    const query = "界".repeat(80);
    const parsed = textOf(
      await createMetaTools(makeRegistry([calcConnector, remoteConnector]), BASE).searchTools({ query }),
    ) as SearchResult;

    expect(parsed).toMatchObject({
      tools: [],
      total: 0,
      hasMore: false,
      queryAnalysis: {
        representedTerms: [],
        otherResultTerms: [],
        unmatchedTerms: [`${"界".repeat(63)}…`],
        truncated: true,
        guidance: expect.stringContaining("no searchable lexical terms"),
      },
    });
    expect(parsed.matchMode).toBeUndefined();
    expect(new TextEncoder().encode(JSON.stringify(parsed.queryAnalysis)).length).toBeLessThan(1_600);
  });

  it("filters discovery with the same fail-closed safety classification as invocation", async () => {
    const classified: Connector = connectorWith({
      id: "classified",
      kind: "api",
      staticTools: [
        {
          name: "explicit_read",
          annotations: { readOnlyHint: true },
        },
        {
          name: "explicit_read_non_destructive",
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        {
          name: "explicit_write",
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
        { name: "missing" },
        {
          name: "contradictory",
          annotations: { readOnlyHint: true, destructiveHint: true },
        },
      ],
      tools: [],
      call: async (name) => name,
    });
    const mt = createMetaTools(makeRegistry([classified]), BASE);
    const addresses = async (safety?: "readOnly" | "approvalRequired" | "all") => {
      const page = textOf(await mt.searchTools({ ...(safety ? { safety } : {}), limit: 10 })) as SearchResult;
      return page.tools.map((tool) => tool.address);
    };

    expect(await addresses("readOnly")).toEqual([
      "classified.explicit_read",
      "classified.explicit_read_non_destructive",
    ]);
    expect(await addresses("approvalRequired")).toEqual([
      "classified.explicit_write",
      "classified.missing",
      "classified.contradictory",
    ]);
    expect(await addresses()).toEqual(await addresses("all"));
    expect(await addresses()).toHaveLength(5);

    for (const address of await addresses("readOnly")) {
      expect((await mt.callTool({ address })).isError).toBeFalsy();
    }
    for (const address of await addresses("approvalRequired")) {
      const result = await mt.callTool({ address });
      expect(result.isError).toBe(true);
      expect(required(result.content[0]).text).toContain("is a write");
    }
  });

  it("does not load unrelated catalogs for a connector-scoped search", async () => {
    const loads = { wanted: 0, unrelated: 0 };
    const dynamic = (id: keyof typeof loads): Connector =>
      connectorWith({
        id,
        kind: "mcp",
        tools: async () => {
          loads[id]++;
          return [{ name: "read", description: `Read ${id} data` }];
        },
        call: async () => null,
      });
    const mt = createMetaTools(makeRegistry([dynamic("wanted"), dynamic("unrelated")]), BASE);

    const parsed = textOf(await mt.searchTools({ query: "read", connector: "wanted" })) as SearchResult;

    expect(connectorIds(parsed)).toEqual(["wanted"]);
    expect(loads).toEqual({ wanted: 1, unrelated: 0 });
  });

  it("defaults to eight results and preserves the remaining page", async () => {
    const connector: Connector = connectorWith({
      id: "default_page",
      staticTools: Array.from({ length: 12 }, (_, index) => ({
        name: `read_${String(index).padStart(2, "0")}`,
        description: "Read a deterministic item",
      })),
      tools: [],
      call: async () => null,
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const first = textOf(await mt.searchTools({})) as SearchResult;

    expect(first.limit).toBe(8);
    expect(first.total).toBe(12);
    expect(first.tools).toHaveLength(8);
    expect(first.tools[0]).not.toHaveProperty("queryCoverage");
    expect(first.nextOffset).toBe(8);

    const second = textOf(await mt.searchTools({ offset: required(first.nextOffset) })) as SearchResult;
    expect(second.limit).toBe(8);
    expect(second.tools).toHaveLength(4);
    expect(second.hasMore).toBe(false);
  });

  it("bounds page size before loading or ranking a catalog", async () => {
    let loads = 0;
    const tools = Array.from({ length: MAX_SEARCH_LIMIT }, (_, i) => ({
      name: `tool-${i}`,
    }));
    const connector: Connector = connectorWith({
      id: "large",
      tools: async () => {
        loads++;
        return tools;
      },
      call: async () => null,
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);

    for (const limit of [MAX_SEARCH_LIMIT - 1, MAX_SEARCH_LIMIT]) {
      const result = await mt.searchTools({ limit });
      expect(result.isError).toBeFalsy();
      const parsed = textOf(result) as SearchResult;
      expect(parsed.tools).toHaveLength(limit);
    }
    expect(loads).toBe(2);

    for (const limit of [MAX_SEARCH_LIMIT + 1, Number.MAX_SAFE_INTEGER]) {
      const result = await createMetaTools(makeRegistry([connector]), BASE).searchTools({ limit });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatchObject({
        error: { code: "invalid_args", retryable: false },
      });
    }
    // The rejected calls never reached listTools.
    expect(loads).toBe(2);
  });

  it("keeps action terms and returns every relevant multi-intent match", async () => {
    const connector: Connector = connectorWith({
      id: "files",
      staticTools: [
        {
          name: "search_files",
          description: "Find a drive file",
        },
        {
          name: "share_file",
          description: "Share a drive file",
        },
        {
          name: "list_folder",
          description: "List child folders",
        },
      ],
      tools: [],
      call: async () => null,
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).searchTools({
        query: "find a drive file and share it",
      }),
    ) as SearchResult;

    expect(new Set(parsed.tools.map((tool) => tool.address))).toEqual(
      new Set(["files.search_files", "files.share_file"]),
    );
    expect(parsed.matchMode).toBe("partial");
  });

  it("explains supported, mixed, partial, and absent lexical intents", async () => {
    const connector: Connector = connectorWith({
      id: "projects",
      staticTools: [
        {
          name: "list_projects",
          description: "List software projects",
        },
        {
          name: "list_deployments",
          description: "List software deployments",
        },
        {
          name: "get_project",
          description: "Get one software project by ID",
        },
      ],
      tools: [],
      call: async () => null,
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);

    const supported = textOf(await mt.searchTools({ query: "list projects deployments" })) as SearchResult;
    expect(supported.matchMode).toBe("partial");
    expect(supported.queryAnalysis).toMatchObject({
      representedTerms: ["list", "projects", "deployments"],
      otherResultTerms: [],
      unmatchedTerms: [],
      guidance: expect.stringContaining("Split distinct intents"),
    });

    const supportedFirstPage = textOf(
      await mt.searchTools({
        query: "list projects deployments",
        limit: 1,
      }),
    ) as SearchResult;
    expect(
      new Set([
        ...required(supportedFirstPage.queryAnalysis).representedTerms,
        ...required(supportedFirstPage.queryAnalysis).otherResultTerms,
      ]),
    ).toEqual(new Set(["list", "projects", "deployments"]));
    expect(required(supportedFirstPage.queryAnalysis).otherResultTerms).toHaveLength(1);

    const mixed = textOf(await mt.searchTools({ query: "list projects invoices" })) as SearchResult;
    expect(mixed.matchMode).toBe("partial");
    expect(mixed.queryAnalysis).toMatchObject({
      representedTerms: ["list", "projects"],
      otherResultTerms: [],
      unmatchedTerms: ["invoices"],
      guidance: expect.stringContaining("Split distinct intents"),
    });

    const weakPartial = textOf(
      await mt.searchTools({
        query: "get project owner billing metadata",
      }),
    ) as SearchResult;
    expect(weakPartial.matchMode).toBe("partial");
    expect(weakPartial.queryAnalysis).toMatchObject({
      representedTerms: ["get", "project"],
      unmatchedTerms: ["owner", "billing", "metadata"],
    });

    const absent = textOf(await mt.searchTools({ query: "calendar availability" })) as SearchResult;
    expect(absent).toMatchObject({
      tools: [],
      total: 0,
      queryAnalysis: {
        representedTerms: [],
        otherResultTerms: [],
        unmatchedTerms: ["calendar", "availability"],
        guidance: expect.stringContaining("No matching capability is configured in this deployment"),
      },
    });

    const scopedAbsent = textOf(
      await mt.searchTools({
        connector: "projects",
        query: "calendar availability",
      }),
    ) as SearchResult;
    expect(scopedAbsent.queryAnalysis).toMatchObject({
      connectorScope: "projects",
      unmatchedTerms: ["calendar", "availability"],
      guidance: expect.stringContaining('No matching capability was found on connector "projects"'),
    });
    expect(required(scopedAbsent.queryAnalysis).guidance).not.toContain("configured in this deployment");

    const unknownConnector = textOf(
      await mt.searchTools({
        connector: "ghost",
        query: "calendar availability",
      }),
    ) as SearchResult;
    expect(unknownConnector.queryAnalysis).toMatchObject({
      connectorScope: "ghost",
      unknownConnector: true,
      representedTerms: [],
      otherResultTerms: [],
      unmatchedTerms: ["calendar", "availability"],
      guidance: expect.stringContaining('Connector "ghost" is not configured in this deployment'),
    });
  });

  it("browses an exact connector identity and explains partial identity misses", async () => {
    const inventory: Connector = connectorWith({
      id: "inventory",
      title: "Warehouse stock",
      staticTools: [
        {
          name: "list_skus",
          description: "List every stock-keeping unit and its bin",
        },
        {
          name: "get_sku",
          description: "Get one stock-keeping unit by code",
        },
      ],
      tools: [],
      call: async () => null,
    });
    const mt = createMetaTools(makeRegistry([inventory]), BASE);

    const byId = textOf(await mt.searchTools({ query: "inventory" })) as SearchResult;
    expect(byId.tools.map((tool) => tool.address)).toEqual(["inventory.list_skus", "inventory.get_sku"]);
    expect(byId.queryAnalysis).toBeUndefined();

    // A partial title word still receives identity guidance.
    const byTitle = textOf(await mt.searchTools({ query: "warehouse" })) as SearchResult;
    expect(byTitle.total).toBe(0);
    expect(required(required(byTitle.queryAnalysis).guidance)).toContain('connector "inventory"');

    // A term the deployment really does not have keeps the stronger claim.
    const absent = textOf(await mt.searchTools({ query: "calendar" })) as SearchResult;
    expect(absent.total).toBe(0);
    expect(required(required(absent.queryAnalysis).guidance)).toContain(
      "No matching capability is configured in this deployment",
    );

    // The term cap on the serialized analysis fields is not a cap on the
    // search: ranking reads every term, so a connector named past the eighth
    // one must be named back rather than denied.
    const lateId = textOf(
      await mt.searchTools({
        query: "alpha beta gamma delta epsilon zeta eta theta inventory",
      }),
    ) as SearchResult;
    expect(lateId.total).toBe(0);
    expect(required(required(lateId.queryAnalysis).guidance)).toContain('connector "inventory"');

    const lateTitle = textOf(
      await mt.searchTools({
        query: "alpha beta gamma delta epsilon zeta eta theta warehouse",
      }),
    ) as SearchResult;
    expect(lateTitle.total).toBe(0);
    expect(required(required(lateTitle.queryAnalysis).guidance)).toContain('connector "inventory"');

    // Exact identity contributes ranking without requiring tool descriptions
    // to repeat the connector's name.
    const matched = textOf(await mt.searchTools({ query: "inventory sku" })) as SearchResult;
    expect(matched.tools.map((tool) => tool.address)).toEqual(["inventory.get_sku", "inventory.list_skus"]);
    expect(matched.queryAnalysis).toBeUndefined();
  });

  it("bounds query analysis independently of long search input", async () => {
    const query = Array.from({ length: 20 }, (_, index) => `${index}${"x".repeat(100)}`).join(" ");
    const parsed = textOf(await createMetaTools(makeRegistry([]), BASE).searchTools({ query })) as SearchResult;
    const analysis = required(parsed.queryAnalysis);

    expect(analysis.unmatchedTerms).toHaveLength(8);
    expect(analysis.unmatchedTerms.every((term) => term.length <= 64)).toBe(true);
    expect(analysis.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(analysis)).length).toBeLessThan(1_600);
  });

  it("mixes an exact action/object near-match into an all-term decoy page", async () => {
    // Development-only reproduction of #326's live Mixpanel failure. The
    // sealed discovery holdout stays unchanged; these synthetic descriptions
    // model broad business-context tools that happen to repeat every query
    // term and used to hide the exact action/object tool entirely.
    const connector: Connector = connectorWith({
      id: "analytics",
      staticTools: [
        {
          name: "List-Organizations",
          description: "List organizations available to the caller",
        },
        {
          // This partial candidate has the same strong term score as the
          // intended tool, but its extra name token makes it non-exact. It
          // must remain behind every complete match.
          name: "List-All-Organizations",
          description: "List organizations available to the caller",
        },
        ...Array.from({ length: 8 }, (_, index) => ({
          name: `business_context_${index}`,
          description: "List organizations and projects configured for business analysis",
        })),
        ...Array.from({ length: 2 }, (_, index) => ({
          name: `project_note_${index}`,
          description: "Inspect one project note",
        })),
      ],
      tools: [],
      call: async () => null,
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const first = textOf(
      await mt.searchTools({
        query: "list organizations projects",
        limit: 8,
      }),
    ) as SearchResult;

    expect(first.tools.map((tool) => tool.name)).toEqual([
      "List-Organizations",
      ...Array.from({ length: 7 }, (_, index) => `business_context_${index}`),
    ]);
    expect(first).toMatchObject({
      total: 10,
      nextOffset: 8,
      hasMore: true,
    });
    expect(first.matchMode).toBeUndefined();
    expect(first.tools.every((tool) => !("queryCoverage" in tool) && !("score" in tool))).toBe(true);

    const second = textOf(
      await mt.searchTools({
        query: "list organizations projects",
        limit: 8,
        offset: required(first.nextOffset),
      }),
    ) as SearchResult;
    expect(second.tools.map((tool) => tool.name)).toEqual(["business_context_7", "List-All-Organizations"]);
    expect(second).toMatchObject({ total: 10, hasMore: false });
    expect(second.tools.every((tool) => !("queryCoverage" in tool) && !("score" in tool))).toBe(true);

    const rawPhrase = textOf(
      await mt.searchTools({
        query: "list all organizations projects",
        limit: 8,
      }),
    ) as SearchResult;
    expect(rawPhrase.tools.map((tool) => tool.name)).toEqual([
      "List-All-Organizations",
      ...Array.from({ length: 7 }, (_, index) => `business_context_${index}`),
    ]);
    expect(rawPhrase).toMatchObject({
      total: 10,
      nextOffset: 8,
      hasMore: true,
    });
    expect(rawPhrase.matchMode).toBeUndefined();
    expect(rawPhrase.tools.every((tool) => !("queryCoverage" in tool) && !("score" in tool))).toBe(true);
  });

  it("uses deterministic partial-term ranking when no all-term match exists", async () => {
    const conn: Connector = connectorWith({
      id: "experiments",
      description: "Experiment service",
      tools: [
        {
          name: "list_experiments",
          description: "List experiments and their configuration.",
        },
        {
          name: "get_experiment",
          description: "Get experiment details including metrics and variants.",
        },
        {
          name: "get_results",
          description: "Get experiment results.",
        },
      ],
      call: async () => null,
    });
    const mt = createMetaTools(makeRegistry([conn]), BASE);
    const query = "get experiment details metrics variants results configuration";
    const first = textOf(await mt.searchTools({ query, limit: 2 })) as SearchResult;

    expect(first.matchMode).toBe("partial");
    const firstTools = first.tools;
    expect(firstTools.map((t) => t.name)).toEqual(["get_experiment", "get_results"]);
    expect(firstTools.every((tool) => !("queryCoverage" in tool) && !("score" in tool))).toBe(true);
    expect(first.queryAnalysis).toMatchObject({
      representedTerms: ["get", "experiment", "details", "metrics", "variants", "results"],
      otherResultTerms: ["configuration"],
      unmatchedTerms: [],
    });
    expect(first.total).toBe(3);
    expect(first.nextOffset).toBe(2);

    const second = textOf(
      await mt.searchTools({
        query,
        limit: 2,
        offset: required(first.nextOffset),
      }),
    ) as SearchResult;
    expect(second.matchMode).toBe("partial");
    expect(second.tools.map((tool) => tool.name)).toEqual(["list_experiments"]);
  });

  it("keeps a representative compact page within an agent-context budget", async () => {
    const propertyProse = `redundant-property-prose-${"detail ".repeat(16)}`;
    const inputSchema = {
      type: "object",
      properties: Object.fromEntries([
        ...Array.from({ length: 80 }, (_, index) => [
          `optionalField${index}`,
          { type: "string", description: propertyProse },
        ]),
        ["recordId", { type: "string", description: `${propertyProse} required` }],
      ]),
      required: ["recordId"],
    };
    const connector: Connector = connectorWith({
      id: "context_budget",
      description: `connector-prose-${"background ".repeat(100)}`,
      staticTools: Array.from({ length: 8 }, (_, index) => ({
        name: `read_record_${index}`,
        description: `Read one record ${index}. ${"Long operational detail. ".repeat(30)}`,
        inputSchema,
        annotations: { readOnlyHint: true },
      })),
      tools: [],
      call: async (name, args) => ({
        name,
        recordId: (args as Record<string, unknown>).recordId,
      }),
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const compactResult = await mt.searchTools({
      includeSchemas: "compact",
    });
    const compactText = required(compactResult.content[0]).text;
    const compact = textOf(compactResult) as SearchResult;
    const tools = compact.tools as Array<
      SearchResult["tools"][number] & {
        inputSchema: string;
        inputSchemaTruncated?: true;
      }
    >;

    expect(new TextEncoder().encode(compactText).length).toBeLessThan(14_000);
    expect(compactText).not.toContain("redundant-property-prose");
    expect(compactText).not.toContain("connector-prose");
    expect(tools).toHaveLength(8);
    expect(tools.every((tool) => tool.inputSchemaTruncated)).toBe(true);
    expect(tools.every((tool) => !("inputKeys" in tool))).toBe(true);
    expect(
      tools.every((tool) => new TextEncoder().encode(tool.inputSchema).length <= MAX_COMPACT_DISCOVERY_SCHEMA_BYTES),
    ).toBe(true);
    expect(required(tools[0]).inputSchema).toMatch(/^\{ "recordId": unknown, "optionalField0"\?: unknown/);

    // The required-first routing shape is enough for the simple read; no
    // describe round trip is needed.
    expect(
      textOf(
        await mt.callTool({
          address: required(tools[0]).address,
          args: { recordId: "rec_123" },
        }),
      ),
    ).toEqual({ name: "read_record_0", recordId: "rec_123" });

    const exactResult = await mt.searchTools({
      limit: 6,
      fullDescriptions: true,
      includeSchemas: "json",
    });
    const exactText = required(exactResult.content[0]).text;
    expect(exactText).toContain("redundant-property-prose");
    expect(exactText).toContain("Long operational detail");
    expect(new TextEncoder().encode(compactText).length).toBeLessThan(
      new TextEncoder().encode(exactText).length * 0.15,
    );
  });

  it("optionally includes compact schemas and annotations for API and MCP tools", async () => {
    const apiConnector = api("weather", {
      description: "Weather API",
      tools: [
        {
          name: "forecast",
          description: "Read a forecast",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
          outputSchema: {
            type: "object",
            properties: { temperature: { type: "number" } },
          },
          annotations: { readOnlyHint: true },
          handler: () => ({ temperature: 20 }),
        },
        {
          name: "empty_output",
          description: "Read an object with no declared output properties",
          inputSchema: { type: "object", properties: {} },
          outputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
          handler: () => ({}),
        },
      ],
    });
    const mcpConnector: Connector = connectorWith({
      id: "crm",
      kind: "mcp",
      tools: [
        {
          name: "lookup",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
      ],
      call: async () => ({ content: [{ type: "text", text: "{}" }] }),
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([apiConnector, mcpConnector]), BASE).searchTools({
        includeSchemas: "compact",
      }),
    ) as SearchResult;
    const byId = toolsByConnector(parsed);
    expect(required(required(byId.weather).tools[0]).inputSchema).toBe("{ city: string }");
    expect(required(required(byId.weather).tools[0])).toMatchObject({
      inputKeys: ["city"],
      requiredInputKeys: ["city"],
      outputKeys: ["temperature"],
    });
    expect(required(required(byId.weather).tools[0]).outputSchema).toContain("temperature");
    expect(required(required(byId.weather).tools[0]).annotations).toEqual({
      readOnlyHint: true,
    });
    const emptyOutput = required(required(byId.weather).tools[1]);
    expect(emptyOutput.inputKeys).toEqual([]);
    expect(emptyOutput.requiredInputKeys).toEqual([]);
    expect(emptyOutput.outputSchema).toBe("{}");
    expect(emptyOutput).not.toHaveProperty("outputKeys");
    expect(required(required(byId.crm).tools[0]).inputSchema).toBe("{ id: string }");
    expect(required(required(byId.crm).tools[0]).annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
  });
});

describe("compact schema rendering", () => {
  async function shapeOf(schema: any): Promise<string> {
    const conn: Connector = connectorWith({
      id: "shape",
      kind: "api",
      description: "Shapes",
      tools: [{ name: "t", description: "t", inputSchema: schema }],
      call: async () => ({}),
    });
    // The describe renderer, read at the layer that owns it: `connecta.describe`
    // inside execute_code is the only surface that reaches it now, and it
    // renders property descriptions where search's bounded compact schema
    // deliberately does not.
    const described = await new CatalogService(makeRegistry([conn]), BASE).describe({ addresses: ["shape.t"] });
    return required(described[0]).inputSchema as string;
  }

  it("renders numeric and string constraints in discovery and describe", async () => {
    const schema = {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          exclusiveMinimum: 0,
          maximum: 50,
          exclusiveMaximum: 51,
          multipleOf: 1,
        },
        name: {
          type: "string",
          minLength: 3,
          maxLength: 64,
          format: "hostname",
          pattern: "^[a-z]+$",
        },
      },
    };
    const expected =
      "{ limit?: integer /* >= 1; > 0; <= 50; < 51; multiple of 1 */, " +
      'name?: string /* length >= 3; length <= 64; format "hostname"; pattern "^[a-z]+$" */ }';

    expect(compactDiscoverySchema(schema)).toEqual({
      text: expected,
      truncated: false,
    });
    expect(await shapeOf(schema)).toBe(expected);
    expect(
      compactDiscoverySchema({
        anyOf: [{ type: "string" }, { type: "null" }],
        minLength: 2,
      }).text,
    ).toBe("(string | null) /* length >= 2 */");
    expect(compactDiscoverySchema({ minimum: 0 }).text).toBe("unknown /* >= 0 */");
  });

  // `A | B[]` reads as "an A, or an array of B" (#569): every shape that
  // renders at operator level is grouped before an array suffix, in both
  // compact routes, and nothing else gains parentheses.
  it("groups a union or intersection before its array suffix", () => {
    const replace = { type: "object", properties: { op: { const: "replace" } } };
    const append = { type: "object", properties: { op: { const: "append" } } };
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { type: "object", properties: { patch: { type: "array", items: { anyOf: [replace, append] } } } },
        '{ patch?: ({ op?: "replace" } | { op?: "append" })[] }',
      ],
      [
        { type: "array", items: { type: "array", items: { oneOf: [replace, append] } } },
        '({ op?: "replace" } | { op?: "append" })[][]',
      ],
      [
        { type: "array", items: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "number" }] } },
        "(string[] | number)[]",
      ],
      [{ type: "array", items: { type: ["string", "null"] } }, "(string | null)[]"],
      [{ type: "array", items: { enum: ["a", "b"] } }, '("a" | "b")[]'],
      [{ type: "array", items: { allOf: [replace, append] } }, '({ op?: "replace" } & { op?: "append" })[]'],
      [
        { type: "array", items: { anyOf: [replace, append], if: { required: ["op"] } } },
        '({ op?: "replace" } | { op?: "append" } /* conditional */)[]',
      ],
      [
        { $defs: { Both: { allOf: [replace, append] } }, type: "array", items: { $ref: "#/$defs/Both", minLength: 1 } },
        '({ op?: "replace" } & { op?: "append" } /* length >= 1 */)[]',
      ],
      [
        { prefixItems: [{ type: "string" }], items: { allOf: [replace, append] } },
        '[string, ...({ op?: "replace" } & { op?: "append" })[]]',
      ],
    ];
    for (const [schema, expected] of cases) {
      expect(compactDiscoverySchema(schema).text).toBe(expected);
      expect(compactSchema(schema)).toBe(expected);
    }
    // A union constrained as a whole is already grouped before its comment.
    expect(
      compactSchema({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }], minLength: 1 } }),
    ).toBe("(string | number) /* length >= 1 */[]");
  });

  it("renders empty enums as the valid never type in compact discovery", () => {
    // `never` is the TypeScript bottom type, valid at both root and property
    // positions; an empty string was neither a type nor a readable constraint.
    const root = compactDiscoverySchema({ enum: [] });
    expect(root).toEqual({ text: "never", truncated: false });
    expectStructurallyCompleteTypeShape(root.text);

    const nested = compactDiscoverySchema({
      type: "object",
      properties: { state: { enum: [] } },
    });
    expect(nested).toEqual({
      text: "{ state?: never }",
      truncated: false,
    });
    expectStructurallyCompleteTypeShape(nested.text);
  });

  it("bounds nested UTF-8 enums without hiding other property types", () => {
    const values = Array.from({ length: 80 }, (_, index) => `${"😀".repeat(4)}-region-${index}`);
    const schema = {
      type: "object",
      properties: {
        workspace: { type: "string" },
        filters: {
          type: "object",
          properties: {
            states: { type: "array", items: { enum: values } },
          },
        },
        traceId: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["workspace"],
    };
    const compact = compactDiscoverySchema(schema);
    const exact = compactSchema(schema);

    expect(compact.truncated).toBe(true);
    expect(compact.text).toContain("workspace: string");
    expect(compact.text).toContain("filters?: { states?: (");
    expect(compact.text).toContain(")[] }");
    expect(compact.text).toContain("traceId?: string");
    expect(compact.text).toContain("limit?: integer");
    const omitted = compact.text.match(/(\d+) enum values omitted/);
    expect(omitted).not.toBeNull();
    const shown = compact.text.match(/-region-/g)?.length ?? 0;
    expect(shown + Number(required(omitted ?? undefined)[1])).toBe(values.length);
    expectStructurallyCompleteTypeShape(compact.text);
    expect(new TextEncoder().encode(compact.text).length).toBeLessThan(new TextEncoder().encode(exact).length * 0.25);
    expect(exact).toContain(required(values.at(-1)));
  });

  it("keeps oversized nested objects structurally complete", () => {
    const nestedObject = compactDiscoverySchema({
      type: "object",
      properties: {
        payload: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 120 }, (_, index) => [
              `nestedField${index}`,
              {
                type: "object",
                properties: {
                  alpha: { type: "string" },
                  beta: { type: "integer" },
                },
              },
            ]),
          ),
        },
        traceId: { type: "string" },
      },
      required: ["payload"],
    });
    expect(nestedObject.truncated).toBe(true);
    expect(nestedObject.text).toBe('{ "payload": unknown, "traceId"?: unknown } /* truncated */');
    expectStructurallyCompleteTypeShape(nestedObject.text);

    expect(new TextEncoder().encode(nestedObject.text).length).toBeLessThanOrEqual(MAX_COMPACT_DISCOVERY_SCHEMA_BYTES);
  });
});

it("counts both discovery copies and their JSON escaping against the ceiling", async () => {
  const connector = connectorWith({
    id: "large",
    kind: "api",
    tools: [{ name: "read", description: "x".repeat(140_000), annotations: { readOnlyHint: true } }],
  });
  const result = await createMetaTools(makeRegistry([connector]), BASE).searchTools({
    query: "",
    fullDescriptions: true,
  });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toMatchObject({ error: { code: "result_too_large" } });
  expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(MAX_DISCOVERY_RESULT_BYTES);
});
