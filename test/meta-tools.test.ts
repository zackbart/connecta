import { describe, expect, it } from "vitest";
import { api } from "../src/connectors/api.js";
import { ConnectorCallError } from "../src/errors.js";
import {
  alignEndToCharBoundary,
  createMetaTools,
  MAX_RETRY_BACKOFF_MS,
  retryBackoffMs,
} from "../src/meta-tools.js";
import { CONNECTOR_GUIDES_SECTION, USAGE_SKILL } from "../src/skills.js";
import type { Connector } from "../src/types.js";
import {
  authConnector,
  brokenConnector,
  calcConnector,
  makeRegistry,
  remoteConnector,
} from "./helpers.js";

const BASE = "https://connecta.test";

function textOf(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

function registry() {
  return makeRegistry([
    calcConnector,
    remoteConnector,
    brokenConnector,
    authConnector,
  ]);
}

describe("skills", () => {
  const NOTION_GUIDE = `# Notion usage

Prefer \`notion.search\` over listing databases.

- Page results with \`start_cursor\`; never fetch more than 100 at a time.
`;

  function guided(id: string, guide?: string): Connector {
    return api(id, {
      description: `${id} connector`,
      ...(guide === undefined ? {} : { usageGuide: guide }),
      tools: [
        {
          name: "search",
          description: "Search records",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          handler: () => ({ results: [] }),
        },
      ],
    });
  }

  function textFrom(result: { content: { text: string }[] }): string {
    return result.content[0].text;
  }

  it("lists the built-in usage guide plus one entry per guided connector", async () => {
    const mt = createMetaTools(
      makeRegistry([guided("notion", NOTION_GUIDE), guided("plain")]),
      BASE,
    );
    const listed = textFrom(await mt.skills({}));
    expect(listed).toContain("`usage` — How to choose among Connecta");
    expect(listed).toContain("`connector:notion` — Notion usage");
    expect(listed).not.toContain("connector:plain");
  });

  it("summarizes a guide with no heading from its first meaningful line", async () => {
    const mt = createMetaTools(
      makeRegistry([guided("linear", "- Use `linear.search_issues` first.\n")]),
      BASE,
    );
    expect(textFrom(await mt.skills({}))).toContain(
      "`connector:linear` — Use `linear.search_issues` first.",
    );
  });

  it("skips opening markup when picking the summary line", async () => {
    const cases: Array<[string, string, string]> = [
      ["fence", "```json\n{ \"a\": 1 }\n```\n\nUse `x.search`.\n", "Use `x.search`."],
      ["frontmatter", "---\ntitle: ignored\n---\n\n# Real heading\n", "Real heading"],
      ["bare-hash", "#\n\nUse the search tool.\n", "Use the search tool."],
      ["bare-hashes", "###\n\nUse the search tool.\n", "Use the search tool."],
      ["unspaced-heading", "#Heading text\n", "Heading text"],
      ["html-comment", "<!-- generated -->\n\n# Real heading\n", "Real heading"],
      ["table", "| a | b |\n| - | - |\n\n# Real heading\n", "Real heading"],
      ["rule", "---\n\n", "svc connector"],
    ];
    for (const [label, guide, expected] of cases) {
      const mt = createMetaTools(makeRegistry([guided("svc", guide)]), BASE);
      expect(textFrom(await mt.skills({})), label).toContain(
        `\`connector:svc\` — ${expected}`,
      );
    }
  });

  it("falls back to the connector description when a guide is all markup", async () => {
    const mt = createMetaTools(makeRegistry([guided("svc", "# \n")]), BASE);
    expect(textFrom(await mt.skills({}))).toContain(
      "`connector:svc` — svc connector",
    );
  });

  it("truncates a summary line only past 120 characters", async () => {
    const exact = "a".repeat(120);
    const over = "b".repeat(121);
    const mt = createMetaTools(
      makeRegistry([guided("exact", exact), guided("over", over)]),
      BASE,
    );
    const listed = textFrom(await mt.skills({}));
    expect(listed).toContain(`\`connector:exact\` — ${exact}`);
    expect(listed).toContain(`\`connector:over\` — ${"b".repeat(119)}…`);
    expect(listed).not.toContain("b".repeat(120));
  });

  it("treats a whitespace-only guide as no guide at all", async () => {
    const mt = createMetaTools(makeRegistry([guided("blank", "  \n\t\n")]), BASE);
    expect(textFrom(await mt.skills({}))).not.toContain("connector:blank");
    const fetched = await mt.skills({ name: "connector:blank" });
    expect(fetched.isError).toBe(true);
    expect(textFrom(fetched)).toContain('Connector "blank" has no usage guide');
  });

  it("returns a connector guide verbatim", async () => {
    const mt = createMetaTools(
      makeRegistry([guided("notion", NOTION_GUIDE)]),
      BASE,
    );
    const fetched = await mt.skills({ name: "connector:notion" });
    expect(fetched.isError).toBeFalsy();
    expect(textFrom(fetched)).toBe(NOTION_GUIDE);
  });

  it("returns a guide with surrounding whitespace verbatim, padding included", async () => {
    const padded = "\n\n  # Padded\n\nBody.\n   ";
    const mt = createMetaTools(makeRegistry([guided("pad", padded)]), BASE);
    expect(textFrom(await mt.skills({ name: "connector:pad" }))).toBe(padded);
    expect(textFrom(await mt.skills({}))).toContain(
      "`connector:pad` — Padded",
    );
  });

  it("keeps the built-in usage guide unchanged as the default experience", async () => {
    const mt = createMetaTools(
      makeRegistry([guided("notion", NOTION_GUIDE)]),
      BASE,
    );
    const fetched = await mt.skills({ name: "usage" });
    expect(fetched.isError).toBeFalsy();
    expect(textFrom(fetched)).toBe(USAGE_SKILL + CONNECTOR_GUIDES_SECTION);
    expect(textFrom(fetched)).toContain("# Connecta usage");
    expect(textFrom(fetched)).toContain(
      'skills({ name: "connector:<connectorId>" })',
    );
  });

  it("serves the base usage guide byte-identically when no connector has one", async () => {
    const mt = createMetaTools(
      makeRegistry([guided("plain"), guided("other")]),
      BASE,
    );
    expect(textFrom(await mt.skills({ name: "usage" }))).toBe(USAGE_SKILL);
    expect(textFrom(await mt.skills({ name: "usage" }))).not.toContain(
      "Per-connector guides",
    );
    const listed = textFrom(await mt.skills({}));
    expect(listed).toContain("`usage` — How to choose among Connecta");
    expect(listed).not.toContain("connector:");
  });

  it("errors — never falls back to the generic guide — for a connector with no guide", async () => {
    const mt = createMetaTools(makeRegistry([guided("plain")]), BASE);
    const fetched = await mt.skills({ name: "connector:plain" });
    expect(fetched.isError).toBe(true);
    expect(textFrom(fetched)).toContain(
      'Connector "plain" has no usage guide',
    );
    expect(textFrom(fetched)).not.toContain("# Connecta usage");
  });

  it("errors for an unknown connector guide and an unknown skill name", async () => {
    const mt = createMetaTools(
      makeRegistry([guided("notion", NOTION_GUIDE)]),
      BASE,
    );
    const unknownConnector = await mt.skills({ name: "connector:ghost" });
    expect(unknownConnector.isError).toBe(true);
    expect(textFrom(unknownConnector)).toContain('Unknown connector "ghost"');
    expect(textFrom(unknownConnector)).toContain("connector:notion");

    const unknownSkill = await mt.skills({ name: "missing" });
    expect(unknownSkill.isError).toBe(true);
    expect(textFrom(unknownSkill)).toContain('Unknown skill "missing"');
    expect(textFrom(unknownSkill)).not.toContain("# Connecta usage");
  });

  it("points a bare connector id at its prefixed skill name", async () => {
    const mt = createMetaTools(
      makeRegistry([guided("notion", NOTION_GUIDE)]),
      BASE,
    );
    const fetched = await mt.skills({ name: "notion" });
    expect(fetched.isError).toBe(true);
    expect(textFrom(fetched)).toContain(
      'Connector guides are fetched as "connector:notion"',
    );
  });

  it('a connector whose id is "usage" neither shadows nor is shadowed', async () => {
    const guide = "# Usage-service quirks\n\nRate limit: 10 rpm.\n";
    const mt = createMetaTools(makeRegistry([guided("usage", guide)]), BASE);

    const listed = textFrom(await mt.skills({}));
    expect(listed).toContain("`usage` — How to choose among Connecta");
    expect(listed).toContain("`connector:usage` — Usage-service quirks");

    expect(textFrom(await mt.skills({ name: "usage" }))).toBe(
      USAGE_SKILL + CONNECTOR_GUIDES_SECTION,
    );
    expect(textFrom(await mt.skills({ name: "connector:usage" }))).toBe(guide);
  });

  it("names the guide in search_tools and describe_tools output", async () => {
    const mt = createMetaTools(
      makeRegistry([guided("notion", NOTION_GUIDE), guided("plain")]),
      BASE,
    );
    const searched = textOf(await mt.searchTools({ query: "search" })) as {
      connectors: Array<{ id: string; guide?: string }>;
    };
    const byId = Object.fromEntries(searched.connectors.map((c) => [c.id, c]));
    expect(byId.notion.guide).toBe("connector:notion");
    expect(byId.plain).not.toHaveProperty("guide");

    const described = textOf(
      await mt.describeTools({ addresses: ["notion.search", "plain.search"] }),
    ) as { tools: Array<{ address: string; guide?: string }> };
    expect(described.tools[0].guide).toBe("connector:notion");
    expect(described.tools[1]).not.toHaveProperty("guide");
  });
});

describe("list_connectors", () => {
  it("reports tool counts and per-connector status", async () => {
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(await mt.listConnectors()) as {
      connectors: Array<{
        id: string;
        title?: string;
        toolCount: number;
        status: string;
        checkedAt: string;
        latencyMs: number;
        authorizationUrl?: string;
      }>;
    };
    const byId = Object.fromEntries(parsed.connectors.map((c) => [c.id, c]));

    expect(byId.calc.status).toBe("ok");
    expect(byId.calc.toolCount).toBe(1);
    expect(Number.isNaN(Date.parse(byId.calc.checkedAt))).toBe(false);
    expect(byId.calc.latencyMs).toBeGreaterThanOrEqual(0);
    expect(byId.remote.status).toBe("ok");
    expect(byId.broken.status).toBe("error");
    expect(byId.broken.toolCount).toBe(0);
    expect(byId.needsauth.status).toBe("auth_required");
    expect(byId.needsauth.authorizationUrl).toContain("auth.example");
  });

  it("reports a connector's display title separately from its address id", async () => {
    const titled = api("billing", {
      title: "Acme Billing",
      description: "Acme billing management",
      tools: [
        {
          name: "list",
          description: "List billing records",
          inputSchema: { type: "object" },
          handler: () => [],
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([titled]), BASE).listConnectors(),
    ) as { connectors: Array<{ id: string; title?: string }> };

    expect(parsed.connectors[0]).toMatchObject({
      id: "billing",
      title: "Acme Billing",
    });
  });

  it("does not probe tools after auth_required status", async () => {
    let listToolsCalls = 0;
    const oauth: Connector = {
      id: "oauth",
      async status() {
        return {
          state: "auth_required",
          authorizationUrl: "https://provider.test/authorize?state=first",
        };
      },
      async listTools() {
        listToolsCalls += 1;
        throw new Error("would overwrite OAuth state");
      },
      async callTool() {
        throw new Error("n/a");
      },
    };
    const mt = createMetaTools(makeRegistry([oauth]), BASE);

    const parsed = textOf(await mt.listConnectors()) as {
      connectors: Array<{
        toolCount: number;
        authorizationUrl?: string;
      }>;
    };

    expect(parsed.connectors[0].authorizationUrl).toContain("state=first");
    expect(parsed.connectors[0].toolCount).toBe(0);
    expect(listToolsCalls).toBe(0);
  });

  it("can return cached/observed status without downstream I/O", async () => {
    let statusCalls = 0;
    let listCalls = 0;
    const remote: Connector = {
      id: "quiet",
      kind: "mcp",
      async status() {
        statusCalls++;
        return { state: "ok" };
      },
      async listTools() {
        listCalls++;
        return [{ name: "read" }];
      },
      async callTool() {
        return null;
      },
    };
    const parsed = textOf(
      await createMetaTools(makeRegistry([remote]), BASE).listConnectors({
        probe: false,
      }),
    ) as { connectors: Array<{ status: string; probe: boolean }> };
    expect(parsed.connectors[0]).toMatchObject({
      status: "unknown",
      probe: false,
    });
    expect(statusCalls).toBe(0);
    expect(listCalls).toBe(0);
  });

  it("reports health observed from real generic tool calls", async () => {
    const mt = createMetaTools(makeRegistry([calcConnector]), BASE);
    await mt.callTool({
      address: "calc.add",
      args: { a: 1, b: 2 },
    });
    const parsed = textOf(await mt.listConnectors({ probe: false })) as {
      connectors: Array<{
        status: string;
        lastSuccessAt?: string;
        consecutiveFailures: number;
      }>;
    };
    expect(parsed.connectors[0].status).toBe("ok");
    expect(parsed.connectors[0].lastSuccessAt).toBeTruthy();
    expect(parsed.connectors[0].consecutiveFailures).toBe(0);
  });
});

interface SearchGroup {
  id: string;
  description?: string;
  tools: { name: string; address: string; description?: string }[];
}
interface SearchResult {
  connectors: SearchGroup[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset?: number;
}

describe("search_tools", () => {
  it("substring-matches over name + description, grouped by connector", async () => {
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(
      await mt.searchTools({ query: "echo" }),
    ) as SearchResult;
    // A single matching tool → a single connector group.
    expect(parsed.connectors).toHaveLength(1);
    expect(parsed.connectors[0].id).toBe("remote");
    expect(parsed.connectors[0].tools.map((t) => t.address)).toEqual([
      "remote.echo",
    ]);
    expect(parsed.total).toBe(1);
  });

  it("empty query browses all healthy tools grouped per connector (broken skipped)", async () => {
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(await mt.searchTools({})) as SearchResult;
    // Two healthy connectors with matches → two groups; broken is skipped.
    expect(parsed.connectors.map((c) => c.id).sort()).toEqual([
      "calc",
      "remote",
    ]);
    const byId = Object.fromEntries(parsed.connectors.map((c) => [c.id, c]));
    expect(byId.calc.tools.map((t) => t.address)).toEqual(["calc.add"]);
    expect(byId.remote.tools.map((t) => t.address)).toEqual(["remote.echo"]);
    expect(parsed.total).toBe(2);
  });

  it("respects the connector filter → a single group", async () => {
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(
      await mt.searchTools({ connector: "calc" }),
    ) as SearchResult;
    expect(parsed.connectors).toHaveLength(1);
    expect(parsed.connectors[0].id).toBe("calc");
    expect(parsed.connectors[0].tools.map((t) => t.address)).toEqual([
      "calc.add",
    ]);
    expect(parsed.total).toBe(1);
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
      await mt.searchTools({ limit: 1, offset: parsed.nextOffset }),
    ) as SearchResult;
    expect(next.total).toBe(2);
    expect(next.offset).toBe(1);
    expect(next.hasMore).toBe(false);
    expect(next.connectors.flatMap((c) => c.tools)).toHaveLength(1);
  });

  it("ranks tool-name matches above incidental description matches", async () => {
    const conn: Connector = {
      id: "knowledge",
      description: "Knowledge base",
      async listTools() {
        return [
          {
            name: "article-search",
            description:
              "Search articles, then fetch a matching document for details.",
          },
          {
            name: "article-fetch",
            description: "Fetch an article document by URL or ID.",
          },
        ];
      },
      async callTool() {
        return null;
      },
    };
    const mt = createMetaTools(makeRegistry([conn]), BASE);
    const parsed = textOf(
      await mt.searchTools({ query: "fetch article document" }),
    ) as SearchResult;

    expect(parsed.connectors[0].tools.map((t) => t.name)).toEqual([
      "article-fetch",
      "article-search",
    ]);
  });

  it("returns concise descriptions by default and full text on request", async () => {
    const longDescription = `A tool ${"with extensive documentation ".repeat(20)}`;
    const conn: Connector = {
      id: "docs",
      description: "Docs",
      async listTools() {
        return [{ name: "read", description: longDescription }];
      },
      async callTool() {
        return null;
      },
    };
    const mt = createMetaTools(makeRegistry([conn]), BASE);
    const concise = textOf(await mt.searchTools({})) as SearchResult;
    const full = textOf(
      await mt.searchTools({ fullDescriptions: true }),
    ) as SearchResult;

    expect(concise.connectors[0].tools[0].description!.length).toBeLessThan(
      longDescription.length,
    );
    expect(concise.connectors[0].tools[0].description).toMatch(/…$/);
    expect(full.connectors[0].tools[0].description).toBe(longDescription);
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
      ],
    });
    const mcpConnector: Connector = {
      id: "crm",
      kind: "mcp",
      async listTools() {
        return [
          {
            name: "lookup",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
        ];
      },
      async callTool() {
        return { content: [{ type: "text", text: "{}" }] };
      },
    };
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
          annotations?: Record<string, unknown>;
        }>;
      }>;
    };
    const byId = Object.fromEntries(parsed.connectors.map((c) => [c.id, c]));
    expect(byId.weather.tools[0].inputSchema).toBe("{ city: string }");
    expect(byId.weather.tools[0].outputSchema).toContain("temperature");
    expect(byId.weather.tools[0].annotations).toEqual({
      readOnlyHint: true,
    });
    expect(byId.crm.tools[0].inputSchema).toBe("{ id: string }");
    expect(byId.crm.tools[0].annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
  });

  it("loads independent connector catalogs in parallel", async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connector = (id: string): Connector => ({
      id,
      kind: "mcp",
      async listTools() {
        started++;
        if (started === 2) release();
        await gate;
        return [{ name: "read" }];
      },
      async callTool() {
        return null;
      },
    });
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

describe("describe_tools", () => {
  it("returns the raw JSON Schema for a known address (format: json)", async () => {
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(
      await mt.describeTools({ addresses: ["calc.add"], format: "json" }),
    ) as { tools: Array<{ address: string; inputSchema: any }> };
    expect(parsed.tools[0].address).toBe("calc.add");
    expect(parsed.tools[0].inputSchema.properties.a.type).toBe("number");
  });

  it("renders a compact TypeScript-like shape by default", async () => {
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(
      await mt.describeTools({ addresses: ["calc.add"] }),
    ) as { tools: Array<{ address: string; inputSchema: string }> };
    // a and b are required numbers → no `?`.
    expect(parsed.tools[0].inputSchema).toBe("{ a: number, b: number }");
  });

  it("returns an error entry for unknown addresses without throwing", async () => {
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(
      await mt.describeTools({ addresses: ["calc.nope", "ghost.x"] }),
    ) as { tools: Array<{ address: string; error?: string }> };
    expect(parsed.tools[0].error).toContain("Unknown tool");
    expect(parsed.tools[1].error).toContain("Unknown address");
  });
});

describe("compact schema rendering", () => {
  async function shapeOf(schema: any): Promise<string> {
    const conn: Connector = {
      id: "shape",
      kind: "api",
      description: "Shapes",
      async listTools() {
        return [{ name: "t", description: "t", inputSchema: schema }];
      },
      async callTool() {
        return {};
      },
    };
    const mt = createMetaTools(makeRegistry([conn]), BASE);
    const r = await mt.describeTools({ addresses: ["shape.t"] });
    return (JSON.parse(r.content[0].text) as { tools: any[] }).tools[0]
      .inputSchema as string;
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
});

describe("call_tool", () => {
  it("JSON-wraps an api connector's return value", async () => {
    const mt = createMetaTools(registry(), BASE);
    const result = await mt.callTool({
      address: "calc.add",
      args: { a: 2, b: 3 },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({ sum: 5 });
  });

  it("passes an mcp connector's content array through as-is", async () => {
    const mt = createMetaTools(registry(), BASE);
    const result = await mt.callTool({
      address: "remote.echo",
      args: { text: "hi" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "echo:hi" }]);
  });

  it("optionally unwraps MCP content into a structured value envelope", async () => {
    const mt = createMetaTools(makeRegistry([jsonMcpConnector]), BASE);
    const parsed = textOf(
      await mt.callTool({
        address: "jm.rec",
        resultMode: "value",
        fields: ["a"],
      }),
    ) as { ok: boolean; data: unknown; durationMs: number };

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ a: 1 });
    expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("turns downstream errors into isError results, not throws", async () => {
    const mt = createMetaTools(registry(), BASE);
    const result = await mt.callTool({ address: "calc.bogus", args: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });

  it("returns an isError result for an unknown address", async () => {
    const mt = createMetaTools(registry(), BASE);
    const result = await mt.callTool({ address: "ghost.x" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown address");
  });

  it("returns structured errors in value mode", async () => {
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(
      await mt.callTool({
        address: "ghost.x",
        resultMode: "value",
      }),
    ) as {
      ok: boolean;
      error: { code: string; message: string; retryable: boolean };
      durationMs: number;
    };

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("unknown_address");
    expect(parsed.error.message).toContain("Unknown address");
    expect(parsed.error.retryable).toBe(false);
  });

  it("routes annotated destructive tools through the approval-specific handler", async () => {
    let calls = 0;
    const dangerous = api("danger", {
      tools: [
        {
          name: "erase",
          annotations: {
            destructiveHint: true,
            readOnlyHint: false,
          },
          handler: () => {
            calls++;
            return { erased: true };
          },
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([dangerous]), BASE);

    const ordinary = await mt.callTool({ address: "danger.erase" });
    expect(ordinary.isError).toBe(true);
    expect(ordinary.content[0].text).toContain("call_destructive_tool");
    expect(calls).toBe(0);

    const batch = textOf(
      await mt.batchCall({ calls: [{ address: "danger.erase" }] }),
    ) as { results: Array<{ ok: boolean; errorDetails: { code: string } }> };
    expect(batch.results[0]).toMatchObject({
      ok: false,
      errorDetails: { code: "destructive_tool_requires_approval" },
    });
    expect(calls).toBe(0);

    const approved = await mt.callDestructiveTool({
      address: "danger.erase",
    });
    expect(approved.isError).toBeFalsy();
    expect(textOf(approved)).toEqual({ erased: true });
    expect(calls).toBe(1);
  });

  it("requires approval for unannotated and contradictory tools", async () => {
    const calls: string[] = [];
    const ambiguous = api("ambiguous", {
      tools: [
        {
          name: "unannotated",
          handler: () => {
            calls.push("unannotated");
            return { ok: true };
          },
        },
        {
          name: "contradictory",
          annotations: {
            readOnlyHint: true,
            destructiveHint: true,
          },
          handler: () => {
            calls.push("contradictory");
            return { ok: true };
          },
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([ambiguous]), BASE);

    for (const address of [
      "ambiguous.unannotated",
      "ambiguous.contradictory",
    ]) {
      const ordinary = await mt.callTool({ address });
      expect(ordinary.isError).toBe(true);
      expect(ordinary.content[0].text).toContain("not explicitly read-only");
    }
    expect(calls).toEqual([]);

    const approved = await mt.callDestructiveTool({
      address: "ambiguous.unannotated",
    });
    expect(approved.isError).toBeFalsy();
    expect(calls).toEqual(["unannotated"]);
  });

  it("retries transient failures only for safely annotated API tools", async () => {
    let safeCalls = 0;
    let unsafeCalls = 0;
    const connector = api("retry", {
      tools: [
        {
          name: "safe_read",
          annotations: { readOnlyHint: true },
          handler: () => {
            safeCalls++;
            if (safeCalls === 1) throw new Error("temporary 503");
            return { ok: true };
          },
        },
        {
          name: "unsafe_write",
          handler: () => {
            unsafeCalls++;
            throw new Error("temporary 503");
          },
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const safe = textOf(
      await mt.callTool({
        address: "retry.safe_read",
        resultMode: "value",
        maxRetries: 1,
        diagnostics: true,
      }),
    ) as {
      ok: boolean;
      attempts: number;
      timing: {
        catalogMs: number;
        connectorMs: number;
        backoffMs: number;
        resultProcessingMs: number;
        totalMs: number;
      };
    };
    const unsafe = textOf(
      await mt.callTool({
        address: "retry.unsafe_write",
        resultMode: "value",
        maxRetries: 2,
      }),
    ) as { ok: boolean; attempts: number };

    expect(safe).toMatchObject({ ok: true, attempts: 2 });
    expect(safe.timing.connectorMs).toBeGreaterThanOrEqual(0);
    expect(safe.timing.backoffMs).toBeGreaterThanOrEqual(240);
    expect(safe.timing.totalMs).toBeGreaterThanOrEqual(safe.timing.connectorMs);
    expect(safeCalls).toBe(2);
    expect(unsafe).toMatchObject({
      ok: false,
      attempts: 0,
      error: { code: "destructive_tool_requires_approval" },
    });
    expect(unsafeCalls).toBe(0);
  });

  it("passes a deadline signal to API handlers and returns a timeout error", async () => {
    let sawSignal = false;
    const connector = api("slow", {
      tools: [
        {
          name: "wait",
          annotations: { readOnlyHint: true },
          async handler(_args, ctx) {
            sawSignal = Boolean(ctx.signal);
            await new Promise<void>((resolve) => {
              ctx.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            return { completedAfterAbort: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "slow.wait",
        resultMode: "value",
        timeoutMs: 10,
      }),
    ) as {
      ok: boolean;
      error: { message: string; retryable: boolean };
      attempts: number;
    };
    expect(sawSignal).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toContain("timed out");
    expect(parsed.error.retryable).toBe(true);
    expect(parsed.attempts).toBe(1);
  });

  it("no default deadline unless the deployment configures one", async () => {
    const seen: Array<{ timeoutMs?: number; hasSignal: boolean }> = [];
    const connector = api("budget", {
      tools: [
        {
          name: "peek",
          annotations: { readOnlyHint: true },
          handler: (_args, ctx) => {
            seen.push({
              timeoutMs: ctx.timeoutMs,
              hasSignal: Boolean(ctx.signal),
            });
            return { ok: true };
          },
        },
      ],
    });
    const call = { address: "budget.peek", resultMode: "value" as const };

    // Today's behaviour, unchanged: no budget and no way to be cancelled.
    await createMetaTools(makeRegistry([connector]), BASE).callTool(call);
    expect(seen[0]).toEqual({ timeoutMs: undefined, hasSignal: false });

    // defaultToolTimeoutMs fills the gap for callers that pass none…
    await createMetaTools(makeRegistry([connector]), BASE, {
      defaultToolTimeoutMs: 5_000,
    }).callTool(call);
    expect(seen[1]).toEqual({ timeoutMs: 5_000, hasSignal: true });

    // …and an explicit per-call timeoutMs still wins over it.
    await createMetaTools(makeRegistry([connector]), BASE, {
      defaultToolTimeoutMs: 5_000,
    }).callTool({ ...call, timeoutMs: 25 });
    expect(seen[2]).toEqual({ timeoutMs: 25, hasSignal: true });

    // Including through batch_call, which fans out through the same path.
    await createMetaTools(makeRegistry([connector]), BASE, {
      defaultToolTimeoutMs: 5_000,
    }).batchCall({ calls: [{ address: "budget.peek" }] });
    expect(seen[3]).toEqual({ timeoutMs: 5_000, hasSignal: true });
  });

  it("a configured default deadline aborts and times out a hanging call", async () => {
    const connector = api("stuck", {
      tools: [
        {
          name: "wait",
          annotations: { readOnlyHint: true },
          async handler(_args, ctx) {
            await new Promise<void>((resolve) => {
              ctx.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            return { completedAfterAbort: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE, {
        defaultToolTimeoutMs: 10,
      }).callTool({ address: "stuck.wait", resultMode: "value" }),
    ) as { ok: boolean; error: { code: string; retryable: boolean } };
    expect(parsed).toMatchObject({
      ok: false,
      error: { code: "timeout", retryable: true },
    });
  });

  it("surfaces a connector's retryAfterMs in the error envelope", async () => {
    const connector = api("limited", {
      tools: [
        {
          name: "read",
          annotations: { readOnlyHint: true },
          handler: () => {
            throw new ConnectorCallError("rate_limited", "slow down", {
              retryAfterMs: 3_600_000,
            });
          },
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const parsed = textOf(
      await mt.callTool({ address: "limited.read", resultMode: "value" }),
    ) as {
      ok: boolean;
      attempts: number;
      error: { code: string; retryable: boolean; retryAfterMs?: number };
    };
    // Reported verbatim even though the engine would never wait this long
    // itself — an hour is the agent's decision to make, not the engine's.
    expect(parsed).toMatchObject({
      ok: false,
      attempts: 1,
      error: { code: "rate_limited", retryable: true, retryAfterMs: 3_600_000 },
    });

    const batched = textOf(
      await mt.batchCall({
        calls: [{ address: "limited.read" }],
        resultMode: "value",
      }),
    ) as { results: Array<{ errorDetails: { retryAfterMs?: number } }> };
    expect(batched.results[0].errorDetails.retryAfterMs).toBe(3_600_000);
  });

  it("omits retryAfterMs when the connector reports no window", async () => {
    const connector = api("plain", {
      tools: [
        {
          name: "read",
          annotations: { readOnlyHint: true },
          handler: () => {
            throw new ConnectorCallError("rate_limited", "slow down");
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "plain.read",
        resultMode: "value",
      }),
    ) as { error: Record<string, unknown> };
    expect(parsed.error).toEqual({
      code: "rate_limited",
      message: "slow down",
      retryable: true,
    });
  });

  it("backs off for the connector's retryAfterMs instead of the exponential guess", async () => {
    let calls = 0;
    const connector = api("paced", {
      tools: [
        {
          name: "read",
          annotations: { readOnlyHint: true },
          handler: () => {
            calls++;
            if (calls === 1) {
              throw new ConnectorCallError("rate_limited", "slow down", {
                retryAfterMs: 600,
              });
            }
            return { ok: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "paced.read",
        resultMode: "value",
        maxRetries: 1,
        diagnostics: true,
      }),
    ) as { ok: boolean; attempts: number; timing: { backoffMs: number } };
    expect(parsed).toMatchObject({ ok: true, attempts: 2 });
    // The exponential default for attempt 1 is 250ms; the connector said 600.
    expect(parsed.timing.backoffMs).toBeGreaterThanOrEqual(550);
    expect(calls).toBe(2);
  });

  it("still backs off after an attempt that failed by timing out", async () => {
    // timeoutMs is a per-attempt budget, so an attempt that spends all of it
    // must not shorten the wait before the next one. A whole-call deadline
    // would leave nothing remaining here and retry instantly.
    let calls = 0;
    const connector = api("expiring", {
      tools: [
        {
          name: "read",
          annotations: { readOnlyHint: true },
          async handler(_args, ctx) {
            calls++;
            if (calls === 1) {
              await new Promise<void>((resolve) => {
                ctx.signal?.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
            }
            return { ok: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "expiring.read",
        resultMode: "value",
        timeoutMs: 50,
        maxRetries: 1,
        diagnostics: true,
      }),
    ) as { ok: boolean; attempts: number; timing: { backoffMs: number } };
    expect(parsed).toMatchObject({ ok: true, attempts: 2 });
    // The full 250ms exponential default (less timer slop), not the ~0 a
    // spent whole-call deadline would have left.
    expect(parsed.timing.backoffMs).toBeGreaterThanOrEqual(240);
    expect(calls).toBe(2);
  });

  it("gives every attempt the full timeoutMs budget, not a share of one", async () => {
    let calls = 0;
    const connector = api("perattempt", {
      tools: [
        {
          name: "read",
          annotations: { readOnlyHint: true },
          async handler() {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 40));
            if (calls === 1) throw new Error("temporary 503");
            return { ok: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "perattempt.read",
        resultMode: "value",
        timeoutMs: 60,
        maxRetries: 1,
        diagnostics: true,
      }),
    ) as { ok: boolean; attempts: number; timing: { totalMs: number } };
    // Two 40ms attempts plus a 250ms backoff far exceed the 60ms budget in
    // total, and that is exactly the point: the budget is per attempt.
    expect(parsed).toMatchObject({ ok: true, attempts: 2 });
    expect(parsed.timing.totalMs).toBeGreaterThan(60);
    expect(calls).toBe(2);
  });

  it("waits a reported window in full even when it outlasts the per-attempt budget", async () => {
    let calls = 0;
    const connector = api("windowed", {
      tools: [
        {
          name: "read",
          annotations: { readOnlyHint: true },
          handler: () => {
            calls++;
            if (calls === 1) {
              throw new ConnectorCallError("rate_limited", "slow down", {
                retryAfterMs: 150,
              });
            }
            return { ok: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "windowed.read",
        resultMode: "value",
        timeoutMs: 25,
        maxRetries: 1,
        diagnostics: true,
      }),
    ) as { ok: boolean; attempts: number; timing: { backoffMs: number } };
    expect(parsed).toMatchObject({ ok: true, attempts: 2 });
    // The whole 150ms window (less timer slop), despite a 25ms per-attempt
    // budget that a whole-call deadline would have clamped it to.
    expect(parsed.timing.backoffMs).toBeGreaterThanOrEqual(140);
    expect(calls).toBe(2);
  });

  it("declines the retry outright when the reported window is too long to wait", async () => {
    let calls = 0;
    const connector = api("parked", {
      tools: [
        {
          name: "read",
          annotations: { readOnlyHint: true },
          handler: () => {
            calls++;
            throw new ConnectorCallError("rate_limited", "slow down", {
              retryAfterMs: 30_000,
            });
          },
        },
      ],
    });
    const startedAt = Date.now();
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "parked.read",
        resultMode: "value",
        maxRetries: 2,
        diagnostics: true,
      }),
    ) as {
      ok: boolean;
      attempts: number;
      error: { retryAfterMs?: number };
      timing: { backoffMs: number };
    };
    // Retrying inside a 30s rate-limit window is the harm this channel exists
    // to prevent, and truncating a *known* window to 10s would do exactly
    // that. So: no retry, no wait, and the window reported verbatim.
    expect(parsed).toMatchObject({
      ok: false,
      attempts: 1,
      error: { retryAfterMs: 30_000 },
    });
    expect(parsed.timing.backoffMs).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(calls).toBe(1);
  });

  // The 10s ceiling can't be waited out in a test, so it is asserted on the
  // pure calculation the retry loop calls.
  it("bounds the backoff: a reported window is honoured exactly or not at all", () => {
    // No window reported → the historical exponential guess, capped at 1s.
    expect(retryBackoffMs(1, undefined)).toBe(250);
    expect(retryBackoffMs(2, undefined)).toBe(500);
    expect(retryBackoffMs(3, undefined)).toBe(1_000);
    expect(retryBackoffMs(9, undefined)).toBe(1_000);

    // A reported window replaces the guess, in both directions, and 0 means
    // "retry now" rather than "no window".
    expect(retryBackoffMs(1, 40)).toBe(40);
    expect(retryBackoffMs(1, 4_000)).toBe(4_000);
    expect(retryBackoffMs(1, 0)).toBe(0);

    // Up to the ceiling it is honoured exactly; past it the retry is declined
    // (undefined) rather than truncated into the rate-limit window.
    expect(MAX_RETRY_BACKOFF_MS).toBe(10_000);
    expect(retryBackoffMs(1, MAX_RETRY_BACKOFF_MS)).toBe(MAX_RETRY_BACKOFF_MS);
    expect(retryBackoffMs(1, MAX_RETRY_BACKOFF_MS + 1)).toBe(undefined);
    expect(retryBackoffMs(1, 3_600_000)).toBe(undefined);
  });

  it("a typed non-retryable error is not retried even if its text says timeout", async () => {
    let calls = 0;
    const connector = api("typed", {
      tools: [
        {
          name: "read",
          annotations: { readOnlyHint: true },
          handler: () => {
            calls++;
            throw new ConnectorCallError(
              "connector_call_failed",
              'downstream rejected field "timeout"',
              { retryable: false },
            );
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "typed.read",
        resultMode: "value",
        maxRetries: 2,
      }),
    ) as {
      ok: boolean;
      attempts: number;
      error: { code: string; retryable: boolean };
    };
    // The regex heuristic would have coded this "timeout" and retried it.
    expect(parsed).toMatchObject({
      ok: false,
      attempts: 1,
      error: { code: "connector_call_failed", retryable: false },
    });
    expect(calls).toBe(1);
  });

  it("a typed auth_required from a call keeps its code so the agent can re-auth", async () => {
    const connector = api("expired", {
      tools: [
        {
          name: "read",
          annotations: { readOnlyHint: true },
          handler: () => {
            throw new ConnectorCallError(
              "auth_required",
              'Connector "expired" requires authorization — call authorize_connector({ connector: "expired" }).',
            );
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "expired.read",
        resultMode: "value",
        maxRetries: 2,
      }),
    ) as {
      ok: boolean;
      attempts: number;
      error: { code: string; message: string; retryable: boolean };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.attempts).toBe(1);
    expect(parsed.error.code).toBe("auth_required");
    expect(parsed.error.retryable).toBe(false);
    expect(parsed.error.message).toContain("authorize_connector");
  });

  it("schema-invalid args fail closed as invalid_args without reaching the handler", async () => {
    let calls = 0;
    const connector = api("strict", {
      tools: [
        {
          name: "page",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: { page: { type: "integer" } },
            required: ["page"],
          },
          handler: () => {
            calls++;
            return { ok: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "strict.page",
        resultMode: "value",
        args: { page: "3" },
        maxRetries: 2,
      }),
    ) as {
      ok: boolean;
      attempts: number;
      error: { code: string; retryable: boolean };
    };
    expect(parsed).toMatchObject({
      ok: false,
      attempts: 1,
      error: { code: "invalid_args", retryable: false },
    });
    expect(calls).toBe(0);
  });
});

// A connector returning a rich nested payload (for fields) and a big blob.
const dataConnector: Connector = {
  id: "data",
  kind: "api",
  description: "Data",
  async listTools() {
    return [
      {
        name: "get",
        description: "Get a nested record",
        annotations: { readOnlyHint: true },
      },
      {
        name: "big",
        description: "Return a large blob",
        annotations: { readOnlyHint: true },
      },
    ];
  },
  async callTool(name) {
    if (name === "get") {
      return {
        user: { name: "Ada", address: { city: "London" } },
        results: [{ id: 1 }, { id: 2 }, { id: 3 }],
      };
    }
    if (name === "big") return { blob: "x".repeat(500) };
    throw new Error(`Unknown tool "${name}" on connector "data"`);
  },
};

// An mcp connector whose text block is JSON (for fields over content).
const jsonMcpConnector: Connector = {
  id: "jm",
  kind: "mcp",
  description: "JSON mcp",
  async listTools() {
    return [
      {
        name: "rec",
        description: "record",
        annotations: { readOnlyHint: true },
      },
    ];
  },
  async callTool() {
    return {
      content: [{ type: "text", text: JSON.stringify({ a: 1, b: 2 }) }],
    };
  },
};

describe("call_tool fields selection", () => {
  it("selects nested paths and array maps, omitting misses", async () => {
    const mt = createMetaTools(makeRegistry([dataConnector]), BASE);
    const parsed = textOf(
      await mt.callTool({
        address: "data.get",
        fields: ["user.address.city", "results[].id", "user.missing.deep"],
      }),
    ) as Record<string, unknown>;
    expect(parsed["user.address.city"]).toBe("London");
    expect(parsed["results[].id"]).toEqual([1, 2, 3]);
    expect("user.missing.deep" in parsed).toBe(false);
  });

  it("applies fields to a JSON mcp text block", async () => {
    const mt = createMetaTools(makeRegistry([jsonMcpConnector]), BASE);
    const result = await mt.callTool({ address: "jm.rec", fields: ["a"] });
    expect(JSON.parse(result.content[0].text)).toEqual({ a: 1 });
  });
});

describe("call_tool size guard + get_result", () => {
  it("truncates oversized results and pages the rest via get_result", async () => {
    const registryWithData = makeRegistry([dataConnector]);
    const mt = createMetaTools(registryWithData, BASE, { maxResultBytes: 100 });
    const result = await mt.callTool({ address: "data.big" });
    const lines = result.content[0].text.split("\n");
    const notice = JSON.parse(lines[lines.length - 1]) as {
      truncated: boolean;
      resultId: string;
      totalBytes: number;
    };
    expect(notice.truncated).toBe(true);
    expect(notice.totalBytes).toBeGreaterThan(100);

    // Round-trip the full text back through get_result.
    let offset = 0;
    let assembled = "";
    for (;;) {
      const page = textOf(
        await mt.getResult({ id: notice.resultId, offset, maxBytes: 100 }),
      ) as { text: string; nextOffset?: number; totalBytes: number };
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(assembled).toBe(JSON.stringify({ blob: "x".repeat(500) }, null, 2));
  });

  it("returns an error for an unknown/expired result id", async () => {
    const mt = createMetaTools(makeRegistry([dataConnector]), BASE);
    const result = await mt.getResult({ id: "nope" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown or expired");
  });

  it("replaces oversized value-mode data with a page handle", async () => {
    const mt = createMetaTools(makeRegistry([dataConnector]), BASE, {
      maxResultBytes: 100,
    });
    const parsed = textOf(
      await mt.callTool({
        address: "data.big",
        resultMode: "value",
      }),
    ) as {
      ok: boolean;
      data: { truncated: boolean; resultId: string; totalBytes: number };
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.data.truncated).toBe(true);
    expect(parsed.data.totalBytes).toBeGreaterThan(100);
    const page = textOf(
      await mt.getResult({ id: parsed.data.resultId, maxBytes: 1_000 }),
    ) as { text: string };
    expect(JSON.parse(page.text)).toEqual({ blob: "x".repeat(500) });
  });

  it("pages multi-byte content at a codepoint-splitting boundary byte-exactly", async () => {
    // "aa😀bb" — the emoji is 4 UTF-8 bytes, so a 4-byte page ending at byte 4
    // lands mid-codepoint. Reassembly must equal the original with no U+FFFD.
    const original = JSON.stringify({ v: "aa😀bb界🎉cc" });
    const conn: Connector = {
      id: "mb",
      kind: "api",
      description: "Multibyte",
      async listTools() {
        return [
          {
            name: "get",
            description: "unicode",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool() {
        return JSON.parse(original);
      },
    };
    // cap of 4 forces truncation and 4-byte pages that split codepoints.
    const mt = createMetaTools(makeRegistry([conn]), BASE, {
      maxResultBytes: 4,
    });
    const call = await mt.callTool({ address: "mb.get" });
    const lines = call.content[0].text.split("\n");
    const notice = JSON.parse(lines[lines.length - 1]) as { resultId: string };

    const expected = JSON.stringify(JSON.parse(original), null, 2);
    let offset = 0;
    let assembled = "";
    for (;;) {
      const page = textOf(
        await mt.getResult({ id: notice.resultId, offset, maxBytes: 4 }),
      ) as { text: string; nextOffset?: number };
      expect(page.text).not.toContain("�");
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(assembled).toBe(expected);
  });

  it("guardText's truncated head never ends in a replacement char", async () => {
    // Emoji straddles the cap boundary; the head must stop before it.
    const conn: Connector = {
      id: "mb2",
      kind: "api",
      description: "Multibyte head",
      async listTools() {
        return [
          {
            name: "get",
            description: "unicode",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool() {
        return "abc😀defghijklmnop";
      },
    };
    const mt = createMetaTools(makeRegistry([conn]), BASE, {
      maxResultBytes: 5,
    });
    const call = await mt.callTool({ address: "mb2.get" });
    const head = call.content[0].text.split("\n")[0];
    expect(head).not.toContain("�");
    // Head is a byte-exact prefix of the original (JSON-encoded) string.
    const full = JSON.stringify("abc😀defghijklmnop", null, 2);
    expect(full.startsWith(head)).toBe(true);
  });
});

describe("per-connector maxResultBytes override", () => {
  // ASCII, so byte length == char length, and it JSON-encodes to one line —
  // the truncation notice is therefore always exactly the second line.
  const PAYLOAD = "x".repeat(500);
  const FULL = JSON.stringify(PAYLOAD, null, 2); // 502 bytes

  /** An api connector returning PAYLOAD, optionally under its own byte cap. */
  function capped(id: string, maxResultBytes?: number): Connector {
    return {
      id,
      kind: "api",
      description: "Capped",
      maxResultBytes,
      async listTools() {
        return [
          {
            name: "big",
            description: "Return a large blob",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool() {
        return PAYLOAD;
      },
    };
  }

  interface Notice {
    truncated: boolean;
    resultId: string;
    totalBytes: number;
  }

  /** Split a guarded text result into its head and its truncation notice. */
  function truncation(result: { content: { text: string }[] }): {
    head: string;
    notice: Notice;
  } {
    const [head, notice] = result.content[0].text.split("\n");
    return { head, notice: JSON.parse(notice) as Notice };
  }

  it("truncates at a connector cap lower than the global one", async () => {
    const mt = createMetaTools(makeRegistry([capped("tight", 100)]), BASE, {
      maxResultBytes: 400,
    });
    const { head, notice } = truncation(
      await mt.callTool({ address: "tight.big" }),
    );
    expect(head).toBe(FULL.slice(0, 100));
    expect(notice.truncated).toBe(true);
    expect(notice.totalBytes).toBe(FULL.length);
  });

  it("keeps a result inline under a connector cap higher than the global one", async () => {
    const mt = createMetaTools(makeRegistry([capped("wide", 1_000)]), BASE, {
      maxResultBytes: 100,
    });
    const result = await mt.callTool({ address: "wide.big" });
    expect(result.content[0].text).toBe(FULL);
  });

  it("falls back to the global cap when a connector declares no override", async () => {
    const mt = createMetaTools(makeRegistry([capped("plain")]), BASE, {
      maxResultBytes: 300,
    });
    const { head, notice } = truncation(
      await mt.callTool({ address: "plain.big" }),
    );
    expect(head).toBe(FULL.slice(0, 300));
    expect(notice.totalBytes).toBe(FULL.length);
  });

  it("falls back to the registry default when nothing is configured", async () => {
    // 502 bytes is far below the built-in 50_000, so nothing truncates.
    const mt = createMetaTools(makeRegistry([capped("plain")]), BASE);
    const result = await mt.callTool({ address: "plain.big" });
    expect(result.content[0].text).toBe(FULL);
  });

  it("applies each connector's own cap within one batch_call", async () => {
    const mt = createMetaTools(
      makeRegistry([
        capped("tight", 100),
        capped("plain"),
        capped("wide", 1_000),
      ]),
      BASE,
      { maxResultBytes: 300 },
    );
    const parsed = textOf(
      await mt.batchCall({
        calls: [
          { address: "tight.big" },
          { address: "plain.big" },
          { address: "wide.big" },
        ],
      }),
    ) as { results: Array<{ address: string; result: { text: string }[] }> };
    const [tight, plain, wide] = parsed.results.map((r) => r.result[0].text);

    expect(tight.split("\n")[0]).toBe(FULL.slice(0, 100));
    expect(plain.split("\n")[0]).toBe(FULL.slice(0, 300));
    expect(wide).toBe(FULL);
  });

  it("pages a result truncated under an override through get_result", async () => {
    const mt = createMetaTools(makeRegistry([capped("tight", 100)]), BASE, {
      maxResultBytes: 400,
    });
    const { notice } = truncation(await mt.callTool({ address: "tight.big" }));

    let offset = 0;
    let assembled = "";
    for (;;) {
      const page = textOf(
        await mt.getResult({ id: notice.resultId, offset, maxBytes: 64 }),
      ) as { text: string; nextOffset?: number; totalBytes: number };
      expect(page.totalBytes).toBe(FULL.length);
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(assembled).toBe(FULL);
  });

  it("pages an override-truncated result with get_result's default page size", async () => {
    // Cap above the global one but below the payload: truncation happens at
    // the connector's 300 while get_result, given no maxBytes, falls back to
    // the deployment-wide 100 — so this covers both the larger-than-global
    // truncation and get_result's default page size in one round trip.
    const mt = createMetaTools(makeRegistry([capped("wide", 300)]), BASE, {
      maxResultBytes: 100,
    });
    const { head, notice } = truncation(
      await mt.callTool({ address: "wide.big" }),
    );
    expect(head).toBe(FULL.slice(0, 300));

    let offset = 0;
    let assembled = "";
    let pages = 0;
    for (;;) {
      const page = textOf(
        await mt.getResult({ id: notice.resultId, offset }),
      ) as { text: string; nextOffset?: number; totalBytes: number };
      pages++;
      expect(page.totalBytes).toBe(FULL.length);
      expect(page.text.length).toBeLessThanOrEqual(100);
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    // 502 bytes in 100-byte default pages — the global cap, not the 300 the
    // connector truncated at.
    expect(pages).toBe(6);
    expect(assembled).toBe(FULL);
  });

  it("value mode honours the override too", async () => {
    const mt = createMetaTools(
      makeRegistry([capped("tight", 100), capped("wide", 1_000)]),
      BASE,
      { maxResultBytes: 400 },
    );
    const truncated = textOf(
      await mt.callTool({ address: "tight.big", resultMode: "value" }),
    ) as { data: { truncated?: boolean; totalBytes?: number } };
    const inline = textOf(
      await mt.callTool({ address: "wide.big", resultMode: "value" }),
    ) as { data: unknown };

    expect(truncated.data.truncated).toBe(true);
    expect(truncated.data.totalBytes).toBe(FULL.length);
    expect(inline.data).toBe(PAYLOAD);
  });
});

describe("maxResultBytes validation", () => {
  // Same 502-byte fixture as the override suite above, so the measured heads
  // line up with the numbers in issue #32.
  const PAYLOAD = "x".repeat(500);
  const FULL = JSON.stringify(PAYLOAD, null, 2); // 502 bytes

  /** Caps that are accepted today but silently do something wrong (issue #32). */
  const BAD_CAPS = [0, -1, -50, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

  function capped(id: string, maxResultBytes?: number): Connector {
    return {
      id,
      kind: "api",
      description: "Capped",
      maxResultBytes,
      async listTools() {
        return [
          {
            name: "big",
            description: "Return a large blob",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool() {
        return PAYLOAD;
      },
    };
  }

  /** Stash an oversized result and hand back its page id. */
  async function stash(): Promise<{
    mt: ReturnType<typeof createMetaTools>;
    resultId: string;
  }> {
    const mt = createMetaTools(makeRegistry([capped("c")]), BASE, {
      maxResultBytes: 100,
    });
    const call = await mt.callTool({ address: "c.big" });
    const notice = JSON.parse(call.content[0].text.split("\n")[1]) as {
      resultId: string;
    };
    return { mt, resultId: notice.resultId };
  }

  it("rejects a get_result maxBytes of 0 instead of never advancing", async () => {
    // Pre-fix this returned { offset: 0, nextOffset: 0, text: "" } — a client
    // paging on nextOffset loops forever.
    const { mt, resultId } = await stash();
    const result = await mt.getResult({ id: resultId, offset: 0, maxBytes: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid maxBytes 0");
  });

  it("rejects every get_result maxBytes that is not a whole positive byte count", async () => {
    const { mt, resultId } = await stash();
    for (const maxBytes of BAD_CAPS) {
      const result = await mt.getResult({ id: resultId, maxBytes });
      expect(result.isError, `maxBytes ${String(maxBytes)}`).toBe(true);
      expect(result.content[0].text).toContain("Invalid maxBytes");
    }
  });

  it("accepts the 1-byte floor and still pages to completion", async () => {
    const { mt, resultId } = await stash();
    let offset = 0;
    let assembled = "";
    for (let guard = 0; guard < FULL.length + 10; guard++) {
      const page = textOf(
        await mt.getResult({ id: resultId, offset, maxBytes: 1 }),
      ) as { text: string; nextOffset?: number };
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(assembled).toBe(FULL);
  });

  it("always advances past the offset, whatever end is asked for", () => {
    // Belt and braces behind the argument check: an empty or inverted window
    // must still yield forward progress rather than nextOffset === offset.
    const bytes = new TextEncoder().encode('"aa😀bb"');
    for (const end of [-5, 0, 1, 2]) {
      expect(
        alignEndToCharBoundary(bytes, 1, end, bytes.length),
        `end ${end}`,
      ).toBeGreaterThan(1);
    }
    // At a multi-byte codepoint the widened window still lands on a boundary:
    // byte 3 starts the 4-byte emoji, so the whole emoji comes along.
    expect(alignEndToCharBoundary(bytes, 3, 3, bytes.length)).toBe(7);
  });

  it("ignores a deployment cap that would zero or invert the guard", async () => {
    for (const maxResultBytes of BAD_CAPS) {
      const mt = createMetaTools(makeRegistry([capped("c")]), BASE, {
        maxResultBytes,
      });
      const result = await mt.callTool({ address: "c.big" });
      // Falls back to the built-in 50_000, so 502 bytes stay inline whole —
      // never an empty head (0/NaN) or an over-long one (negatives).
      expect(result.content[0].text, `cap ${String(maxResultBytes)}`).toBe(FULL);
    }
  });

  it("ignores a connector override that would zero or invert the guard", async () => {
    for (const override of BAD_CAPS) {
      const mt = createMetaTools(makeRegistry([capped("c", override)]), BASE, {
        maxResultBytes: 400,
      });
      const result = await mt.callTool({ address: "c.big" });
      const [head] = result.content[0].text.split("\n");
      // Inherits the deployment-wide 400 exactly as an unset override would.
      expect(head, `override ${String(override)}`).toBe(FULL.slice(0, 400));
    }
  });

  it("leaves valid caps byte-identical at every level", async () => {
    // The floor, a tiny cap, and a cap either side of the payload — all
    // unchanged by validation.
    for (const cap of [1, 4, 100, 400, 1_000]) {
      const viaGlobal = await createMetaTools(
        makeRegistry([capped("c")]),
        BASE,
        { maxResultBytes: cap },
      ).callTool({ address: "c.big" });
      const viaOverride = await createMetaTools(
        makeRegistry([capped("c", cap)]),
        BASE,
        { maxResultBytes: 50_000 },
      ).callTool({ address: "c.big" });
      const expected = cap >= FULL.length ? FULL : FULL.slice(0, cap);
      expect(viaGlobal.content[0].text.split("\n")[0], `global ${cap}`).toBe(
        expected,
      );
      expect(
        viaOverride.content[0].text.split("\n")[0],
        `override ${cap}`,
      ).toBe(expected);
    }
  });
});

describe("batch_call", () => {
  it("runs calls in parallel, isolates failures, and applies per-call fields", async () => {
    const mt = createMetaTools(
      makeRegistry([dataConnector, calcConnector]),
      BASE,
    );
    const parsed = textOf(
      await mt.batchCall({
        calls: [
          { address: "calc.add", args: { a: 1, b: 2 } },
          { address: "data.get", fields: ["user.name"] },
          { address: "calc.bogus" },
        ],
      }),
    ) as {
      results: Array<{
        address: string;
        ok: boolean;
        result?: { text: string }[];
        error?: string;
        errorDetails?: {
          code: string;
          message: string;
          retryable: boolean;
        };
        durationMs: number;
      }>;
      durationMs: number;
    };
    expect(parsed.results.map((r) => r.address)).toEqual([
      "calc.add",
      "data.get",
      "calc.bogus",
    ]);
    expect(JSON.parse(parsed.results[0].result![0].text)).toEqual({ sum: 3 });
    expect(JSON.parse(parsed.results[1].result![0].text)).toEqual({
      "user.name": "Ada",
    });
    expect(parsed.results[2].ok).toBe(false);
    expect(parsed.results[2].error).toContain("Unknown tool");
    expect(parsed.results[2].errorDetails?.code).toBe("unknown_tool");
    expect(parsed.results.every((r) => r.durationMs >= 0)).toBe(true);
    expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns unwrapped data for the whole batch in value mode", async () => {
    const mt = createMetaTools(
      makeRegistry([jsonMcpConnector, calcConnector]),
      BASE,
    );
    const parsed = textOf(
      await mt.batchCall({
        resultMode: "value",
        calls: [
          { address: "calc.add", args: { a: 2, b: 4 } },
          { address: "jm.rec", fields: ["b"] },
        ],
      }),
    ) as {
      results: Array<{
        address: string;
        ok: boolean;
        data: unknown;
        durationMs: number;
      }>;
    };

    expect(parsed.results[0].data).toEqual({ sum: 6 });
    expect(parsed.results[1].data).toEqual({ b: 2 });
  });
});

describe("authorize_connector", () => {
  it("starts the flow and returns the authorization URL with instructions", async () => {
    authConnector.startAuthCalls.length = 0;
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(
      await mt.authorizeConnector({ connector: "needsauth" }),
    ) as {
      connector: string;
      status: string;
      authorizationUrl?: string;
      instructions?: string;
    };
    expect(parsed.connector).toBe("needsauth");
    expect(parsed.status).toBe("auth_required");
    expect(parsed.authorizationUrl).toContain("auth.example");
    expect(parsed.instructions).toContain("/oauth/callback/");
    expect(authConnector.startAuthCalls).toEqual([{ force: undefined }]);
  });

  it("passes force through to the connector", async () => {
    authConnector.startAuthCalls.length = 0;
    const mt = createMetaTools(registry(), BASE);
    await mt.authorizeConnector({ connector: "needsauth", force: true });
    expect(authConnector.startAuthCalls).toEqual([{ force: true }]);
  });

  it("errors for a connector without downstream OAuth", async () => {
    const mt = createMetaTools(registry(), BASE);
    const result = await mt.authorizeConnector({ connector: "calc" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not use downstream OAuth");
  });

  it("errors for an unknown connector", async () => {
    const mt = createMetaTools(registry(), BASE);
    const result = await mt.authorizeConnector({ connector: "ghost" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown connector");
  });

  it("errors when startAuth reports auth_required without a URL", async () => {
    const noUrl: Connector = {
      id: "nourl",
      kind: "mcp",
      async listTools() {
        throw new Error("unauthorized");
      },
      async callTool() {
        throw new Error("unauthorized");
      },
      async startAuth() {
        return { state: "auth_required" };
      },
    };
    const mt = createMetaTools(makeRegistry([noUrl]), BASE);
    const result = await mt.authorizeConnector({ connector: "nourl" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no URL is available");
  });

  it("surfaces a startAuth error state as a structured error status (not isError)", async () => {
    const errConn: Connector = {
      id: "erroauth",
      kind: "mcp",
      async listTools() {
        throw new Error("x");
      },
      async callTool() {
        throw new Error("x");
      },
      async startAuth() {
        return { state: "error", message: "connect ECONNREFUSED" };
      },
    };
    const mt = createMetaTools(makeRegistry([errConn]), BASE);
    const result = await mt.authorizeConnector({ connector: "erroauth" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text) as {
      status: string;
      message?: string;
    };
    expect(parsed.status).toBe("error");
    expect(parsed.message).toContain("ECONNREFUSED");
  });

  it("invalidates the tool cache even when startAuth throws", async () => {
    const throwConn: Connector = {
      id: "throws",
      kind: "mcp",
      async listTools() {
        throw new Error("x");
      },
      async callTool() {
        throw new Error("x");
      },
      async startAuth() {
        throw new Error("boom during force");
      },
    };
    const reg = makeRegistry([throwConn]);
    let invalidated = 0;
    const origInvalidateStored = reg.invalidateStored.bind(reg);
    reg.invalidateStored = async (id: string) => {
      invalidated++;
      await origInvalidateStored(id);
    };
    const mt = createMetaTools(reg, BASE);
    const result = await mt.authorizeConnector({ connector: "throws" });
    expect(result.isError).toBe(true);
    expect(invalidated).toBe(1);
  });
});

describe("probe timeout", () => {
  /** A connector whose downstream tool listing never resolves. */
  const hangingConnector: Connector = {
    id: "hang",
    kind: "mcp",
    description: "Never resolves",
    listTools() {
      return new Promise<never>(() => {});
    },
    async callTool() {
      throw new Error("n/a");
    },
  };

  it("search_tools degrades a hung connector to unavailable within the timeout", async () => {
    const mt = createMetaTools(makeRegistry([hangingConnector, calcConnector]), BASE, {
      probeTimeoutMs: 50,
    });
    const started = Date.now();
    const parsed = textOf(await mt.searchTools({ query: "" })) as {
      connectors: Array<{ id: string }>;
    };
    // Returns rather than hanging: the healthy connector still resolves, the
    // hung one is simply absent (its rejected catalog is dropped).
    expect(Date.now() - started).toBeLessThan(2_000);
    const ids = parsed.connectors.map((c) => c.id);
    expect(ids).toContain("calc");
    expect(ids).not.toContain("hang");
  });

  it("list_connectors reports a hung connector as errored within the timeout", async () => {
    const mt = createMetaTools(makeRegistry([hangingConnector]), BASE, {
      probeTimeoutMs: 50,
    });
    const started = Date.now();
    const parsed = textOf(await mt.listConnectors({ probe: true })) as {
      connectors: Array<{ id: string; status: string; message?: string }>;
    };
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(parsed.connectors[0]).toMatchObject({ id: "hang", status: "error" });
    expect(parsed.connectors[0].message).toContain("timed out");
  });

  it("describe_tools reports a hung connector's tool as errored within the timeout", async () => {
    const mt = createMetaTools(makeRegistry([hangingConnector]), BASE, {
      probeTimeoutMs: 50,
    });
    const started = Date.now();
    const parsed = textOf(await mt.describeTools({ addresses: ["hang.read"] })) as {
      tools: Array<{ address: string; error?: string }>;
    };
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(parsed.tools[0].address).toBe("hang.read");
    expect(parsed.tools[0].error).toContain("timed out");
  });
});
