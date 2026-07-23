import { describe, expect, it } from "vitest";
import { api } from "../src/connectors/api.js";
import { createMetaTools } from "../src/meta-tools.js";
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
