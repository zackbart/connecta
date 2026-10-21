import { InMemoryTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import type { CallToolResult, JSONRPCMessage, Tool, Transport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { createMetaTools } from "../src/meta-tools.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import { required, makeRegistry, silentLogger } from "./helpers.js";
import { connectorContext as ctx, deferred, spyLogger } from "./fixtures/misc.js";

const BASE = "https://connecta.test";

/**
 * A cursor that is hostile to anything that treats cursors as anything but an
 * opaque token: it looks like base64, carries query syntax, a slash, a
 * backslash, and a raw space. If the connector parsed, re-encoded, trimmed, or
 * URL-mangled it, the fixture server would not recognize it and the refresh
 * would fail loudly.
 */
const OPAQUE_CURSOR = "eyJwIjoyfQ==?page=2&next=/a\\b c%20";

/**
 * The MCP spec ends pagination on an ABSENT `nextCursor`. An empty string is
 * present, so a page advertising `""` still has a successor.
 */
const EMPTY_CURSOR = "";

/**
 * The tool ceiling `src/connectors/remote-mcp.ts` enforces, restated here so
 * moving it has to come past these tests on purpose: it is what a refresh
 * holds in memory.
 */
const MAX_TOOLS = 100_000;
// The walk to that ceiling is 100,001 tools: CPU-bound, with no timing
// behavior, and on a loaded host it outran vitest's 5s default. Its budget is
// a hang guard, not a speed assertion.
const CEILING_WALK_TIMEOUT_MS = 30_000;

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
  listTools: (cursor: string | undefined, call: number) => PageResult | Promise<PageResult>,
  opts: {
    /** Return an Error to fail an outbound message instead of delivering it. */
    sendFault?: (message: JSONRPCMessage) => Error | undefined;
    /** Downstream `tools/call` behaviour; defaults to echoing the tool name. */
    callTool?: (name: string) => CallToolResult;
    id?: string;
    oauth?: boolean;
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
      ...(opts.oauth ? { auth: { type: "oauth" as const } } : {}),
      _transportFactory: () => {
        builds++;
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const server = new Server({ name: "paged-downstream", version: "1.0.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler("tools/list", async (request) => {
          const cursor = request.params?.cursor;
          cursors.push(cursor);
          return listTools(cursor, cursors.length);
        });
        server.setRequestHandler("tools/call", async (request) =>
          opts.callTool
            ? opts.callTool(request.params.name)
            : {
                content: [{ type: "text" as const, text: `ran:${request.params.name}` }],
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
        if (!opts.sendFault) return clientTransport;
        // Faults are injected on the wire, not in the downstream handler: a
        // page request that never lands is the failure mode this cares about,
        // and it keeps the fixture server from rejecting a request it already
        // accepted.
        const tapped: Transport = {
          start: () => clientTransport.start(),
          async send(message, sendOpts) {
            const fault = opts.sendFault?.(message);
            if (fault) throw fault;
            return clientTransport.send(
              message,
              sendOpts?.relatedRequestId !== undefined ? { relatedRequestId: sendOpts.relatedRequestId } : undefined,
            );
          },
          close: () => clientTransport.close(),
        };
        for (const key of ["onclose", "onerror", "onmessage"] as const) {
          Object.defineProperty(tapped, key, {
            get: () => clientTransport[key],
            set: (value) => {
              clientTransport[key] = value as never;
            },
          });
        }
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
      tools: required(page).tools,
      ...(required(page).nextCursor !== undefined ? { nextCursor: required(page).nextCursor } : {}),
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
    expect(required(gamma).description).toBe("Only reachable on the last page");
    expect((required(gamma).inputSchema as any).properties.text.type).toBe("string");
    expect((required(gamma).outputSchema as any).properties.ran.type).toBe("string");
    expect(required(gamma).annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      title: "Gamma",
    });
  });

  it("stops paging when the scope ends mid-chain instead of running on detached", async () => {
    const { promise: atPageTwo, resolve: reachedPageTwo } = deferred<void>();
    const { promise: gate, resolve: releasePageTwo } = deferred<void>();
    const { connector, cursors } = fixture(async (_cursor, call) => {
      if (call === 1) return { tools: [tool("alpha")], nextCursor: "p2" };
      reachedPageTwo();
      await gate;
      return { tools: [tool("beta")], nextCursor: "p3" };
    });
    const context = { ...ctx(), requestScope: {} };

    const pending = connector.listTools(context).then(
      () => null,
      (err: unknown) => err,
    );
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
    expect(required(tools[1]).description).toBe("first");

    const searched = await createMetaTools(makeRegistry([connector]), BASE).searchTools({});
    expect(JSON.parse(required(searched.content[0]).text).tools).toHaveLength(3);
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

    await expect(connector.listTools(ctx())).rejects.toThrow(/not advancing/);
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

  it(
    "stops a walk that would accumulate more tools than a refresh will hold",
    async () => {
      const flood = Array.from({ length: MAX_TOOLS + 1 }, (_, i) => tool(`t${i}`, { description: undefined }));
      const { connector, cursors } = fixture(() => ({
        tools: flood,
        nextCursor: "more",
      }));

      await expect(connector.listTools(ctx())).rejects.toThrow(/complete-catalog ceiling/);
      // The bound is on what the walk accumulates, so it fires before the second
      // request rather than after some number of pages.
      expect(cursors).toEqual([undefined]);
    },
    CEILING_WALK_TIMEOUT_MS,
  );

  it("collects a final page whose cursor is null", async () => {
    const { connector, cursors } = fixture((cursor) =>
      cursor === undefined
        ? { tools: [tool("alpha")], nextCursor: "p2" }
        : {
            tools: [tool("beta")],
            nextCursor: null as unknown as string,
          },
    );

    const tools = await connector.listTools(ctx());

    expect(tools.map((t) => t.name)).toEqual(["alpha", "beta"]);
    expect(cursors).toEqual([undefined, "p2"]);
  });

  it("names a non-string, non-null cursor as a nonconformance", async () => {
    const { connector } = fixture(() => ({
      tools: [tool("alpha")],
      nextCursor: 42 as unknown as string,
    }));

    await expect(connector.listTools(ctx())).rejects.toThrow(/nextCursor must be a string, null, or absent/);
  });
});

describe("tool metadata across a paginated catalog", () => {
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
    await expect(connector.callTool("late", {}, context)).rejects.toThrow(/output schema/i);
    // This is the one that matters. Without re-priming the client from the
    // full walked catalog, `early` has no cached validator and the same bad
    // payload sails straight through — enforcement would depend on which page
    // a tool happened to land on, which is not enforcement.
    await expect(connector.callTool("early", {}, context)).rejects.toThrow(/output schema/i);
  });
});

describe("paginated catalogs through the discovery path", () => {

  it("INV-8: never exposes a partial catalog or stale fallback when a later page fails", async () => {
    let breakLaterPages = false;
    const { connector } = fixture(threePages(), {
      sendFault: (message) =>
        breakLaterPages && isLaterPageRequest(message) ? new Error("page two never landed") : undefined,
    });
    const { logger, warnings } = spyLogger();
    const registry = new Registry([connector], {
      storage: memoryStorage(),
      logger,
      // Expire immediately so the next read must attempt a live refresh, while
      // the stale window stays wide open.
      toolCacheTtlSeconds: 0,
    });
    const scope = {};

    const complete = await registry.getTools("paged", BASE, scope);
    expect(complete.map((t) => t.name)).toEqual(["alpha", "beta", "gamma"]);

    breakLaterPages = true;
    await expect(registry.getTools("paged", BASE, scope)).rejects.toThrow(/tools\/list.*failed/);
    expect(warnings().some((w) => /page two never landed/.test(w))).toBe(false);

    await connector.closeScope!({ ...ctx(), requestScope: scope });
  });

  it("INV-8: fails when a deadline cuts a refresh short", async () => {
    let stall = false;
    const { promise: atPageTwo, resolve: reachedPageTwo } = deferred<void>();
    const { promise: gate, resolve: releasePageTwo } = deferred<void>();
    const { connector, cursors } = fixture(async (cursor) => {
      if (cursor === undefined) {
        return { tools: [tool("alpha")], nextCursor: "p2" };
      }
      if (stall) {
        reachedPageTwo();
        await gate;
        return { tools: [tool("replacement")], nextCursor: "p3" };
      }
      return { tools: [tool("beta")] };
    });
    const { logger, warnings } = spyLogger();
    const registry = new Registry([connector], {
      storage: memoryStorage(),
      logger,
      toolCacheTtlSeconds: 0,
    });
    const firstScope = {};
    const secondScope = {};

    const complete = await registry.getTools("paged", BASE, firstScope);
    expect(complete.map((t) => t.name)).toEqual(["alpha", "beta"]);

    stall = true;
    const controller = new AbortController();
    const pending = registry.getTools("paged", BASE, secondScope, {
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    await atPageTwo;
    controller.abort(new Error('catalog probe of "paged" timed out'));
    try {
      await expect(pending).rejects.toThrow(/timed out/);
      expect(cursors).toEqual([undefined, "p2", undefined, "p2"]);
      expect(warnings().some((w) => /serving stale/.test(w))).toBe(false);
    } finally {
      releasePageTwo();
      await connector.closeScope!({
        ...ctx(),
        requestScope: firstScope,
      });
      await connector.closeScope!({
        ...ctx(),
        requestScope: secondScope,
      });
    }
  });

  it("reports a later-page authorization failure with a route to its URL", async () => {
    const authUrl = "https://auth.example/authorize?client_id=paged";
    const storage = memoryStorage();
    await storage.set("conn:paged:oauth:pending", authUrl);
    const { connector } = fixture(threePages(), {
      oauth: true,
      sendFault: (message) =>
        isLaterPageRequest(message) ? new UnauthorizedError("downstream token expired") : undefined,
    });
    const registry = new Registry([connector], {
      storage,
      logger: silentLogger,
    });

    // The failed walk is typed as an authorization failure and caches nothing.
    await expect(registry.getTools("paged", BASE, {})).rejects.toMatchObject({
      code: "downstream_oauth_required",
    });

    // An agent meets it as a call failure carrying the route to the URL: the
    // catalog is unreachable, so the recovery is authorize_connector, and that
    // is what hands back the address an operator has to open.
    const mt = createMetaTools(registry, BASE, {
      canManageAuth: () => true,
      oauthConnectUrl: async (id) => `${BASE}/connect/${id}?h=test`,
    });
    const called = JSON.parse(
      required((await mt.callTool({ address: "paged.gamma", resultMode: "value" })).content[0]).text,
    ) as {
      error: { code: string; nextAction?: { tool?: string } };
    };
    expect(called.error.code).toBe("downstream_oauth_required");
    expect(called.error.nextAction?.tool).toBe("authorize_connector");
    const authorized = JSON.parse(required((await mt.authorizeConnector({ connector: "paged" })).content[0]).text) as {
      authorizationUrl?: string;
    };
    expect(authorized.authorizationUrl).toBe(`${BASE}/connect/paged?h=test`);
  });

  it("surfaces a non-terminating downstream as a connector error, not a truncated catalog", async () => {
    const { connector, cursors } = fixture((_cursor, call) => ({
      tools: [tool(`t${call}`)],
      nextCursor: "same",
    }));
    const registry = makeRegistry([connector]);

    await expect(registry.getTools("paged", BASE, {})).rejects.toThrow(/pagination chain loops/);
    // A truncated catalog is worse than none: nothing is cached for the next
    // reader to mistake for the connector's real tool list.
    await expect(registry.getTools("paged", BASE, {})).rejects.toThrow(/pagination chain loops/);
    expect(cursors).toEqual([undefined, "same", undefined, "same"]);
  });
});
