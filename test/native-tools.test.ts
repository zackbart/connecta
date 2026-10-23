// A pool with `surface: "native"` lists each downstream tool directly for
// clients that run their own tool search, and runs each call through the same
// call_tool / call_destructive_tool path. The six-tool surface stays the
// default; its own suites cover it unchanged.

import { describe, expect, it } from "vitest";
import { activityHistory, type ToolCallActivityEvent } from "../src/activity.js";
import { accessTokens } from "../src/access-tokens.js";
import { api } from "../src/connectors/api.js";
import { NATIVE_NAME_MAX, nativeToolName } from "../src/native-tools.js";
import { CONNECTA_INSTRUCTIONS, nativeInstructions } from "../src/skills.js";
import type { JsonSchema } from "../src/types.js";
import { memoryStorage } from "../src/storage/memory.js";
import { readJsonRpc } from "./fixtures/http.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { issueAgentToken } from "./helpers/agent-tokens.js";

const BASE = "https://connecta.test";

function deployment(options: { classification?: Record<string, Record<string, "read" | "write">> } = {}) {
  const storage = memoryStorage();
  const sent: string[] = [];
  const events: ToolCallActivityEvent[] = [];
  const crm = api("crm", {
    description: "CRM",
    tools: [
      {
        name: "get_person",
        description: "Get a person by id",
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        handler: async (args: { id: string }) => {
          sent.push("get_person");
          return { id: args.id, name: "Alice" };
        },
      },
      {
        name: "create_person",
        description: "Create a person",
        annotations: { readOnlyHint: false, destructiveHint: false },
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        handler: async (args: { name: string }) => {
          sent.push("create_person");
          return { id: "p2", name: args.name };
        },
      },
      {
        name: "export.all",
        description: "Export everything",
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object" },
        handler: async () => {
          sent.push("export");
          return "x".repeat(60_000);
        },
      },
    ],
  });
  const member = { tools: ["crm"], members: ["agent:assistant"] };
  return {
    storage,
    sent,
    events,
    connecta: createTestConnecta({
      connectors: [crm],
      activity: activityHistory({
        store: {
          record: async (event) => {
            events.push(event);
          },
        },
      }),
      agents: ["assistant"],
      pools: {
        meta: member,
        native: { ...member, surface: "native", description: "Team tier." },
        nocode: { ...member, surface: "native", executeCode: false },
        other: { ...member, surface: "native", executeCode: false },
        reads: { ...member, surface: "native", readOnly: true },
      },
      ...(options.classification ? { classification: options.classification } : {}),
      publicUrl: BASE,
      logger: silentLogger,
      storage,
      accessTokens: accessTokens(storage),
    }),
  };
}

type Fetcher = { fetch(request: Request): Promise<Response> };

/** One JSON-RPC exchange, as a modern (2026-07-28) or legacy client sends it. */
async function rpc(c: Fetcher, token: string, pool: string, method: string, params: object, modern = true) {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  });
  let body: Record<string, unknown> = { jsonrpc: "2.0", id: 1, method, params };
  if (modern) {
    headers.set("MCP-Protocol-Version", "2026-07-28");
    headers.set("Mcp-Method", method);
    const name = (params as { name?: unknown }).name;
    if (typeof name === "string") headers.set("Mcp-Name", name);
    body = {
      ...body,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    };
  }
  return readJsonRpc(
    await c.fetch(new Request(`${BASE}/agent/${pool}`, { method: "POST", headers, body: JSON.stringify(body) })),
  );
}

async function admitted() {
  const deployed = deployment();
  return { ...deployed, token: await issueAgentToken(deployed.storage, "assistant") };
}

function envelope(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

describe("native tool surface", () => {
  it("lists each pool tool as <connector>__<tool> with annotations from its classification", async () => {
    const { connecta, token } = await admitted();
    for (const modern of [true, false]) {
      const listed = await rpc(connecta, token, "native", "tools/list", {}, modern);
      const tools = listed.result.tools as Array<Record<string, any>>;
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [
          "crm__create_person",
          "crm__get_person",
          await nativeToolName("crm", "export.all"),
          "execute_code",
          "skills",
        ].sort(),
      );
      const read = tools.find((tool) => tool.name === "crm__get_person")!;
      expect(read.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
      expect(read.inputSchema).toEqual({ type: "object", properties: { id: { type: "string" } }, required: ["id"] });
      expect(read.description).toBe("Get a person by id\n\nProgram address: crm.get_person");
      expect(read._meta).toEqual({ "dev.connecta/address": "crm.get_person" });
      expect(read.outputSchema).toBeUndefined();
      // A downstream that says "not destructive" is still a write here: the verdict is binary.
      expect(tools.find((tool) => tool.name === "crm__create_person")!.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      });
      if (modern) expect(listed.result).toMatchObject({ ttlMs: 300_000, cacheScope: "private" });
    }
    // The meta pool on the same deployment keeps its six tools.
    const meta = await rpc(connecta, token, "meta", "tools/list", {});
    expect(meta.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(
      ["authorize_connector", "call_destructive_tool", "call_tool", "execute_code", "search_tools", "skills"].sort(),
    );
    expect(meta.result.ttlMs).toBe(3_600_000);
  });

  it("INV-1: annotates a tool the deployment reclassifies as a write as destructive", async () => {
    const deployed = deployment({ classification: { crm: { get_person: "write" } } });
    const token = await issueAgentToken(deployed.storage, "assistant");
    const listed = await rpc(deployed.connecta, token, "native", "tools/list", {});
    const tool = listed.result.tools.find((entry: { name: string }) => entry.name === "crm__get_person");
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    // And the call takes the write route: it runs once, as call_destructive_tool would.
    const called = await rpc(deployed.connecta, token, "native", "tools/call", {
      name: "crm__get_person",
      arguments: { id: "p1" },
    });
    expect(called.result.isError).toBeUndefined();
    expect(deployed.sent).toEqual(["get_person"]);
  });

  it("INV-2: runs reads and writes through the existing call paths and their result shapes", async () => {
    const { connecta, token, sent, events } = await admitted();
    for (const modern of [true, false]) {
      const read = await rpc(
        connecta,
        token,
        "native",
        "tools/call",
        { name: "crm__get_person", arguments: { id: "p1" } },
        modern,
      );
      expect(read.result.content).toEqual([{ type: "text", text: '{"id":"p1","name":"Alice"}' }]);
      expect(read.result._meta).toMatchObject({ "dev.connecta/format": "json" });
      expect(read.result.structuredContent).toBeUndefined();
      const write = await rpc(
        connecta,
        token,
        "native",
        "tools/call",
        { name: "crm__create_person", arguments: { name: "Bob" } },
        modern,
      );
      expect(write.result.content).toEqual([{ type: "text", text: '{"id":"p2","name":"Bob"}' }]);
    }
    expect(sent).toEqual(["get_person", "create_person", "get_person", "create_person"]);
    expect(events.map((event) => [event.source, event.address, event.classification])).toEqual([
      ["native", "crm.get_person", "read"],
      ["native", "crm.create_person", "write"],
      ["native", "crm.get_person", "read"],
      ["native", "crm.create_person", "write"],
    ]);
  });

  it("INV-2: a read-only native pool omits write tools and refuses a write call before dispatch", async () => {
    const { connecta, token, sent } = await admitted();
    const listed = await rpc(connecta, token, "reads", "tools/list", {});
    const names = listed.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).not.toContain("crm__create_person");
    expect(names).toContain("crm__get_person");
    expect(
      listed.result.tools.find((tool: { name: string }) => tool.name === "execute_code").annotations,
    ).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const refused = await rpc(connecta, token, "reads", "tools/call", {
      name: "crm__create_person",
      arguments: { name: "Bob" },
    });
    expect(refused.result.isError).toBe(true);
    expect(envelope(refused.result).error).toMatchObject({ code: "read_only_endpoint", retryable: false });
    expect(sent).toEqual([]);
  });

  it("INV-1 INV-2 INV-9: routes a changed verdict as a write and never repeats an unknown outcome", async () => {
    for (const modern of [true, false]) {
      const storage = memoryStorage();
      let write = false;
      let calls = 0;
      const app = createTestConnecta({
        connectors: [
          {
            id: "crm",
            listTools: async () => [
              { name: "get", inputSchema: { type: "object" }, annotations: { readOnlyHint: !write } },
            ],
            callTool: async () => {
              calls++;
              throw new Error("PRIVATE_FAILURE");
            },
          },
        ],
        agents: ["assistant"],
        pools: {
          native: { tools: ["crm"], members: ["agent:assistant"], surface: "native" },
          reads: { tools: ["crm"], members: ["agent:assistant"], surface: "native", readOnly: true },
        },
        storage,
        accessTokens: accessTokens(storage),
        logger: silentLogger,
      });
      try {
        const token = await issueAgentToken(storage, "assistant");
        const listing = await rpc(app, token, "native", "tools/list", {}, modern);
        expect(
          listing.result.tools.find((tool: { name: string }) => tool.name === "crm__get").annotations.readOnlyHint,
        ).toBe(true);
        write = true;
        const result = await rpc(app, token, "native", "tools/call", { name: "crm__get", arguments: {} }, modern);
        expect(envelope(result.result).error).toMatchObject({ retryable: false, writeOutcome: "unknown" });

        const refused = await rpc(app, token, "reads", "tools/call", { name: "crm__get", arguments: {} }, modern);
        expect(envelope(refused.result).error.code).toBe("read_only_endpoint");
        expect(calls).toBe(1);
      } finally {
        await app.close();
      }
    }
  });

  it("returns invocation's own envelopes for invalid arguments and unknown tools", async () => {
    const { connecta, token, sent } = await admitted();
    for (const pool of ["native", "nocode"]) {
      const invalid = await rpc(connecta, token, pool, "tools/call", { name: "crm__get_person", arguments: {} });
      expect(invalid.result.isError).toBe(true);
      expect(envelope(invalid.result).error).toMatchObject({
        code: "invalid_args",
        validation: { issues: [{ path: "/id", code: "required" }] },
      });
      for (const modern of [true, false]) {
        for (const name of ["crm__nope", "crm__wrong__get_person", "crm__export_all", "crm__export.all"]) {
          const unknown = await rpc(connecta, token, "native", "tools/call", { name, arguments: { id: "p1" } }, modern);
          // Illegal names are rejected by the SDK; legal misses are bounded tool failures.
          expect(unknown.error || unknown.result.isError).toBeTruthy();
          if (unknown.result)
            expect(envelope(unknown.result).error).toMatchObject({ code: "unknown_tool", retryable: false });
        }
      }
      expect(JSON.stringify(invalid.result)).not.toMatch(
        /search_tools|call_tool|call_destructive_tool|authorize_connector/,
      );
      expect(envelope(invalid.result).error.nextAction).toMatchObject({ host: "search" });
    }
    expect(sent).toEqual([]);
  });

  it("without execute_code, lists read_result and pages a truncated result through it", async () => {
    const { connecta, token } = await admitted();
    const listed = await rpc(connecta, token, "nocode", "tools/list", {});
    const names = listed.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("read_result");
    expect(names).not.toContain("execute_code");
    const big = await rpc(connecta, token, "nocode", "tools/call", {
      name: await nativeToolName("crm", "export.all"),
      arguments: {},
    });
    const text = big.result.content[0].text as string;
    const notice = JSON.parse(text.slice(0, text.indexOf("\n")));
    expect(notice).toMatchObject({ truncated: true, totalBytes: 60_002, nextOffset: 24_000 });
    expect(notice.nextAction).toEqual({ tool: "read_result", arguments: { id: notice.resultId, offset: 24_000 } });
    expect(notice.hint).not.toContain("execute_code");
    const page = await rpc(connecta, token, "nocode", "tools/call", {
      name: "read_result",
      arguments: notice.nextAction.arguments,
    });
    expect(page.result.structuredContent).toMatchObject({ offset: 24_000, bytes: 24_000, hasMore: true });
    const denied = await rpc(connecta, token, "other", "tools/call", {
      name: "read_result",
      arguments: notice.nextAction.arguments,
    });
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0].text).toContain("Unknown or expired result id");
  });

  it("serves the native instructions, with the pool description, in place of the meta routing text", async () => {
    const { connecta, token } = await admitted();
    const initialize = {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "native-test", version: "0" },
    };
    const native = await rpc(connecta, token, "native", "initialize", initialize, false);
    expect(native.result.instructions).toBe(`${nativeInstructions(true)} This endpoint: Team tier.`);
    const nocode = await rpc(connecta, token, "nocode", "initialize", initialize, false);
    expect(nocode.result.instructions).toBe(nativeInstructions(false));
    const meta = await rpc(connecta, token, "meta", "initialize", initialize, false);
    expect(meta.result.instructions).toBe(CONNECTA_INSTRUCTIONS);
  });

  it("refuses a pool over the 1,000-tool native cap with a JSON-RPC error", async () => {
    const storage = memoryStorage();
    const connecta = createTestConnecta({
      connectors: [
        api("bulk", {
          description: "Bulk",
          tools: Array.from({ length: 1_001 }, (_, index) => ({
            name: `read_${index}`,
            description: `Read item ${index}`,
            annotations: { readOnlyHint: true },
            inputSchema: { type: "object" as const },
            handler: async () => ({}),
          })),
        }),
      ],
      agents: ["assistant"],
      pools: { bulk: { tools: ["bulk"], members: ["agent:assistant"], surface: "native" } },
      logger: silentLogger,
      storage,
      accessTokens: accessTokens(storage),
    });
    const listed = await rpc(connecta, await issueAgentToken(storage, "assistant"), "bulk", "tools/list", {});
    expect(listed.error.message).toContain("over the 1000-tool native listing cap");
  });

  it("INV-2: resolves truncated connector prefixes and refuses every colliding read or write claimant", async () => {
    const longId = `a__${"b".repeat(50)}`;
    const name = await nativeToolName(longId, "get");
    for (const write of [false, true]) {
      for (const collision of [false, true]) {
        const storage = memoryStorage();
        const sent: string[] = [];
        const connectors = [longId, "a"].map((id) =>
          api(id, {
            description: "Fixture",
            tools: [
              {
                name: id === longId ? "get" : collision ? name.slice(3) : "other",
                description: "Read fixture",
                annotations: { readOnlyHint: id === longId || !write },
                inputSchema: { type: "object" },
                handler: async () => {
                  sent.push(id);
                  return {};
                },
              },
            ],
          }),
        );
        const member = { tools: [longId, "a"], members: ["agent:assistant"], surface: "native" as const };
        const app = createTestConnecta({
          connectors,
          agents: ["assistant"],
          pools: {
            native: member,
            reads: { ...member, readOnly: true },
          },
          storage,
          accessTokens: accessTokens(storage),
          logger: silentLogger,
        });
        const token = await issueAgentToken(storage, "assistant");
        try {
          for (const pool of ["native", "reads"]) {
            const listed = await rpc(app, token, pool, "tools/list", {});
            expect(listed.result.tools.some((tool: { name: string }) => tool.name === name)).toBe(!collision);
            const called = await rpc(app, token, pool, "tools/call", { name, arguments: {} });
            expect(called.result.isError === true).toBe(collision);
          }
          expect(sent).toEqual(collision ? [] : [longId, longId]);
        } finally {
          await app.close();
        }
      }
    }
  });

  it("preserves object constraints, local references and compositions, and refuses non-object schemas", async () => {
    const object: JsonSchema = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    };
    for (const schema of [
      object,
      { properties: object.properties, required: object.required },
      { $ref: "#/$defs/Args", $defs: { Args: object } },
      { allOf: [object, { minProperties: 1 }] },
      { anyOf: [object, { type: "object", properties: { count: { type: "number" } } }] },
      { type: "string" },
      { type: "array", items: { type: "string" } },
      { $ref: "#/missing" },
    ]) {
      const storage = memoryStorage();
      const sent: string[] = [];
      const connector = {
        id: "crm",
        kind: "mcp" as const,
        listTools: async () => [{ name: "get", inputSchema: schema, annotations: { readOnlyHint: true } }],
        callTool: async () => {
          sent.push("get");
          return {};
        },
      };
      const app = createTestConnecta({
        connectors: [connector],
        agents: ["assistant"],
        pools: {
          native: { tools: ["crm"], members: ["agent:assistant"], surface: "native" },
        },
        storage,
        accessTokens: accessTokens(storage),
        logger: silentLogger,
      });
      try {
        const token = await issueAgentToken(storage, "assistant");
        const listing = await rpc(app, token, "native", "tools/list", {});
        if (schema.type === "string" || schema.type === "array" || schema.$ref === "#/missing") {
          expect(listing.error.message).toContain("cannot be represented");
        } else {
          const advertised = listing.result.tools.find(
            (tool: { name: string }) => tool.name === "crm__get",
          ).inputSchema;
          expect(advertised).toEqual({ ...schema, type: "object" });
          if (schema === object) expect(JSON.stringify(advertised)).toBe(JSON.stringify(object));
          if (schema !== object && !schema.anyOf) {
            const invalid = await rpc(app, token, "native", "tools/call", { name: "crm__get", arguments: {} });
            expect(envelope(invalid.result).error.code).toBe("invalid_args");
          }
        }
        expect(sent).toEqual([]);
      } finally {
        await app.close();
      }
    }
  });

  it("INV-11: refuses executeCode without the native surface, and an unknown surface", { tags: ["node"] }, () => {
    const storage = memoryStorage();
    const make = (pool: Record<string, unknown>) => () =>
      createTestConnecta({
        connectors: [api("crm", { description: "CRM", tools: [] })],
        agents: ["assistant"],
        pools: { x: { tools: ["crm"], members: ["agent:assistant"], ...pool } as never },
        storage,
        accessTokens: accessTokens(storage),
        logger: silentLogger,
      });
    expect(make({ executeCode: false })).toThrow('ConnectaConfig.pools.x.executeCode needs surface: "native"');
    expect(make({ surface: "both" })).toThrow('ConnectaConfig.pools.x.surface must be "meta" or "native".');
    expect(make({ surface: "native", executeCode: false })).not.toThrow();
  });
});

describe("native tool names", () => {
  it("are <connector>__<tool> when exact, and a stable hashed head otherwise", { tags: ["node"] }, async () => {
    expect(await nativeToolName("crm", "get_person")).toBe("crm__get_person");
    expect(await nativeToolName("crm", "get-person2")).toBe("crm__get-person2");
    // Lossy, a nested separator, a leading underscore, or overlong: head + six hex.
    for (const [connector, tool] of [
      ["crm", "export.all"],
      ["crm", "a__b"],
      ["crm", "_private"],
      ["crm", "x".repeat(60)],
    ] as const) {
      const name = await nativeToolName(connector, tool);
      expect(name).toMatch(/^crm__.*_[0-9a-f]{6}$/);
      expect(name.length).toBeLessThanOrEqual(NATIVE_NAME_MAX);
      expect(await nativeToolName(connector, tool)).toBe(name);
    }
    expect(await nativeToolName("crm", "export.all")).not.toBe(await nativeToolName("crm", "export_all"));
    // A connector id that does not start with a letter gets an uppercase prefix no id can contain.
    expect(await nativeToolName("1pass", "get")).toBe("C1pass__get");
    for (const name of [await nativeToolName("1pass", "get"), await nativeToolName("crm", "é")]) {
      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
    }
  });
});
