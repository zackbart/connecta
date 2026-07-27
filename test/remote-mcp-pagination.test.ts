import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolResult,
  Tool,
  JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { createMetaTools } from "../src/meta-tools.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectorContext, KVStorage, Logger } from "../src/types.js";
import { makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";

/**
 * A cursor that is hostile to anything that treats cursors as anything but an
 * opaque token: it looks like base64, carries query syntax, a slash, a
 * backslash, and a raw space. If the connector parsed, re-encoded, trimmed, or
 * URL-mangled it, the fixture server would not recognize it and the refresh
 * would fail loudly.
 */
const OPAQUE_CURSOR = 'eyJwIjoyfQ==?page=2&next=/a\\b c%20';

/**
 * The MCP spec ends pagination on an ABSENT `nextCursor`. An empty string is
 * present, so a page advertising `""` still has a successor.
 */
const EMPTY_CURSOR = "";

/**
 * The two ceilings `src/connectors/remote-mcp.ts` enforces, restated here so
 * moving either has to come past these tests on purpose. The tool ceiling is
 * the real bound (it is what a refresh holds in memory); the page ceiling is a
 * runaway backstop no honest server reaches.
 */
const MAX_TOOLS = 100_000;
const MAX_TOOL_PAGES = 10_000;

function ctx(storage: KVStorage = memoryStorage()): ConnectorContext {
  return { storage, logger: silentLogger, baseUrl: BASE };
}

/** A logger that keeps its warnings so a test can assert one was emitted. */
function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    ...silentLogger,
    warnings,
    warn: (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    },
  };
}

function tool(name: string, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
    },
    annotations: { readOnlyHint: true },
    ...extra,
  } as Tool;
}

interface Page {
  tools: Tool[];
  /** Present (including "") means "there is another page". */
  nextCursor?: string;
}

type PageResult = { tools: Tool[]; nextCursor?: string };

interface Fixture {
  /** Every `cursor` param the server saw, in order. `undefined` = first page. */
  cursors: Array<string | undefined>;
  /** How many transports the connector built — i.e. how many connects. */
  builds: () => number;
  connector: ReturnType<typeof remoteMcp>;
}

/**
 * A downstream MCP server whose tools/list behavior is supplied per request, so
 * a suite can express a page chain, a mid-chain fault, or a server that never
 * stops advertising successors.
 *
 * Each transport the connector builds gets its own linked pair and its own
 * server instance — the same shape production has, where a request-scoped
 * client speaks to one session and the next request opens a new one. The cursor
 * log spans them all, so a test can see whether a later session resumed
 * mid-chain (it must not) or restarted from the first page (it must).
 */
function fixture(
  listTools: (
    cursor: string | undefined,
    call: number,
  ) => PageResult | Promise<PageResult>,
  opts: {
    /** Return an Error to fail an outbound message instead of delivering it. */
    sendFault?: (message: JSONRPCMessage) => Error | undefined;
    /**
     * Called with each inbound message *after* the SDK client has handled it.
     * The client resolves its pending request synchronously, so the page loop's
     * continuation is queued but has not run yet — which is exactly the window
     * a between-pages guard has to survive.
     */
    afterInbound?: (message: JSONRPCMessage) => void;
    /** Downstream `tools/call` behaviour; defaults to echoing the tool name. */
    callTool?: (name: string) => CallToolResult;
    id?: string;
  } = {},
): Fixture {
  const cursors: Array<string | undefined> = [];
  let builds = 0;
  return {
    cursors,
    builds: () => builds,
    connector: remoteMcp(opts.id ?? "paged", {
      url: "https://unused.example/mcp",
      description: "Paginated downstream",
      _transportFactory: () => {
        builds++;
        const [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair();
        const server = new Server(
          { name: "paged-downstream", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, async (request) => {
          const cursor = request.params?.cursor;
          cursors.push(cursor);
          return listTools(cursor, cursors.length);
        });
        server.setRequestHandler(CallToolRequestSchema, async (request) =>
          opts.callTool
            ? opts.callTool(request.params.name)
            : {
                content: [
                  { type: "text" as const, text: `ran:${request.params.name}` },
                ],
                structuredContent: { ran: request.params.name },
              },
        );
        // Protocol.connect attaches the transport's onmessage synchronously, so
        // the client's initialize is handled even though this factory cannot
        // await. Failures land in the closer below rather than unhandled.
        const connected = server.connect(serverTransport);
        closers.push(async () => {
          await connected.catch(() => {});
          await server.close().catch(() => {});
        });
        if (!opts.sendFault && !opts.afterInbound) return clientTransport;
        // Faults are injected on the wire, not in the downstream handler: a
        // page request that never lands is the failure mode this cares about,
        // and it keeps the fixture server from rejecting a request it already
        // accepted. Inbound messages are tapped on the same seam.
        const tapped: Transport = {
          start: () => clientTransport.start(),
          async send(message, sendOpts) {
            const fault = opts.sendFault?.(message);
            if (fault) throw fault;
            return clientTransport.send(message, sendOpts);
          },
          close: () => clientTransport.close(),
        };
        for (const key of ["onclose", "onerror"] as const) {
          Object.defineProperty(tapped, key, {
            get: () => clientTransport[key],
            set: (value) => {
              clientTransport[key] = value as never;
            },
          });
        }
        Object.defineProperty(tapped, "onmessage", {
          get: () => clientTransport.onmessage,
          set: (value: Transport["onmessage"]) => {
            clientTransport.onmessage =
              value && opts.afterInbound
                ? (message, extra) => {
                    value(message, extra);
                    opts.afterInbound!(message);
                  }
                : value;
          },
        });
        return tapped;
      },
    }),
  };
}

/** True for a `tools/list` asking for a page after the first. */
function isLaterPageRequest(message: JSONRPCMessage): boolean {
  const m = message as {
    method?: string;
    params?: { cursor?: string };
  };
  return m.method === "tools/list" && m.params?.cursor !== undefined;
}

/** Three pages: `alpha` | `beta` (opaque cursor) | `gamma` (empty cursor). */
function threePages(): (cursor: string | undefined) => PageResult {
  const pages: Page[] = [
    { tools: [tool("alpha")], nextCursor: OPAQUE_CURSOR },
    { tools: [tool("beta")], nextCursor: EMPTY_CURSOR },
    {
      tools: [
        tool("gamma", {
          description: "Only reachable on the last page",
          outputSchema: {
            type: "object",
            properties: { ran: { type: "string" } },
          },
          annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            title: "Gamma",
          },
        }),
      ],
    },
  ];
  const byCursor = new Map<string, number>();
  pages.forEach((page, index) => {
    if (page.nextCursor !== undefined) byCursor.set(page.nextCursor, index + 1);
  });
  return (cursor) => {
    const index = cursor === undefined ? 0 : byCursor.get(cursor);
    if (index === undefined) {
      // Only reachable if the connector altered the cursor it was handed.
      throw new Error(`unrecognized cursor ${JSON.stringify(cursor)}`);
    }
    const page = pages[index];
    return {
      tools: page.tools,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    };
  };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe("remoteMcp() tools/list pagination", () => {
  it("collects every page, in server order, with metadata intact", async () => {
    const { connector, cursors } = fixture(threePages());

    const tools = await connector.listTools(ctx());

    expect(tools.map((t) => t.name)).toEqual(["alpha", "beta", "gamma"]);
    // Each nextCursor handed straight back, byte for byte, and the chain ends
    // only on the page that omitted it.
    expect(cursors).toEqual([undefined, OPAQUE_CURSOR, EMPTY_CURSOR]);
    const gamma = tools[2];
    expect(gamma.description).toBe("Only reachable on the last page");
    expect((gamma.inputSchema as any).properties.text.type).toBe("string");
    expect((gamma.outputSchema as any).properties.ran.type).toBe("string");
    expect(gamma.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      title: "Gamma",
    });
  });

  it("costs exactly one request, with no cursor param, when nothing paginates", async () => {
    const { connector, cursors } = fixture(() => ({
      tools: [tool("only")],
    }));

    const tools = await connector.listTools(ctx());

    expect(tools.map((t) => t.name)).toEqual(["only"]);
    expect(cursors).toEqual([undefined]);
  });

  it("keeps paging past an empty-string cursor rather than reading it as done", async () => {
    const { connector, cursors } = fixture((cursor) =>
      cursor === undefined
        ? { tools: [tool("first")], nextCursor: EMPTY_CURSOR }
        : { tools: [tool("second")] },
    );

    const tools = await connector.listTools(ctx());

    expect(tools.map((t) => t.name)).toEqual(["first", "second"]);
    expect(cursors).toEqual([undefined, EMPTY_CURSOR]);
  });

  it("rides one request-scoped client for the whole chain", async () => {
    const { connector, cursors, builds } = fixture(threePages());
    const scope = {};
    const context = { ...ctx(), requestScope: scope };

    const tools = await connector.listTools(context);

    expect(tools).toHaveLength(3);
    expect(cursors).toHaveLength(3);
    // Three pages, one connect: no page opened a session of its own.
    expect(builds()).toBe(1);

    // And nothing survives the scope: the next request reconnects and repages
    // from scratch rather than resuming a cursor from the last one.
    await connector.closeScope!(context);
    const next = await connector.listTools({ ...ctx(), requestScope: {} });
    expect(next).toHaveLength(3);
    expect(builds()).toBe(2);
    expect(cursors.slice(3)).toEqual([undefined, OPAQUE_CURSOR, EMPTY_CURSOR]);
  });

  it("fails the whole refresh when a later page errors", async () => {
    const attempted: Array<string | undefined> = [];
    const { connector, cursors } = fixture(threePages(), {
      sendFault: (message) => {
        if (!isLaterPageRequest(message)) return undefined;
        attempted.push((message as any).params.cursor);
        return new Error("page two never landed");
      },
    });

    // Rejects rather than resolving with the first page it had in hand.
    await expect(connector.listTools(ctx())).rejects.toThrow(
      /page two never landed/,
    );
    expect(cursors).toEqual([undefined]);
    expect(attempted).toEqual([OPAQUE_CURSOR]);
  });

  it("stops paging when the scope ends mid-chain instead of running on detached", async () => {
    let reachedPageTwo!: () => void;
    const atPageTwo = new Promise<void>((resolve) => {
      reachedPageTwo = resolve;
    });
    let releasePageTwo!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePageTwo = resolve;
    });
    const { connector, cursors } = fixture(async (_cursor, call) => {
      if (call === 1) return { tools: [tool("alpha")], nextCursor: "p2" };
      reachedPageTwo();
      await gate;
      return { tools: [tool("beta")], nextCursor: "p3" };
    });
    const context = { ...ctx(), requestScope: {} };

    const pending = connector
      .listTools(context)
      .then(() => null, (err: unknown) => err);
    await atPageTwo;
    // This is what a probe deadline does: abandon the caller and tear the scope
    // down. The page loop must die with it.
    await connector.closeScope!(context);
    releasePageTwo();

    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    // A real failure, not a TypeError from paging on a torn-down client.
    expect(err).not.toBeInstanceOf(TypeError);
    // Page three was never requested — nothing kept walking the chain.
    expect(cursors).toEqual([undefined, "p2"]);
  });

  it("throws the scope-ended error when the scope closes between pages", async () => {
    let connector!: ReturnType<typeof remoteMcp>;
    const context = { ...ctx(), requestScope: {} };
    let pages = 0;
    const f = fixture(threePages(), {
      afterInbound: (message) => {
        // The page-one response has been handed to the client, which resolved
        // its pending request — but resolving only *queues* the loop's
        // continuation. So this is the between-pages window, and tearing the
        // scope down here without awaiting is precisely what a probe deadline
        // does: closeScope's synchronous prefix sets `closed` before the loop
        // ever wakes up.
        const result = (message as { result?: { tools?: unknown[] } }).result;
        if (result?.tools && ++pages === 1) void connector.closeScope!(context);
      },
    });
    connector = f.connector;

    // The specific error matters. Delete the between-pages `closed` check and
    // the loop still fails — but on a torn-down transport, with page two
    // already on the wire, which is the thing the guard exists to prevent.
    await expect(f.connector.listTools(context)).rejects.toThrow(
      /scope ended during connection/,
    );
    expect(f.cursors).toEqual([undefined]);
  });

  it("keeps the first definition when an unstable cursor overlaps pages", async () => {
    const { connector } = fixture((cursor) =>
      cursor === undefined
        ? {
            tools: [tool("alpha"), tool("beta", { description: "first" })],
            nextCursor: "p2",
          }
        : { tools: [tool("beta", { description: "second" }), tool("gamma")] },
    );

    const tools = await connector.listTools(ctx());

    // Three real tools, not four. A duplicate would inflate toolCount, double
    // the tool's search_tools row, and make the registry's catalog-changed
    // comparison see churn where the catalog never moved.
    expect(tools.map((t) => t.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(tools[1].description).toBe("first");

    const listed = await createMetaTools(
      makeRegistry([connector]),
      BASE,
    ).listConnectors({ probe: true });
    expect(JSON.parse(listed.content[0].text).connectors[0].toolCount).toBe(3);
  });

  it("fails immediately when a cursor is handed back a second time", async () => {
    const { connector, cursors } = fixture((_cursor, call) => ({
      tools: [tool(`t${call}`)],
      nextCursor: "same",
    }));

    await expect(connector.listTools(ctx())).rejects.toThrow(
      /pagination chain loops/,
    );
    // Two round trips to prove a loop, not a ceiling's worth of them.
    expect(cursors).toEqual([undefined, "same"]);
  });

  it("tolerates the one empty page a full page's cursor promised", async () => {
    const { connector, cursors } = fixture((cursor) =>
      cursor === undefined
        ? { tools: [tool("alpha")], nextCursor: "p2" }
        : cursor === "p2"
          ? { tools: [], nextCursor: "p3" }
          : { tools: [tool("beta")] },
    );

    const tools = await connector.listTools(ctx());

    expect(tools.map((t) => t.name)).toEqual(["alpha", "beta"]);
    expect(cursors).toEqual([undefined, "p2", "p3"]);
  });

  it("gives up after two consecutive pages that add nothing", async () => {
    const { connector, cursors } = fixture((_cursor, call) => ({
      tools: call === 1 ? [tool("alpha")] : [],
      nextCursor: `cursor-${call}`,
    }));

    await expect(connector.listTools(ctx())).rejects.toThrow(
      /not advancing/,
    );
    // A fresh-cursor-forever adversary dies in three round trips, not 10,000.
    expect(cursors).toHaveLength(3);
  });

  it("gives up just as fast when the barren pages are full of tools it already has", async () => {
    const { connector, cursors } = fixture((_cursor, call) => ({
      // Never empty — the same tool, over and over, behind a cursor that is
      // new every time. Progress is what the walk *accumulated*, not what the
      // page *contained*: measure it by `res.tools.length` instead of by what
      // survived dedup and this adversary sails past the guard entirely and
      // rides the 10,000-page backstop instead.
      tools: [tool("alpha")],
      nextCursor: `cursor-${call}`,
    }));

    await expect(connector.listTools(ctx())).rejects.toThrow(/not advancing/);
    expect(cursors).toHaveLength(3);
  });

  it("collects a conformant 10,000-tool catalog paged at 100, terminator and all", async () => {
    const PAGE = 100;
    const TOTAL = 10_000;
    const { connector, cursors } = fixture((cursor) => {
      const offset = cursor === undefined ? 0 : Number(cursor);
      const slice = Array.from(
        { length: Math.max(0, Math.min(PAGE, TOTAL - offset)) },
        (_, i) => tool(`t${offset + i}`),
      );
      // The common conformant idiom: advertise a successor whenever the page
      // came back full. The hundredth full page therefore promises one more,
      // and the server honours it with an empty terminating page — 101
      // requests for a catalog well inside connecta's operating envelope.
      return slice.length === PAGE
        ? { tools: slice, nextCursor: String(offset + PAGE) }
        : { tools: slice };
    });

    const tools = await connector.listTools(ctx());

    expect(tools).toHaveLength(TOTAL);
    expect(cursors).toHaveLength(TOTAL / PAGE + 1);
  });

  it("stops a walk that would accumulate more tools than a refresh will hold", async () => {
    const flood = Array.from(
      { length: MAX_TOOLS + 1 },
      (_, i) => tool(`t${i}`, { description: undefined }),
    );
    const { connector, cursors } = fixture(() => ({
      tools: flood,
      nextCursor: "more",
    }));

    await expect(connector.listTools(ctx())).rejects.toThrow(
      new RegExp(`over the ${MAX_TOOLS}-tool ceiling`),
    );
    // The bound is on what the walk accumulates, so it fires before the second
    // request rather than after some number of pages.
    expect(cursors).toEqual([undefined]);
  });

  it("keeps an absolute page backstop for a server that satisfies every other guard", async () => {
    const { connector, cursors } = fixture((_cursor, call) => ({
      tools: [tool(`t${call}`)],
      nextCursor: `cursor-${call}`,
    }));

    // Fresh cursor, a genuinely new tool, every page: no loop, no stall, and
    // nowhere near the tool ceiling. Nothing but the backstop ends this.
    await expect(connector.listTools(ctx())).rejects.toThrow(
      /refusing to page further/,
    );
    expect(cursors).toHaveLength(MAX_TOOL_PAGES);
  });

  it("names the nonconformance when a page ends pagination with a null cursor", async () => {
    const { connector } = fixture(() => ({
      tools: [tool("alpha")],
      nextCursor: null as unknown as string,
    }));

    // `null` is a common JSON idiom for "no more pages" and the MCP result
    // schema does not accept it. The operator gets told which server broke
    // which rule, rather than a raw validation dump about `nextCursor`.
    await expect(connector.listTools(ctx())).rejects.toThrow(
      /nextCursor is neither a string nor absent/,
    );
  });

  it("blames the cursor only when the cursor is what broke", async () => {
    const { connector } = fixture(() => ({
      // A page whose *tool* is malformed — no inputSchema — with a perfectly
      // legal (absent) cursor. Both faults arrive as the same kind of result
      // validation failure, so the diagnosis above is told apart from this one
      // by the issue path alone. Widen that predicate and every unparseable
      // page gets misdiagnosed as a null cursor, pointing the operator at a
      // field that was never the problem.
      tools: [{ name: "broken" } as unknown as Tool],
    }));

    const err = await connector
      .listTools(ctx())
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/nextCursor/);
    // The raw validation failure reaches the operator unedited, still pointing
    // at the tool entry that broke.
    const issues = (err as { issues?: Array<{ path?: unknown[] }> }).issues;
    expect(issues?.some((issue) => issue.path?.[0] === "tools")).toBe(true);
  });
});

describe("tool metadata re-primed across a paginated catalog", () => {
  const NUMERIC = {
    type: "object",
    properties: { n: { type: "number" } },
    required: ["n"],
  } as unknown as Tool["outputSchema"];

  /** Page one declares `early`, page two `late`; both promise `{ n: number }`. */
  function twoSchemaPages() {
    return (cursor: string | undefined): PageResult =>
      cursor === undefined
        ? {
            tools: [tool("early", { outputSchema: NUMERIC })],
            nextCursor: "p2",
          }
        : { tools: [tool("late", { outputSchema: NUMERIC })] };
  }

  it("re-primes through a Client method the pinned SDK still provides", () => {
    // The re-prime reaches past the SDK's `private` marker deliberately. If a
    // bump renames or drops either half of this pair, the compensation stops
    // compensating and every earlier-page tool silently loses validation
    // again — so fail here, on the dependency bump, not in production.
    const proto = Client.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.cacheToolMetadata).toBe("function");
    expect((proto.cacheToolMetadata as (t: unknown[]) => void).length).toBe(1);
    expect(typeof proto.getToolOutputValidator).toBe("function");
  });

  it("rejects structured content that violates an EARLIER page's output schema", async () => {
    const { connector } = fixture(twoSchemaPages(), {
      callTool: (name) => ({
        content: [{ type: "text", text: `ran:${name}` }],
        structuredContent: { n: "not-a-number" },
      }),
    });
    const context = { ...ctx(), requestScope: {} };
    await connector.listTools(context);

    // The last page is the one the SDK's own per-page caching happened to
    // leave behind, so it is rejected with or without the re-prime.
    await expect(connector.callTool("late", {}, context)).rejects.toThrow(
      /output schema/i,
    );
    // This is the one that matters. Without re-priming the client from the
    // full walked catalog, `early` has no cached validator and the same bad
    // payload sails straight through — enforcement would depend on which page
    // a tool happened to land on, which is not enforcement.
    await expect(connector.callTool("early", {}, context)).rejects.toThrow(
      /output schema/i,
    );
  });

  it("still catches an EARLIER page's tool returning no structured content at all", async () => {
    const { connector } = fixture(twoSchemaPages(), {
      callTool: (name) => ({ content: [{ type: "text", text: `ran:${name}` }] }),
    });
    const context = { ...ctx(), requestScope: {} };
    await connector.listTools(context);

    await expect(connector.callTool("early", {}, context)).rejects.toThrow(
      /did not return structured content/i,
    );
  });

  it("leaves a conforming result alone on every page", async () => {
    const { connector } = fixture(twoSchemaPages(), {
      callTool: (name) => ({
        content: [{ type: "text", text: `ran:${name}` }],
        structuredContent: { n: 42 },
      }),
    });
    const context = { ...ctx(), requestScope: {} };
    await connector.listTools(context);

    for (const name of ["early", "late"]) {
      await expect(
        connector.callTool(name, {}, context),
      ).resolves.toMatchObject({ structuredContent: { n: 42 } });
    }
  });

  it("re-primes from RAW SDK tools, so an earlier page's required-task declaration still binds", async () => {
    const { connector } = fixture((cursor) =>
      cursor === undefined
        ? {
            tools: [
              tool("gated", {
                execution: { taskSupport: "required" },
              } as Partial<Tool>),
            ],
            nextCursor: "p2",
          }
        : { tools: [tool("plain")] },
    );
    const context = { ...ctx(), requestScope: {} };
    await connector.listTools(context);

    // `execution.taskSupport` lives only on the SDK's own tool shape — a
    // ToolDef does not carry it. So the re-prime is handed the raw listing,
    // not the mapped one, and "tidying up the cast" by mapping first would
    // drop this silently: `gated` would be dispatched as an ordinary
    // `tools/call` the downstream never agreed to serve that way. Unlike the
    // output-schema case that is a regression even for a single-page catalog,
    // because the re-prime is unconditional.
    await expect(connector.callTool("gated", {}, context)).rejects.toThrow(
      /task-based execution/i,
    );
    // And the guard stays narrow: the tool that declared nothing still runs.
    await expect(
      connector.callTool("plain", {}, context),
    ).resolves.toMatchObject({ structuredContent: { ran: "plain" } });
  });
});

describe("paginated catalogs through the discovery path", () => {
  it("exposes a last-page-only tool to list/search/describe and to call_tool", async () => {
    const { connector } = fixture(threePages());
    const registry = makeRegistry([connector]);

    const listed = await createMetaTools(registry, BASE).listConnectors({
      probe: true,
    });
    expect(JSON.parse(listed.content[0].text).connectors[0]).toMatchObject({
      id: "paged",
      status: "ok",
      toolCount: 3,
    });

    const meta = createMetaTools(registry, BASE);
    const searched = await meta.searchTools({ query: "gamma" });
    const searchPayload = JSON.parse(searched.content[0].text);
    expect(
      searchPayload.connectors[0].tools.map(
        (t: { address: string }) => t.address,
      ),
    ).toContain("paged.gamma");

    const described = await meta.describeTools({ addresses: ["paged.gamma"] });
    const describePayload = JSON.parse(described.content[0].text);
    expect(describePayload.tools[0]).toMatchObject({
      address: "paged.gamma",
      name: "gamma",
      description: "Only reachable on the last page",
    });

    const called = await meta.callTool({
      address: "paged.gamma",
      args: { text: "hi" },
    });
    expect(called.isError).toBeFalsy();
    expect(called.content[0].text).toBe("ran:gamma");
  });

  it("never exposes a partial catalog when a later page fails, and keeps the stale fallback", async () => {
    let breakLaterPages = false;
    const { connector } = fixture(threePages(), {
      sendFault: (message) =>
        breakLaterPages && isLaterPageRequest(message)
          ? new Error("page two never landed")
          : undefined,
    });
    const logger = recordingLogger();
    const registry = new Registry([connector], {
      storage: memoryStorage(),
      logger,
      // Expire immediately so the next read must attempt a live refresh, while
      // the stale window stays wide open.
      toolCacheTtlSeconds: 0,
      toolCatalogStaleSeconds: 300,
    });
    const scope = {};

    const complete = await registry.getTools("paged", BASE, scope);
    expect(complete.map((t) => t.name)).toEqual(["alpha", "beta", "gamma"]);

    breakLaterPages = true;
    // The refresh fails as a whole; the last COMPLETE catalog is served, never
    // the one-page prefix the failed refresh had already collected.
    const served = await registry.getTools("paged", BASE, scope);
    expect(served.map((t) => t.name)).toEqual(["alpha", "beta", "gamma"]);
    // The same list either way, so the list alone cannot tell "stale fallback
    // served" from "the fault never fired". The warning can.
    expect(
      logger.warnings.some((w) =>
        /catalog refresh failed; serving stale catalog/.test(w),
      ),
    ).toBe(true);
    expect(logger.warnings.some((w) => /page two never landed/.test(w))).toBe(
      true,
    );

    await connector.closeScope!({ ...ctx(), requestScope: scope });
  });

  it("surfaces a non-terminating downstream as a connector error, not a truncated catalog", async () => {
    const { connector } = fixture((_cursor, call) => ({
      tools: [tool(`t${call}`)],
      nextCursor: "same",
    }));
    const registry = makeRegistry([connector]);

    const listed = await createMetaTools(registry, BASE).listConnectors({
      probe: true,
    });
    const entry = JSON.parse(listed.content[0].text).connectors[0];

    expect(entry.status).toBe("error");
    expect(entry.message).toMatch(/pagination chain loops/);
    expect(entry.toolCount).toBe(0);
    expect(registry.peekTools("paged")).toBeUndefined();
  });
});
