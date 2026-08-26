import { describe, expect, it } from "vitest";
import { connectorWith } from "./fixtures/connectors.js";
import {
  BASE,
  registry,
  type SearchResult,
  textOf,
} from "./fixtures/meta-tools.js";
import { api } from "../src/connectors/api.js";
import {
  compactDiscoverySchema,
  compactSchema,
  MAX_COMPACT_DISCOVERY_SCHEMA_BYTES,
} from "../src/catalog.js";
import { CatalogService } from "../src/catalog-service.js";
import { ConnectorCallError } from "../src/errors.js";
import {
  createMetaTools,
  jsonResult,
  MAX_DISCOVERY_RESULT_BYTES,
  MAX_SEARCH_LIMIT,
} from "../src/meta-tools.js";
import type { Connector } from "../src/types.js";
import {
  required,
  calcConnector,
  makeRegistry,
  remoteConnector,
} from "./helpers.js";

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

describe("structured result compatibility", () => {
  it("keeps structuredContent canonical and content complete but compact", () => {
    const value = {
      connectors: [
        { id: "calc", tools: [{ address: "calc.add", score: 1 }] },
      ],
      total: 1,
    };
    const result = jsonResult(value);

    // A content-only client keeps the complete result.
    const contentOnly = JSON.parse(required(result.content[0]).text);
    expect(contentOnly).toEqual(value);
    // A structured-aware client receives the original full-fidelity object.
    expect(result.structuredContent).toBe(value);
    // A mixed consumer sees equivalent representations without indentation.
    expect(contentOnly).toEqual(result.structuredContent);
    expect(required(result.content[0]).text).toBe(JSON.stringify(value));
    expect(required(result.content[0]).text).not.toContain("\n");
  });

  it("uses the same compact policy for discovery results", async () => {
    const result = await createMetaTools(
      makeRegistry([calcConnector]),
      BASE,
    ).searchTools({ query: "add", includeSchemas: "compact" });
    expect(required(result.content[0]).text).toBe(
      JSON.stringify(result.structuredContent),
    );
  });
});

describe("describe recovery", () => {
  it("returns route-aware typed misses and bounded canonical suggestions", async () => {
    const service = new CatalogService(makeRegistry([calcConnector]), BASE);
    const described = await service.describe({
      addresses: ["ghost.ad", "calc.ad", "calc.completely_different"],
    });

    expect(required(described[0]).errorDetails).toEqual({
      code: "unknown_address",
      message: 'Unknown address "ghost.ad"',
      retryable: false,
      nextAction: {
        tool: "search_tools",
        arguments: { query: "ad", includeSchemas: "compact" },
        purpose: "Find the configured canonical address before retrying.",
      },
    });
    expect(required(described[1]).errorDetails).toEqual({
      code: "unknown_tool",
      message: 'Unknown tool "ad" on connector "calc"',
      retryable: false,
      nextAction: {
        tool: "search_tools",
        arguments: {
          query: "ad",
          connector: "calc",
          includeSchemas: "compact",
        },
        purpose: "Find the connector's current canonical tool address.",
      },
      suggestions: ["calc.add"],
    });
    expect(required(required(described[2]).errorDetails).suggestions).toBeUndefined();
  });

  it("classifies and bounds catalog failures without call-path detail", async () => {
    const unavailable: Connector = connectorWith({
      id: "billing",
      kind: "api",
      tools: async () => {
        throw new ConnectorCallError(
          "unavailable",
          `Upstream unavailable. ${"x".repeat(1_000)}`,
          { retryAfterMs: 30_000 },
        );
      },
      call: async () => null,
    });
    const [entry] = await new CatalogService(
      makeRegistry([unavailable]),
      BASE,
    ).describe({ addresses: ["billing.read"] });
    const details = required(required(entry).errorDetails);
    expect(details).toMatchObject({
      code: "unavailable",
      retryable: true,
      retryAfterMs: 30_000,
    });
    expect(Object.keys(details).sort()).toEqual([
      "code",
      "message",
      "retryAfterMs",
      "retryable",
    ]);
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
    const hostile = Array.from(
      { length: 6 },
      (_, index) =>
        index < 2
          ? `ghost${index}.${"x".repeat(50_000)}`
          : index < 4
            ? `calc.${"y".repeat(50_000)}${index}`
            : `billing.${"z".repeat(50_000)}${index}`,
    );
    const addresses = [hostile[0]!, "calc.add", ...hostile.slice(1), "calc.add"];
    const described = await new CatalogService(
      makeRegistry([calcConnector, unavailable]),
      BASE,
    ).describe({ addresses });

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
    expect(Buffer.byteLength(JSON.stringify(described))).toBeLessThan(
      MAX_DISCOVERY_RESULT_BYTES,
    );
  });
});

describe("search_tools", () => {
  it("uses the default bound for catalog fan-out and preserves all results", async () => {
    let active = 0;
    let maxActive = 0;
    const connectors = Array.from(
      { length: 9 },
      (_, index): Connector => (connectorWith({
        id: `search_${index}`,
        kind: "mcp",
        description: `Search ${index}`,
        tools: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          return [
            {
              name: `read_${index}`,
              description: "Read matching data",
            },
          ];
        },
        call: async () => null,
      })),
    );
    const result = textOf(
      await createMetaTools(makeRegistry(connectors), BASE).searchTools({
        query: "matching",
        limit: 20,
      }),
    ) as { total: number };
    expect(result.total).toBe(9);
    expect(maxActive).toBe(4);
  });

  it("substring-matches over name + description, grouped by connector", async () => {
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(
      await mt.searchTools({ query: "echo" }),
    ) as SearchResult;
    // A single matching tool → a single connector group.
    expect(parsed.connectors).toHaveLength(1);
    expect(required(parsed.connectors[0]).id).toBe("remote");
    expect(required(parsed.connectors[0]).tools.map((t) => t.address)).toEqual([
      "remote.echo",
    ]);
    expect(parsed.total).toBe(1);
  });

  it("empty query browses all healthy tools grouped per connector (broken skipped)", async () => {
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(await mt.searchTools({})) as SearchResult;
    const whitespace = textOf(
      await mt.searchTools({ query: " \n\t " }),
    ) as SearchResult;
    // Two healthy connectors with matches → two groups; broken is skipped.
    expect(parsed.connectors.map((c) => c.id).sort()).toEqual([
      "calc",
      "remote",
    ]);
    const byId = Object.fromEntries(parsed.connectors.map((c) => [c.id, c]));
    expect(required(byId.calc).tools.map((t) => t.address)).toEqual(["calc.add"]);
    expect(required(byId.remote).tools.map((t) => t.address)).toEqual(["remote.echo"]);
    expect(parsed.total).toBe(2);
    expect(whitespace).toEqual(parsed);
  });

  it("does not turn a non-empty Unicode-only query into a browse", async () => {
    const query = "界".repeat(80);
    const parsed = textOf(
      await createMetaTools(
        makeRegistry([calcConnector, remoteConnector]),
        BASE,
      ).searchTools({ query }),
    ) as SearchResult;

    expect(parsed).toMatchObject({
      connectors: [],
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
    expect(
      new TextEncoder().encode(JSON.stringify(parsed.queryAnalysis)).length,
    ).toBeLessThan(1_600);
  });

  it("clips non-BMP no-match analysis by Unicode code point", async () => {
    const parsed = textOf(
      await createMetaTools(
        makeRegistry([calcConnector, remoteConnector]),
        BASE,
      ).searchTools({ query: "😀".repeat(80) }),
    ) as SearchResult;
    const unmatched = required(
      required(parsed.queryAnalysis).unmatchedTerms[0],
    );

    expect(parsed.connectors).toEqual([]);
    expect(unmatched).toBe(`${"😀".repeat(63)}…`);
    expect([...unmatched]).toHaveLength(64);
    expect(required(parsed.queryAnalysis).truncated).toBe(true);
  });

  it("uses searchable ASCII terms from a mixed Unicode query", async () => {
    const parsed = textOf(
      await createMetaTools(
        makeRegistry([calcConnector, remoteConnector]),
        BASE,
      ).searchTools({ query: `${"界".repeat(80)} add` }),
    ) as SearchResult;
    const tools = parsed.connectors.flatMap((group) => group.tools);

    expect(tools).toHaveLength(1);
    expect(required(tools[0])).toMatchObject({
      address: "calc.add",
    });
    expect(required(tools[0])).not.toHaveProperty("queryCoverage");
    expect(required(tools[0])).not.toHaveProperty("score");
    expect(parsed.queryAnalysis).toBeUndefined();
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
    const addresses = async (
      safety?: "readOnly" | "approvalRequired" | "all",
    ) => {
      const page = textOf(
        await mt.searchTools({ ...(safety ? { safety } : {}), limit: 10 }),
      ) as SearchResult;
      return page.connectors.flatMap((group) =>
        group.tools.map((tool) => tool.address),
      );
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
      expect(required(result.content[0]).text).toContain(
        "not explicitly read-only",
      );
    }
  });

  it("explains an empty safety-filtered result without hiding the complete catalog", async () => {
    const writeOnly: Connector = connectorWith({
      id: "write_only",
      staticTools: [{ name: "create", annotations: { readOnlyHint: false } }],
      tools: [],
      call: async () => ({}),
    });
    const mt = createMetaTools(makeRegistry([writeOnly]), BASE);
    const filtered = textOf(
      await mt.searchTools({
        query: "create",
        safety: "readOnly",
      }),
    ) as SearchResult;
    expect(filtered.total).toBe(0);
    expect(filtered.queryAnalysis?.guidance).toContain(
      "No matching read-only capability",
    );
    expect(filtered.queryAnalysis?.guidance).toContain(
      "Change safety to inspect the other tools.",
    );

    const complete = textOf(
      await mt.searchTools({ query: "create" }),
    ) as SearchResult;
    expect(complete.connectors.flatMap((group) => group.tools)).toHaveLength(1);
  });

  it("respects the connector filter → a single group", async () => {
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(
      await mt.searchTools({ connector: "calc" }),
    ) as SearchResult;
    expect(parsed.connectors).toHaveLength(1);
    expect(required(parsed.connectors[0]).id).toBe("calc");
    expect(required(parsed.connectors[0]).tools.map((t) => t.address)).toEqual([
      "calc.add",
    ]);
    expect(parsed.total).toBe(1);
  });

  it("does not load unrelated catalogs for a connector-scoped search", async () => {
    const loads = { wanted: 0, unrelated: 0 };
    const dynamic = (id: keyof typeof loads): Connector => (connectorWith({
      id,
      kind: "mcp",
      tools: async () => {
        loads[id]++;
        return [{ name: "read", description: `Read ${id} data` }];
      },
      call: async () => null,
    }));
    const mt = createMetaTools(
      makeRegistry([dynamic("wanted"), dynamic("unrelated")]),
      BASE,
    );

    const parsed = textOf(
      await mt.searchTools({ query: "read", connector: "wanted" }),
    ) as SearchResult;

    expect(parsed.connectors.map((group) => group.id)).toEqual(["wanted"]);
    expect(loads).toEqual({ wanted: 1, unrelated: 0 });
  });

  it("paginates results while reporting the full match count", async () => {
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(await mt.searchTools({ limit: 1 })) as SearchResult;
    expect(parsed.total).toBe(2);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextOffset).toBe(1);
    const shown = parsed.connectors.flatMap((c) => c.tools);
    expect(shown).toHaveLength(1);

    const next = textOf(
      await mt.searchTools({
        limit: 1,
        offset: required(parsed.nextOffset),
      }),
    ) as SearchResult;
    expect(next.total).toBe(2);
    expect(next.offset).toBe(1);
    expect(next.hasMore).toBe(false);
    expect(next.connectors.flatMap((c) => c.tools)).toHaveLength(1);
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
    expect(first.connectors.flatMap((group) => group.tools)).toHaveLength(8);
    expect(
      first.connectors.flatMap((group) => group.tools)[0],
    ).not.toHaveProperty("queryCoverage");
    expect(first.nextOffset).toBe(8);

    const second = textOf(
      await mt.searchTools({ offset: required(first.nextOffset) }),
    ) as SearchResult;
    expect(second.limit).toBe(8);
    expect(second.connectors.flatMap((group) => group.tools)).toHaveLength(4);
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
      expect(parsed.connectors.flatMap((group) => group.tools)).toHaveLength(
        limit,
      );
    }
    expect(loads).toBe(1);

    for (const limit of [MAX_SEARCH_LIMIT + 1, Number.MAX_SAFE_INTEGER]) {
      const result = await createMetaTools(
        makeRegistry([connector]),
        BASE,
      ).searchTools({ limit });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatchObject({
        error: { code: "invalid_args", retryable: false },
      });
    }
    // The rejected calls never reached listTools.
    expect(loads).toBe(1);
  });

  it("keeps default and maximum result pages coverage-free", async () => {
    const terms = Array.from(
      { length: 8 },
      (_, index) => `${index}${"x".repeat(79)}`,
    );
    const connector: Connector = connectorWith({
      id: "coverage_budget",
      staticTools: Array.from({ length: MAX_SEARCH_LIMIT }, (_, index) => ({
        name: `read_${String(index).padStart(3, "0")}`,
        description: terms.join(" "),
      })),
      tools: [],
      call: async () => null,
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    for (const limit of [undefined, MAX_SEARCH_LIMIT]) {
      const result = await mt.searchTools({
        query: terms.join(" "),
        ...(limit === undefined ? {} : { limit }),
      });
      const parsed = textOf(result) as SearchResult;
      const tools = parsed.connectors.flatMap((group) => group.tools);

      expect(tools).toHaveLength(limit ?? 8);
      expect(tools.every((tool) => !("queryCoverage" in tool))).toBe(true);
      expect(tools.every((tool) => !("score" in tool))).toBe(true);
      const responseBytes = new TextEncoder().encode(
        required(result.content[0]).text,
      ).length;
      expect(responseBytes).toBeLessThan(
        limit === undefined ? 10_000 : 100_000,
      );
      expect(responseBytes).toBeLessThan(MAX_DISCOVERY_RESULT_BYTES);
    }
  });

  it("keeps 100,000-tool pagination exact at the first, middle, and final page", async () => {
    const total = 100_000;
    const connector: Connector = connectorWith({
      id: "huge",
      staticTools: Array.from({ length: total }, (_, i) => ({
        name: `tool-${String(i).padStart(6, "0")}`,
      })),
      tools: async () => {
        throw new Error("static catalog should not load");
      },
      call: async () => null,
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const seen = new Set<string>();
    for (const offset of [0, 50_000, total - MAX_SEARCH_LIMIT]) {
      const page = textOf(
        await mt.searchTools({ offset, limit: MAX_SEARCH_LIMIT }),
      ) as SearchResult;
      expect(page.total).toBe(total);
      expect(page.offset).toBe(offset);
      expect(required(page.connectors[0]).tools).toHaveLength(MAX_SEARCH_LIMIT);
      for (const tool of required(page.connectors[0]).tools) {
        expect(seen.has(tool.address)).toBe(false);
        seen.add(tool.address);
      }
    }
    expect(seen.size).toBe(3 * MAX_SEARCH_LIMIT);
  });

  it("rejects an oversized multibyte search result with a paging hint", async () => {
    const connector: Connector = connectorWith({
      id: "verbose",
      staticTools: [
        {
          name: "read",
          description: "界".repeat(MAX_DISCOVERY_RESULT_BYTES),
        },
      ],
      tools: [],
      call: async () => null,
    });
    const result = await createMetaTools(
      makeRegistry([connector]),
      BASE,
    ).searchTools({ fullDescriptions: true });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({
      error: {
        code: "result_too_large",
        message: expect.stringContaining(
          `${MAX_DISCOVERY_RESULT_BYTES}-byte ceiling`,
        ),
        retryable: false,
      },
    });
  });

  it("ranks tool-name matches above incidental description matches", async () => {
    const conn: Connector = connectorWith({
      id: "knowledge",
      description: "Knowledge base",
      tools: [
          {
            name: "article-search",
            description:
              "Search articles, then fetch a matching document for details.",
          },
          {
            name: "article-fetch",
            description: "Fetch an article document by URL or ID.",
          },
        ],
      call: async () => null,
    });
    const mt = createMetaTools(makeRegistry([conn]), BASE);
    const parsed = textOf(
      await mt.searchTools({ query: "fetch article document" }),
    ) as SearchResult;

    expect(required(parsed.connectors[0]).tools.map((t) => t.name)).toEqual([
      "article-fetch",
      "article-search",
    ]);
    expect(parsed.matchMode).toBeUndefined();
  });

  it("removes conversational framing before the all-term decision", async () => {
    const connector: Connector = connectorWith({
      id: "conversation",
      staticTools: [
        {
          name: "list_issues",
          description: "List open issues for a project",
        },
        {
          name: "expand_archive",
          description: "Expand a compressed archive",
        },
      ],
      tools: [],
      call: async () => null,
    });
    const parsed = textOf(
      await createMetaTools(
        makeRegistry([connector]),
        BASE,
      ).searchTools({
        query:
          "can you show me all of the current open issues in our project please",
      }),
    ) as SearchResult;

    expect(
      parsed.connectors.flatMap((group) =>
        group.tools.map((tool) => tool.name),
      ),
    ).toEqual(["list_issues"]);
    expect(parsed.matchMode).toBeUndefined();
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
      await createMetaTools(
        makeRegistry([connector]),
        BASE,
      ).searchTools({
        query: "find a drive file and share it",
      }),
    ) as SearchResult;

    expect(
      new Set(
        parsed.connectors.flatMap((group) =>
          group.tools.map((tool) => tool.address),
        ),
      ),
    ).toEqual(new Set(["files.search_files", "files.share_file"]));
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

    const supported = textOf(
      await mt.searchTools({ query: "list projects deployments" }),
    ) as SearchResult;
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
    expect(
      required(supportedFirstPage.queryAnalysis).otherResultTerms,
    ).toHaveLength(1);

    const mixed = textOf(
      await mt.searchTools({ query: "list projects invoices" }),
    ) as SearchResult;
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

    const absent = textOf(
      await mt.searchTools({ query: "calendar availability" }),
    ) as SearchResult;
    expect(absent).toMatchObject({
      connectors: [],
      total: 0,
      queryAnalysis: {
        representedTerms: [],
        otherResultTerms: [],
        unmatchedTerms: ["calendar", "availability"],
        guidance: expect.stringContaining(
          "No matching capability is configured in this deployment",
        ),
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
      guidance: expect.stringContaining(
        'No matching capability was found on connector "projects"',
      ),
    });
    expect(required(scopedAbsent.queryAnalysis).guidance).not.toContain(
      "configured in this deployment",
    );

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
      guidance: expect.stringContaining(
        'Connector "ghost" is not configured in this deployment',
      ),
    });
  });

  it("names the connector a no-match query already identified", async () => {
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

    const byId = textOf(
      await mt.searchTools({ query: "inventory" }),
    ) as SearchResult;
    expect(byId.total).toBe(0);
    const byIdGuidance = required(required(byId.queryAnalysis).guidance);
    expect(byIdGuidance).not.toContain("is configured in this deployment");
    expect(byIdGuidance).toContain('connector "inventory"');
    expect(byIdGuidance).toContain("browse with an empty query");

    // A title word is displayed, never indexed, so it must reach the same
    // correction rather than the false negative.
    const byTitle = textOf(
      await mt.searchTools({ query: "warehouse" }),
    ) as SearchResult;
    expect(byTitle.total).toBe(0);
    expect(
      required(required(byTitle.queryAnalysis).guidance),
    ).toContain('connector "inventory"');

    // A term the deployment really does not have keeps the stronger claim.
    const absent = textOf(
      await mt.searchTools({ query: "calendar" }),
    ) as SearchResult;
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
    expect(required(required(lateId.queryAnalysis).guidance)).toContain(
      'connector "inventory"',
    );

    const lateTitle = textOf(
      await mt.searchTools({
        query: "alpha beta gamma delta epsilon zeta eta theta warehouse",
      }),
    ) as SearchResult;
    expect(lateTitle.total).toBe(0);
    expect(required(required(lateTitle.queryAnalysis).guidance)).toContain(
      'connector "inventory"',
    );

    // Identity never enters ranking: a query that matches tools is answered
    // by the same tools, in the same order, with no identity advice.
    const matched = textOf(
      await mt.searchTools({ query: "inventory sku" }),
    ) as SearchResult;
    expect(
      matched.connectors.flatMap((group) =>
        group.tools.map((tool) => tool.address),
      ),
    ).toEqual(["inventory.get_sku", "inventory.list_skus"]);
    expect(
      required(required(matched.queryAnalysis).guidance),
    ).toContain("Split distinct intents");
  });

  it("bounds query analysis independently of long search input", async () => {
    const query = Array.from(
      { length: 20 },
      (_, index) => `${index}${"x".repeat(100)}`,
    ).join(" ");
    const parsed = textOf(
      await createMetaTools(makeRegistry([]), BASE).searchTools({ query }),
    ) as SearchResult;
    const analysis = required(parsed.queryAnalysis);

    expect(analysis.unmatchedTerms).toHaveLength(8);
    expect(
      analysis.unmatchedTerms.every((term) => term.length <= 64),
    ).toBe(true);
    expect(analysis.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(analysis)).length).toBeLessThan(
      1_600,
    );
  });

  it("does not let short function words force incidental partial matches", async () => {
    const connector: Connector = connectorWith({
      id: "messages",
      staticTools: [
        {
          name: "send_message",
          description: "Send a message to a channel",
        },
        {
          name: "list_members",
          description: "List the people in a channel",
        },
      ],
      tools: [],
      call: async () => null,
    });
    const parsed = textOf(
      await createMetaTools(
        makeRegistry([connector]),
        BASE,
      ).searchTools({
        query: "send a message to a channel",
      }),
    ) as SearchResult;

    expect(
      parsed.connectors.flatMap((group) =>
        group.tools.map((tool) => tool.name),
      ),
    ).toEqual(["send_message"]);
    expect(parsed.matchMode).toBeUndefined();
  });

  it("falls back to the original query when cleanup removes every term", async () => {
    const connector: Connector = connectorWith({
      id: "framing",
      staticTools: [
        {
          name: "phrase",
          description: "A and the",
        },
        {
          name: "decoy",
          description: "Unrelated record",
        },
      ],
      tools: [],
      call: async () => null,
    });
    const parsed = textOf(
      await createMetaTools(
        makeRegistry([connector]),
        BASE,
      ).searchTools({
        query: "a and the",
      }),
    ) as SearchResult;

    expect(
      parsed.connectors.flatMap((group) =>
        group.tools.map((tool) => tool.name),
      ),
    ).toEqual(["phrase"]);
    expect(parsed.matchMode).toBeUndefined();
  });

  it("returns no false positive when only a framing word overlaps", async () => {
    const connector: Connector = connectorWith({
      id: "archives",
      staticTools: [
        {
          name: "expand_archive",
          description: "Expand a compressed archive",
        },
      ],
      tools: [],
      call: async () => null,
    });
    const parsed = textOf(
      await createMetaTools(
        makeRegistry([connector]),
        BASE,
      ).searchTools({
        query: "weather radar and rain forecast",
      }),
    ) as SearchResult;

    expect(parsed.connectors).toEqual([]);
    expect(parsed.total).toBe(0);
    expect(parsed.matchMode).toBeUndefined();
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
          description:
            "List organizations and projects configured for business analysis",
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

    expect(
      required(first.connectors[0]).tools.map((tool) => tool.name),
    ).toEqual([
      "List-Organizations",
      ...Array.from({ length: 7 }, (_, index) => `business_context_${index}`),
    ]);
    expect(first).toMatchObject({
      total: 10,
      nextOffset: 8,
      hasMore: true,
    });
    expect(first.matchMode).toBeUndefined();
    expect(
      required(first.connectors[0]).tools.every(
        (tool) => !("queryCoverage" in tool) && !("score" in tool),
      ),
    ).toBe(true);

    const second = textOf(
      await mt.searchTools({
        query: "list organizations projects",
        limit: 8,
        offset: required(first.nextOffset),
      }),
    ) as SearchResult;
    expect(required(second.connectors[0]).tools.map((tool) => tool.name)).toEqual([
      "business_context_7",
      "List-All-Organizations",
    ]);
    expect(second).toMatchObject({ total: 10, hasMore: false });
    expect(
      second.connectors.flatMap((group) => group.tools).every(
        (tool) => !("queryCoverage" in tool) && !("score" in tool),
      ),
    ).toBe(true);

    const rawPhrase = textOf(
      await mt.searchTools({
        query: "list all organizations projects",
        limit: 8,
      }),
    ) as SearchResult;
    expect(
      required(rawPhrase.connectors[0]).tools.map((tool) => tool.name),
    ).toEqual([
      "List-All-Organizations",
      ...Array.from({ length: 7 }, (_, index) => `business_context_${index}`),
    ]);
    expect(rawPhrase).toMatchObject({
      total: 10,
      nextOffset: 8,
      hasMore: true,
    });
    expect(rawPhrase.matchMode).toBeUndefined();
    expect(
      rawPhrase.connectors.flatMap((group) => group.tools).every(
        (tool) => !("queryCoverage" in tool) && !("score" in tool),
      ),
    ).toBe(true);
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
            description:
              "Get experiment details including metrics and variants.",
          },
          {
            name: "get_results",
            description: "Get experiment results.",
          },
        ],
      call: async () => null,
    });
    const mt = createMetaTools(makeRegistry([conn]), BASE);
    const query =
      "get experiment details metrics variants results configuration";
    const first = textOf(
      await mt.searchTools({ query, limit: 2 }),
    ) as SearchResult;

    expect(first.matchMode).toBe("partial");
    const firstTools = first.connectors.flatMap((group) => group.tools);
    expect(firstTools.map((t) => t.name))
      .toEqual(["get_experiment", "get_results"]);
    expect(
      firstTools.every(
        (tool) => !("queryCoverage" in tool) && !("score" in tool),
      ),
    ).toBe(true);
    expect(first.queryAnalysis).toMatchObject({
      representedTerms: [
        "get",
        "experiment",
        "details",
        "metrics",
        "variants",
        "results",
      ],
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
    expect(required(second.connectors[0]).tools.map((tool) => tool.name)).toEqual([
      "list_experiments",
    ]);
  });

  it("keeps partial fallback connector-scoped and returns no mode without overlap", async () => {
    const connector = (id: string, name: string): Connector => (connectorWith({
      id,
      tools: [{ name, description: `${name} records` }],
      call: async () => null,
    }));
    const mt = createMetaTools(
      makeRegistry([
        connector("wanted", "get_experiment"),
        connector("other", "get_results"),
      ]),
      BASE,
    );
    const partial = textOf(
      await mt.searchTools({
        connector: "wanted",
        query: "get experiment metrics variants results",
      }),
    ) as SearchResult;
    expect(partial.matchMode).toBe("partial");
    expect(partial.connectors.map((group) => group.id)).toEqual(["wanted"]);

    const none = textOf(
      await mt.searchTools({
        connector: "wanted",
        query: "calendar availability",
      }),
    ) as SearchResult;
    expect(none).toMatchObject({ connectors: [], total: 0, hasMore: false });
    expect(none.matchMode).toBeUndefined();
  });

  it("returns concise descriptions by default and full text on request", async () => {
    const longDescription = `A tool ${"with extensive documentation ".repeat(20)}`;
    const conn: Connector = connectorWith({
      id: "docs",
      description: "Docs",
      tools: [{ name: "read", description: longDescription }],
      call: async () => null,
    });
    const mt = createMetaTools(makeRegistry([conn]), BASE);
    const concise = textOf(await mt.searchTools({})) as SearchResult;
    const full = textOf(
      await mt.searchTools({ fullDescriptions: true }),
    ) as SearchResult;

    expect(required(required(concise.connectors[0]).tools[0]).description!.length).toBeLessThan(
      longDescription.length,
    );
    expect(required(required(concise.connectors[0]).tools[0]).description).toMatch(/…$/);
    expect(required(required(full.connectors[0]).tools[0]).description).toBe(longDescription);
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
        [
          "recordId",
          { type: "string", description: `${propertyProse} required` },
        ],
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
    const tools = required(compact.connectors[0]).tools as Array<
      SearchResult["connectors"][number]["tools"][number] & {
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
      tools.every(
        (tool) =>
          new TextEncoder().encode(tool.inputSchema).length <=
          MAX_COMPACT_DISCOVERY_SCHEMA_BYTES,
      ),
    ).toBe(true);
    expect(required(tools[0]).inputSchema).toMatch(
      /^\{ "recordId": unknown, "optionalField0"\?: unknown/,
    );

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
      limit: 8,
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
      await createMetaTools(
        makeRegistry([apiConnector, mcpConnector]),
        BASE,
      ).searchTools({ includeSchemas: "compact" }),
    ) as {
      connectors: Array<{
        id: string;
        tools: Array<{
          inputSchema: string;
          outputSchema?: string;
          inputKeys?: string[];
          requiredInputKeys?: string[];
          outputKeys?: string[];
          annotations?: Record<string, unknown>;
        }>;
      }>;
    };
    const byId = Object.fromEntries(parsed.connectors.map((c) => [c.id, c]));
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

  it("reports a connector's display title separately from its address id", async () => {
    const titled = api("billing", {
      title: "Acme Billing",
      description: "Acme billing management",
      tools: [
        {
          name: "list",
          description: "List billing records",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object" },
          handler: () => [],
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([titled]), BASE).searchTools({}),
    ) as { connectors: Array<{ id: string; title?: string }> };

    expect(parsed.connectors[0]).toMatchObject({
      id: "billing",
      title: "Acme Billing",
    });
  });

  it("loads independent connector catalogs in parallel", async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connector = (id: string): Connector => (connectorWith({
      id,
      kind: "mcp",
      tools: async () => {
        started++;
        if (started === 2) release();
        await gate;
        return [{ name: "read" }];
      },
      call: async () => null,
    }));
    const search = createMetaTools(
      makeRegistry([connector("first"), connector("second")]),
      BASE,
    ).searchTools({});
    await expect(
      Promise.race([
        search,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("catalogs loaded sequentially")),
            100,
          ),
        ),
      ]),
    ).resolves.toBeDefined();
    expect(started).toBe(2);
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
    const described = await new CatalogService(
      makeRegistry([conn]),
      BASE,
    ).describe({ addresses: ["shape.t"] });
    return required(described[0]).inputSchema as string;
  }

  it("renders optionals, enums, arrays and property descriptions", async () => {
    const shape = await shapeOf({
      type: "object",
      properties: {
        id: { type: "string", description: "the id" },
        mode: { enum: ["a", "b"] },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
    });
    expect(shape).toBe(
      '{ id: string // the id, mode?: "a" | "b", tags?: string[] }',
    );
  });

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
      '{ limit?: integer /* >= 1; > 0; <= 50; < 51; multiple of 1 */, ' +
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
    expect(compactDiscoverySchema({ minimum: 0 }).text).toBe(
      "unknown /* >= 0 */",
    );
  });

  it("groups enum and resolved-union constraints around the whole type", () => {
    const constrainedEnum = { enum: ["a", "bbb"], minLength: 2 };
    expect(compactDiscoverySchema(constrainedEnum).text).toBe(
      '("a" | "bbb") /* length >= 2 */',
    );
    expect(compactSchema(constrainedEnum)).toBe(
      '("a" | "bbb") /* length >= 2 */',
    );

    const constrainedRef = {
      $ref: "#/$defs/Value",
      minLength: 2,
      $defs: {
        Value: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
      },
    };
    expect(compactDiscoverySchema(constrainedRef).text).toBe(
      "(string | null) /* length >= 2 */",
    );
    expect(compactSchema(constrainedRef)).toBe(
      "(string | null) /* length >= 2 */",
    );
  });

  it("does not group unconstrained array-valued type unions", () => {
    expect(compactDiscoverySchema({ type: ["string", "null"] }).text).toBe(
      "string | null",
    );
    expect(compactSchema({ type: ["string", "null"] })).toBe(
      "string | null",
    );
  });

  it("drops constraints that push discovery over budget and flags the shape", () => {
    const schema = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 36 }, (_, index) => [
          `field${index}`,
          { type: "string", minLength: 1, maxLength: 64 },
        ]),
      ),
    };

    const compact = compactDiscoverySchema(schema);
    expect(compact.truncated).toBe(true);
    expect(compact.text).toContain("field0?: string");
    expect(compact.text).toContain("field35?: string");
    expect(compact.text).not.toContain("length >=");
    expect(new TextEncoder().encode(compact.text).length).toBeLessThanOrEqual(
      MAX_COMPACT_DISCOVERY_SCHEMA_BYTES,
    );
  });

  it('inlines $ref by name and falls back to "json" format on request', async () => {
    const schema = {
      type: "object",
      properties: { pt: { $ref: "#/$defs/Point" } },
      required: ["pt"],
      $defs: {
        Point: { type: "object", properties: { x: { type: "number" } } },
      },
    };
    const shape = await shapeOf(schema);
    expect(shape).toBe("{ pt: { x?: number } }");
  });

  it("preserves small enums in compact discovery", () => {
    expect(
      compactDiscoverySchema({
        type: "object",
        properties: { mode: { enum: ["read", "write"] } },
      }),
    ).toEqual({
      text: '{ mode?: "read" | "write" }',
      truncated: false,
    });
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

  it("renders empty enums as never in ordinary compact describe", async () => {
    const shape = await shapeOf({ enum: [] });
    expect(shape).toBe("never");
    expectStructurallyCompleteTypeShape(shape);
  });

  it("bounds nested UTF-8 enums without hiding other property types", () => {
    const values = Array.from(
      { length: 80 },
      (_, index) => `${"😀".repeat(4)}-region-${index}`,
    );
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
    expect(shown + Number(required(omitted ?? undefined)[1])).toBe(
      values.length,
    );
    expectStructurallyCompleteTypeShape(compact.text);
    expect(new TextEncoder().encode(compact.text).length).toBeLessThan(
      new TextEncoder().encode(exact).length * 0.25,
    );
    expect(exact).toContain(required(values.at(-1)));
  });

  it("keeps exact enum values in JSON discovery and describe", async () => {
    const values = Array.from({ length: 40 }, (_, index) => `state-${index}`);
    const schema = {
      type: "object",
      properties: { state: { enum: values } },
    };
    const conn: Connector = connectorWith({
      id: "enum_exact",
      kind: "mcp",
      tools: [{ name: "read", description: "Read state", inputSchema: schema }],
      call: async () => null,
    });
    const registry = makeRegistry([conn]);
    const search = textOf(
      await createMetaTools(registry, BASE).searchTools({
        query: "read state",
        includeSchemas: "json",
      }),
    ) as any;
    expect(required(required(search.connectors[0]).tools[0]).inputSchema).toEqual(
      schema,
    );

    const [describedJson] = await new CatalogService(registry, BASE).describe({
      addresses: ["enum_exact.read"],
      format: "json",
    });
    expect(required(describedJson).inputSchema).toEqual(schema);
    const [describedCompact] = await new CatalogService(
      registry,
      BASE,
    ).describe({ addresses: ["enum_exact.read"], format: "compact" });
    expect(required(describedCompact).inputSchema).toContain(
      required(values.at(-1)),
    );
    expect(required(describedCompact).inputSchema).not.toContain("omitted");
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
    expect(nestedObject.text).toBe(
      '{ "payload": unknown, "traceId"?: unknown } /* truncated */',
    );
    expectStructurallyCompleteTypeShape(nestedObject.text);

    expect(new TextEncoder().encode(nestedObject.text).length).toBeLessThanOrEqual(
      MAX_COMPACT_DISCOVERY_SCHEMA_BYTES,
    );
  });
});
