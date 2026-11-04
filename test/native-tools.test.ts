// A pool with `surface: "native"` lists each downstream tool directly for
// clients that run their own tool search, and runs each call through the same
// call_tool / call_destructive_tool path. The six-tool surface stays the
// default; its own suites cover it unchanged.

import { gmail } from "../src/providers/gmail/index.js";
import { docs } from "../src/providers/docs/index.js";
import { PRIVATE_KEY } from "./fixtures/rsa.js";
import { describe, expect, it } from "vitest";
import { activityHistory, type ToolCallActivityEvent } from "../src/activity.js";
import { accessTokens } from "../src/access-tokens.js";
import { api } from "../src/connectors/api.js";
import { ConnectorCallError } from "../src/errors.js";
import { nativeRecovery } from "../src/native-recovery.js";
import { NATIVE_NAME_MAX, nativeToolName } from "../src/native-tools.js";
import { CONNECTA_INSTRUCTIONS, nativeInstructions } from "../src/skills.js";
import type { JsonSchema } from "../src/types.js";
import { memoryStorage } from "../src/storage/memory.js";
import { fakeClerkAuth, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { renderRoutesAsPrograms, routeDescription } from "../src/agent-routes.js";
import { createConnecta, customExecutor } from "../src/index.js";
import type { Connector } from "../src/types.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { issueAgentToken } from "./helpers/agent-tokens.js";

const BASE = "https://connecta.test";

const APPROVAL_LINK = "Request apr_7Hq2: https://vendor.example/approve/apr_7Hq2?sig=c0ffee";

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
  const vendor: Connector = {
    id: "vendor",
    kind: "mcp",
    description: "A hosted tool that answers with its own errors",
    async listTools() {
      return [
        { name: "pay", annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: "object" } },
      ];
    },
    async callTool() {
      sent.push("pay");
      return {
        isError: true,
        content: [{ type: "text", text: `${"Approval required. ".repeat(60)}${APPROVAL_LINK}` }],
      };
    },
  };
  const member = { tools: ["crm"], members: ["agent:assistant"] };
  return {
    storage,
    sent,
    events,
    connecta: createTestConnecta({
      connectors: [crm, vendor],
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
        hosted: { tools: ["vendor"], members: member.members, surface: "native", executeCode: false },
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
  it("routes people to native pools without execute_code and records the admitted pool", async () => {
    const events: ToolCallActivityEvent[] = [];
    const c = createTestConnecta({
      connectors: [
        api("notes", {
          tools: [
            {
              name: "read",
              description: "Read notes",
              annotations: { readOnlyHint: true },
              handler: () => ({ ok: true }),
            },
          ],
        }),
      ],
      auth: fakeClerkAuth({ token: "bob", userId: "bob" }),
      maintainers: ["alice"],
      pools: {
        team: { tools: ["notes"], members: ["bob"], surface: "native", executeCode: false, description: "Team notes" },
      },
      activity: activityHistory({
        store: {
          record: async (event) => {
            events.push(event);
          },
        },
      }),
      logger: silentLogger,
    });
    const send = async (path: string, method: string, params: object) =>
      readJsonRpc(
        await c.fetch(
          new Request(`${BASE}${path}`, {
            method: "POST",
            headers: {
              Authorization: "Bearer bob",
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          }),
        ),
      );
    const listed = await send("/mcp", "tools/list", {});
    expect(listed).toEqual(await send("/mcp/team", "tools/list", {}));
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toContain("notes__read");
    expect(listed.result.tools.map((t: { name: string }) => t.name)).not.toContain("execute_code");
    for (const path of ["/mcp", "/mcp/team"]) {
      expect((await send(path, "tools/call", { name: "notes__read", arguments: {} })).result.isError).toBeFalsy();
    }
    expect(events.filter((e) => e.pool === "team")).toHaveLength(2);
    await c.close();
  });

  it("lists reads as <connector>__<tool> and writes as <connector>__WRITE__<tool>, annotated from their classification", async () => {
    const { connecta, token } = await admitted();
    for (const modern of [true, false]) {
      const listed = await rpc(connecta, token, "native", "tools/list", {}, modern);
      const tools = listed.result.tools as Array<Record<string, any>>;
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [
          "crm__WRITE__create_person",
          "crm__get_person",
          await nativeToolName("crm", "export.all", "read"),
          "execute_code",
          "authorize_connector",
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
      expect(tools.find((tool) => tool.name === "crm__WRITE__create_person")!.annotations).toEqual({
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

  it("points guided native tools at the serving skills route with bounded overhead", async () => {
    const storage = memoryStorage();
    const app = createTestConnecta({
      storage,
      accessTokens: accessTokens(storage),
      agents: ["assistant"],
      connectors: [
        {
          id: "crm",
          usageGuide: "Use stable person ids.",
          listTools: async () => [{ name: "read", description: "Read person", annotations: { readOnlyHint: true } }],
          callTool: async () => ({}),
        },
      ],
      pools: {
        native: { tools: ["crm"], members: ["agent:assistant"], surface: "native", executeCode: true },
        nocode: { tools: ["crm"], members: ["agent:assistant"], surface: "native", executeCode: false },
      },
    });
    try {
      const token = await issueAgentToken(storage, "assistant");
      for (const pool of ["native", "nocode"]) {
        const listed = await rpc(app, token, pool, "tools/list", {});
        const description = listed.result.tools.find((t: { name: string }) => t.name === "crm__read").description;
        expect(description).toContain("Guide: skills crm");
        expect(description.split("Guide: ")[1].length).toBeLessThan(64);
        expect(description).not.toContain("search_tools");
      }
    } finally {
      await app.close();
    }
  });

  it("uses allocated readable guide names, including collisions, with measured 200-tool overhead", async () => {
    const { resolvedConnectorGuides } = await import("../src/skills.js");
    const connector = (id: string, guided = true): Connector => ({
      id,
      ...(guided ? { usageGuide: "Use stable ids." } : {}),
      listTools: async () =>
        Array.from({ length: id === "crm" ? 200 : 1 }, (_, i) => ({
          name: `read${i}`,
          description: "Read",
          annotations: { readOnlyHint: true },
        })),
      callTool: async () => ({}),
    });
    const original = connector("notes_alice");
    const allocated = (await resolvedConnectorGuides([original]))[0]!.name;
    const connectors = [
      connector("crm"),
      original,
      connector(allocated),
      connector("long_".repeat(40)),
      connector("usage"),
      connector("plain", false),
    ];
    const expected = await resolvedConnectorGuides(connectors);
    expect(expected.find((g) => g.connector.id === original.id)!.name).toBe(`${allocated}-1`);
    const awaitName = new Map(
      await Promise.all(connectors.map(async (c) => [c.id, await nativeToolName(c.id, "read0", "read")] as const)),
    );
    const storage = memoryStorage();
    const app = createTestConnecta({
      storage,
      accessTokens: accessTokens(storage),
      agents: ["assistant"],
      connectors,
      pools: {
        native: {
          tools: connectors.map((c) => c.id),
          members: ["agent:assistant"],
          surface: "native",
          executeCode: false,
        },
      },
    });
    try {
      const token = await issueAgentToken(storage, "assistant");
      const listed = await rpc(app, token, "native", "tools/list", {});
      expect(await rpc(app, token, "native", "tools/list", {})).toEqual(listed);
      for (const { connector: c, reference: name } of expected) {
        const tool = listed.result.tools.find((t: { name: string }) => t.name === awaitName.get(c.id));
        expect(tool.description).toBe(`Read\n\nGuide: skills ${name}`);
        const fetched = await rpc(app, token, "native", "tools/call", { name: "skills", arguments: { name } });
        expect(fetched.result.isError).toBeFalsy();
      }
      const crm = listed.result.tools.filter((t: { name: string }) => t.name.startsWith("crm__"));
      const overhead = crm.map((t: { description: string }) => t.description.length - "Read".length);
      expect(overhead).toEqual(Array(200).fill(19));
      expect(overhead.reduce((a: number, b: number) => a + b, 0)).toBe(3800);
      expect(listed.result.tools.find((t: { name: string }) => t.name === "plain__read0").description).toBe("Read");
    } finally {
      await app.close();
    }
  });

  it("states connector restrictions for fully restricted and mixed admitted pools", async () => {
    for (const mixed of [false, true]) {
      const storage = memoryStorage();
      const app = createTestConnecta({
        storage,
        accessTokens: accessTokens(storage),
        agents: ["assistant"],
        connectors: [
          { id: "notes", readOnly: true, listTools: async () => [], callTool: async () => ({}) },
          { id: "crm", listTools: async () => [], callTool: async () => ({}) },
        ],
        pools: Object.fromEntries(
          ["meta", "native", "code"].map((name) => [
            name,
            {
              tools: mixed ? ["notes", "crm"] : ["notes"],
              members: ["agent:assistant"],
              ...(name === "meta" ? {} : { surface: "native" as const, executeCode: name === "code" }),
            },
          ]),
        ),
      });
      try {
        const token = await issueAgentToken(storage, "assistant");
        for (const pool of ["meta", "native", "code"]) {
          const init = await rpc(
            app,
            token,
            pool,
            "initialize",
            {
              protocolVersion: "2026-07-28",
              capabilities: {},
              clientInfo: { name: "test", version: "1" },
            },
            false,
          );
          const instructions = init.result.instructions;
          expect(instructions).toContain(mixed ? "subject to connector restrictions" : "can't perform writes");
          expect(instructions).not.toContain("notes.");
          expect(instructions).not.toContain("crm.");
          expect(
            (
              await rpc(
                app,
                token,
                pool,
                "initialize",
                {
                  protocolVersion: "2026-07-28",
                  capabilities: {},
                  clientInfo: { name: "test", version: "1" },
                },
                false,
              )
            ).result.instructions,
          ).toBe(instructions);
        }
      } finally {
        await app.close();
      }
    }
  });

  it("INV-1: annotates a tool the deployment reclassifies as a write as destructive", async () => {
    const deployed = deployment({ classification: { crm: { get_person: "write" } } });
    const token = await issueAgentToken(deployed.storage, "assistant");
    const listed = await rpc(deployed.connecta, token, "native", "tools/list", {});
    const tool = listed.result.tools.find((entry: { name: string }) => entry.name === "crm__WRITE__get_person");
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(listed.result.tools.some((entry: { name: string }) => entry.name === "crm__get_person")).toBe(false);
    // A write the deployment names by its read name is refused, and the refusal is recorded.
    const stale = await rpc(deployed.connecta, token, "native", "tools/call", {
      name: "crm__get_person",
      arguments: { id: "p1" },
    });
    expect(envelope(stale.result).error.code).toBe("destructive_tool_requires_approval");
    expect(deployed.sent).toEqual([]);
    expect(deployed.events.map((event) => [event.source, event.address, event.classification])).toEqual([
      ["native", "crm.get_person", "write"],
    ]);
    // And the call takes the write route: it runs once, as call_destructive_tool would.
    const called = await rpc(deployed.connecta, token, "native", "tools/call", {
      name: "crm__WRITE__get_person",
      arguments: { id: "p1" },
    });
    expect(called.result.isError).toBeUndefined();
    expect(deployed.sent).toEqual(["get_person"]);
  });

  describe("a host that replays read-annotated calls after a connection failure", () => {
    /** One call, then the replay a real host sends when the annotation it listed says read-only. */
    async function callAndMaybeReplay(
      app: Fetcher,
      token: string,
      pool: string,
      name: string,
      args: Record<string, unknown>,
    ) {
      const listed = await rpc(app, token, pool, "tools/list", {});
      const tool = listed.result.tools.find((entry: { name: string }) => entry.name === name);
      const send = () => rpc(app, token, pool, "tools/call", { name, arguments: args }, false);
      const first = await send();
      return tool.annotations.readOnlyHint === true ? await send() : first;
    }

    function overrideDeployment(annotations: Record<string, unknown> | undefined) {
      const storage = memoryStorage();
      const physical: unknown[] = [];
      const app = createTestConnecta({
        connectors: [
          {
            id: "crm",
            listTools: async () => [
              { name: "set_status", inputSchema: { type: "object" }, ...(annotations ? { annotations } : {}) },
            ],
            callTool: async (name: string, args: unknown) => {
              physical.push(args);
              return { name };
            },
          },
        ],
        classification: { crm: { set_status: "read" } },
        agents: ["assistant"],
        pools: {
          meta: { tools: ["crm"], members: ["agent:assistant"] },
          native: { tools: ["crm"], members: ["agent:assistant"], surface: "native", executeCode: false },
        },
        storage,
        accessTokens: accessTokens(storage),
        logger: silentLogger,
      });
      return { app, storage, physical };
    }

    it.each([
      ["readOnlyHint: false", { readOnlyHint: false }],
      ["destructiveHint: true", { destructiveHint: true }],
      ["contradictory hints", { readOnlyHint: true, destructiveHint: true }],
    ])("INV-1 INV-9: an overridden vendor write (%s) gets no duplicate physical write", async (_name, annotations) => {
      const { app, storage, physical } = overrideDeployment(annotations);
      try {
        const token = await issueAgentToken(storage, "assistant");
        const listed = await rpc(app, token, "native", "tools/list", {});
        const native = listed.result.tools.find((tool: { name: string }) => tool.name === "crm__WRITE__set_status");
        expect(native.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        await callAndMaybeReplay(app, token, "native", "crm__WRITE__set_status", { id: "A-1" });
        expect(physical).toEqual([{ id: "A-1" }]);
        // The read name the override used to serve is refused unsent, however often a host resends it.
        const stale = await rpc(app, token, "native", "tools/call", { name: "crm__set_status", arguments: {} }, false);
        expect(envelope(stale.result).error).toMatchObject({ code: "destructive_tool_requires_approval" });
        expect(physical).toHaveLength(1);

        // call_tool is annotated read-only, so the host may replay it; both attempts are refused unsent.
        const refused = await callAndMaybeReplay(app, token, "meta", "call_tool", {
          address: "crm.set_status",
          args: { id: "A-2" },
        });
        const error = envelope(refused.result).error;
        expect(error).toMatchObject({ code: "destructive_tool_requires_approval", retryable: false });
        expect(error.message).toContain("call_destructive_tool");
        expect(physical).toHaveLength(1);

        await callAndMaybeReplay(app, token, "meta", "call_destructive_tool", {
          address: "crm.set_status",
          args: { id: "A-3" },
        });
        expect(physical).toEqual([{ id: "A-1" }, { id: "A-3" }]);
      } finally {
        await app.close();
      }
    });

    it("INV-1: a vendor silent about a tool leaves the override as the only evidence, so it serves as a read", async () => {
      const { app, storage, physical } = overrideDeployment(undefined);
      try {
        const token = await issueAgentToken(storage, "assistant");
        const listed = await rpc(app, token, "native", "tools/list", {});
        const native = listed.result.tools.find((tool: { name: string }) => tool.name === "crm__set_status");
        expect(native.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        const direct = await rpc(
          app,
          token,
          "meta",
          "tools/call",
          { name: "call_tool", arguments: { address: "crm.set_status", args: { id: "A-1" } } },
          false,
        );
        expect(direct.result.isError).toBeUndefined();
        expect(physical).toEqual([{ id: "A-1" }]);
      } finally {
        await app.close();
      }
    });
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
        { name: "crm__WRITE__create_person", arguments: { name: "Bob" } },
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
    expect(names).not.toContain("crm__WRITE__create_person");
    expect(names).toContain("crm__get_person");
    expect(
      listed.result.tools.find((tool: { name: string }) => tool.name === "execute_code").annotations,
    ).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const refused = await rpc(connecta, token, "reads", "tools/call", {
      name: "crm__WRITE__create_person",
      arguments: { name: "Bob" },
    });
    expect(refused.result.isError).toBe(true);
    expect(envelope(refused.result).error).toMatchObject({ code: "read_only_endpoint", retryable: false });
    expect(sent).toEqual([]);
  });

  it("INV-1 INV-2 INV-9: refuses every replay of a cached read name once the tool is a write, and its write name runs once", async () => {
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
        // A host that cached the read may resend it after its transport closes, and each
        // replay is a fresh stateless request, so nothing can tell it from the original.
        for (const attempt of [0, 1, 2]) {
          const replay = await rpc(app, token, "native", "tools/call", { name: "crm__get", arguments: {} }, modern);
          expect(replay.result.isError, `attempt ${attempt}`).toBe(true);
          const { error } = envelope(replay.result);
          expect(error).toMatchObject({
            code: "destructive_tool_requires_approval",
            nextAction: { tool: "crm__WRITE__get" },
          });
          expect(error.message).toContain("nothing was sent");
          expect(error.nextAction.purpose).toContain("Refresh the host's tool list");
          expect(JSON.stringify(error)).not.toMatch(/call_destructive_tool|add a short reason/);
        }
        expect(calls).toBe(0);
        const refreshed = await rpc(app, token, "native", "tools/list", {}, modern);
        const names = refreshed.result.tools.map((tool: { name: string }) => tool.name);
        expect(names).toContain("crm__WRITE__get");
        expect(names).not.toContain("crm__get");
        expect(
          refreshed.result.tools.find((tool: { name: string }) => tool.name === "crm__WRITE__get").annotations,
        ).toMatchObject({ readOnlyHint: false, destructiveHint: true });

        const result = await rpc(
          app,
          token,
          "native",
          "tools/call",
          { name: "crm__WRITE__get", arguments: {} },
          modern,
        );
        expect(envelope(result.result).error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
        expect(calls).toBe(1);

        for (const name of ["crm__get", "crm__WRITE__get"]) {
          const refused = await rpc(app, token, "reads", "tools/call", { name, arguments: {} }, modern);
          expect(envelope(refused.result).error.code).toBe("read_only_endpoint");
        }
        expect(calls).toBe(1);

        // The other way a name goes stale: the host approved a write, and the tool is a read now.
        write = false;
        const relaxed = await rpc(app, token, "native", "tools/list", {}, modern);
        expect(relaxed.result.tools.map((tool: { name: string }) => tool.name)).toContain("crm__get");
        const approved = await rpc(
          app,
          token,
          "native",
          "tools/call",
          { name: "crm__WRITE__get", arguments: {} },
          modern,
        );
        expect(approved.result.isError).toBe(true);
        expect(calls).toBe(2);
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
        validation: { issues: [{ path: "/id", received: "missing" }] },
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
      // The findings name the fix, so nothing sends the agent off to search first.
      expect(envelope(invalid.result).error.validation).toMatchObject({
        issues: expect.any(Array),
        acceptedKeys: expect.any(Array),
      });
      expect(envelope(invalid.result).error).not.toHaveProperty("nextAction");
      expect(envelope(invalid.result).error.retry).toBe("Correct the listed arguments and retry crm__get_person.");
    }
    expect(sent).toEqual([]);
    // A downstream tool may itself be named after a meta wrapper.
    for (const tool of ["call_tool", "execute_code"]) {
      const recovery = nativeRecovery(
        {
          isError: true,
          structuredContent: { error: { operation: `crm.${tool}`, retry: `Retry crm.${tool}.` } },
        },
        `crm__${tool}`,
      ) as { content: Array<{ text: string }> };
      expect(envelope(recovery).error.retry).toBe(`Retry crm__${tool}.`);
    }
  });

  it("INV-6: a tool's long error reaches a native write's agent whole and no activity record", async () => {
    const { connecta, token, sent, events } = await admitted();
    const called = await rpc(connecta, token, "hosted", "tools/call", {
      name: await nativeToolName("vendor", "pay", "write"),
      arguments: {},
    });
    expect(called.result.isError).toBe(true);
    const { error } = envelope(called.result);
    expect(error).toMatchObject({ retryable: false, writeOutcome: "unknown", toolAnswered: true });
    expect(error.message).toContain(APPROVAL_LINK);
    expect(sent).toEqual(["pay"]);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain("apr_7Hq2");
  });

  it("without execute_code, lists read_result and pages a truncated result through it", async () => {
    const { connecta, token } = await admitted();
    const listed = await rpc(connecta, token, "nocode", "tools/list", {});
    const names = listed.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("read_result");
    expect(names).not.toContain("execute_code");
    const big = await rpc(connecta, token, "nocode", "tools/call", {
      name: await nativeToolName("crm", "export.all", "read"),
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
    expect(native.result.instructions).toBe(`Use skills. Team tier. ${nativeInstructions(true)}`);
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

  it("INV-2: resolves truncated connector prefixes, refuses collisions, and ignores unrelated failing siblings", async () => {
    const longId = `a__${"b".repeat(50)}`;
    const name = await nativeToolName(longId, "get", "read");
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
    // Hashed names bind the same way, with the connector's id cut short or the tool's name unsafe.
    for (const [connector, toolName] of [
      ["c".repeat(30), "set"],
      ["crm", "set.all"],
      ["crm", "s".repeat(45)],
    ] as const) {
      const storage = memoryStorage();
      const sent: string[] = [];
      let write = false;
      const app = createTestConnecta({
        connectors: [
          {
            id: connector,
            listTools: async () => [{ name: toolName, annotations: { readOnlyHint: !write } }],
            callTool: async () => {
              sent.push(connector);
              return {};
            },
          },
        ],
        agents: ["assistant"],
        pools: { native: { tools: [connector], members: ["agent:assistant"], surface: "native" } },
        storage,
        accessTokens: accessTokens(storage),
        logger: silentLogger,
      });
      const [read, written] = [
        await nativeToolName(connector, toolName, "read"),
        await nativeToolName(connector, toolName, "write"),
      ];
      try {
        const token = await issueAgentToken(storage, "assistant");
        write = true;
        const listing = await rpc(app, token, "native", "tools/list", {});
        expect(listing.result.tools.map((tool: { name: string }) => tool.name)).toContain(written);
        const refused = await rpc(app, token, "native", "tools/call", { name: read, arguments: {} });
        expect(envelope(refused.result).error).toMatchObject({
          code: "destructive_tool_requires_approval",
          nextAction: { tool: written },
        });
        expect(sent).toEqual([]);
        const called = await rpc(app, token, "native", "tools/call", { name: written, arguments: {} });
        expect(called.result.isError).toBeUndefined();
        expect(sent).toEqual([connector]);
      } finally {
        await app.close();
      }
    }
    for (const failure of [new Error("down"), new ConnectorCallError("auth_required", "needs auth")]) {
      const storage = memoryStorage();
      let siblingLoads = 0;
      const sent: string[] = [];
      const app = createTestConnecta({
        connectors: [
          {
            id: "x",
            listTools: async () => {
              siblingLoads++;
              throw failure;
            },
            callTool: async () => ({}),
          },
          {
            id: "x_y",
            listTools: async () => [{ name: "get", annotations: { readOnlyHint: true } }],
            callTool: async () => {
              sent.push("x_y");
              return {};
            },
          },
        ],
        agents: ["assistant"],
        pools: { native: { tools: ["x", "x_y"], members: ["agent:assistant"], surface: "native" } },
        storage,
        accessTokens: accessTokens(storage),
        logger: silentLogger,
      });
      try {
        const token = await issueAgentToken(storage, "assistant");
        const listing = await rpc(app, token, "native", "tools/list", {});
        expect(listing.result.tools.map((tool: { name: string }) => tool.name)).toContain("x_y__get");
        const before = siblingLoads;
        for (const modern of [true, false]) {
          const called = await rpc(app, token, "native", "tools/call", { name: "x_y__get", arguments: {} }, modern);
          expect(called.result.isError).toBeUndefined();
        }
        expect(sent).toEqual(["x_y", "x_y"]);
        expect(siblingLoads).toBe(before);
      } finally {
        await app.close();
      }
    }
  });

  it("INV-1 INV-9: a name a read held before write names existed stays that read, never another tool's write", async () => {
    // Before names bound a classification, `crm.WRITE__get` was already `crm__WRITE__get_373b87`,
    // and a host may hold it across the upgrade. `crm.get_373b87` is an unrelated write.
    const cached = "crm__WRITE__get_373b87";
    for (const readStillRead of [true, false]) {
      const storage = memoryStorage();
      const sent: string[] = [];
      const app = createTestConnecta({
        connectors: [
          {
            id: "crm",
            listTools: async () => [
              { name: "WRITE__get", annotations: { readOnlyHint: readStillRead } },
              { name: "get_373b87", annotations: { readOnlyHint: false } },
            ],
            callTool: async (tool) => {
              sent.push(tool);
              return {};
            },
          },
        ],
        agents: ["assistant"],
        pools: { native: { tools: ["crm"], members: ["agent:assistant"], surface: "native" } },
        storage,
        accessTokens: accessTokens(storage),
        logger: silentLogger,
      });
      try {
        const token = await issueAgentToken(storage, "assistant");
        const listed = await rpc(app, token, "native", "tools/list", {});
        const names = listed.result.tools.map((tool: { name: string }) => tool.name);
        const write = await nativeToolName("crm", "get_373b87", "write");
        expect(write).not.toBe(cached);
        expect(names).toContain(write);
        expect(names.includes(cached)).toBe(readStillRead);

        const resent = await rpc(app, token, "native", "tools/call", { name: cached, arguments: {} });
        if (readStillRead) {
          expect(resent.result.isError).toBeUndefined();
          expect(sent).toEqual(["WRITE__get"]);
        } else {
          // The cached read's own tool became a write: refused, not run under a name that reads like a write.
          expect(envelope(resent.result).error).toMatchObject({
            code: "destructive_tool_requires_approval",
            nextAction: { tool: await nativeToolName("crm", "WRITE__get", "write") },
          });
          expect(sent).toEqual([]);
        }
        sent.length = 0;
        const called = await rpc(app, token, "native", "tools/call", { name: write, arguments: {} });
        expect(called.result.isError).toBeUndefined();
        expect(sent).toEqual(["get_373b87"]);
      } finally {
        await app.close();
      }
    }
  });

  it("INV-1: recovery from a refused read names the write, when resolution still saw a read", async () => {
    const storage = memoryStorage();
    const sent: string[] = [];
    let loads = 0;
    const app = createTestConnecta({
      connectors: [
        {
          id: "crm",
          // The first load answers resolution as a read, and every later one says write.
          listTools: async () => [{ name: "set", annotations: { readOnlyHint: loads++ === 0 } }],
          callTool: async () => {
            sent.push("set");
            return {};
          },
        },
      ],
      agents: ["assistant"],
      pools: { native: { tools: ["crm"], members: ["agent:assistant"], surface: "native" } },
      storage,
      accessTokens: accessTokens(storage),
      logger: silentLogger,
    });
    try {
      const token = await issueAgentToken(storage, "assistant");
      const refused = await rpc(app, token, "native", "tools/call", { name: "crm__set", arguments: {} });
      expect(loads).toBeGreaterThan(1);
      expect(envelope(refused.result).error).toMatchObject({
        code: "destructive_tool_requires_approval",
        nextAction: { tool: "crm__WRITE__set" },
      });
      expect(sent).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("INV-2: a name listing omits for a collision on either alias does not dispatch", async () => {
    // `a.b__x` hashes to the read name `a__b__x_87f747`, the plain read name of `a__b.x_87f747`.
    const shared = "a__b__x_87f747";
    expect(await nativeToolName("a", "b__x", "read")).toBe(shared);
    expect(await nativeToolName("a__b", "x_87f747", "read")).toBe(shared);
    for (const siblingDown of [false, true]) {
      const storage = memoryStorage();
      const sent: string[] = [];
      const fixture = (id: string, name: string): Connector => ({
        id,
        listTools: async () => {
          if (siblingDown && id === "a__b") throw new Error("down");
          return [{ name, annotations: { readOnlyHint: false } }];
        },
        callTool: async () => {
          sent.push(id);
          return {};
        },
      });
      const app = createTestConnecta({
        connectors: [fixture("a", "b__x"), fixture("a__b", "x_87f747")],
        agents: ["assistant"],
        pools: { native: { tools: ["a", "a__b"], members: ["agent:assistant"], surface: "native" } },
        storage,
        accessTokens: accessTokens(storage),
        logger: silentLogger,
      });
      try {
        const token = await issueAgentToken(storage, "assistant");
        const aliases = [shared, await nativeToolName("a", "b__x", "write")];
        if (!siblingDown) {
          aliases.push(await nativeToolName("a__b", "x_87f747", "write"));
          const listed = await rpc(app, token, "native", "tools/list", {});
          const names = listed.result.tools.map((tool: { name: string }) => tool.name);
          for (const alias of aliases) expect(names).not.toContain(alias);
        }
        for (const name of aliases) {
          const called = await rpc(app, token, "native", "tools/call", { name, arguments: {} });
          expect(called.result.isError, name).toBe(true);
          // A claimant of the other alias that cannot load cannot prove the name unique.
          expect(envelope(called.result).error.code, name).toBe(siblingDown ? "catalog_lookup_failed" : "unknown_tool");
        }
        expect(sent).toEqual([]);
      } finally {
        await app.close();
      }
    }
  });

  it("INV-1 INV-8: lists a slow connector's stale catalog fail-closed, briefly, and a call never resolves through it", async () => {
    const storage = memoryStorage();
    let hung = false;
    let dispatched = 0;
    const app = createTestConnecta({
      connectors: [
        {
          id: "crm",
          kind: "mcp" as const,
          listTools: (ctx) =>
            hung
              ? new Promise((_, reject) =>
                  ctx.signal!.addEventListener("abort", () => reject(ctx.signal!.reason), { once: true }),
                )
              : Promise.resolve([
                  { name: "get", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
                ]),
          callTool: async () => {
            dispatched++;
            return {};
          },
        },
      ],
      agents: ["assistant"],
      pools: { native: { tools: ["crm"], members: ["agent:assistant"], surface: "native" } },
      discovery: { probeTimeoutMs: 100 },
      storage,
      accessTokens: accessTokens(storage),
      logger: silentLogger,
    });
    try {
      const token = await issueAgentToken(storage, "assistant");
      const fresh = await rpc(app, token, "native", "tools/list", {});
      const tool = (listing: typeof fresh) =>
        listing.result.tools.find((candidate: { name: string }) => candidate.name === "crm__get");
      expect(tool(fresh).annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(fresh.result.ttlMs).toBe(300_000);
      hung = true;
      const stale = await rpc(app, token, "native", "tools/list", {});
      // The connector stays listed, and neither its read hint nor the usual cache time is vouched for.
      expect(tool(stale).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(tool(stale)._meta["dev.connecta/stale"]).toEqual({ code: "timeout", ageMs: expect.any(Number) });
      expect(stale.result.ttlMs).toBe(60_000);
      const skills = stale.result.tools.find((candidate: { name: string }) => candidate.name === "skills");
      expect(skills._meta["dev.connecta/surface"].staleCatalogs).toEqual(["crm"]);
      expect(skills._meta["dev.connecta/surface"].catalogErrors).toEqual([]);
      const call = await rpc(app, token, "native", "tools/call", { name: "crm__get", arguments: {} });
      expect(envelope(call.result).error.code).toBe("timeout");
      expect(dispatched).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("INV-8: preserves object schemas and omits only the connector with an unrepresentable schema", async () => {
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
      const warnings: unknown[][] = [];
      const connector = {
        id: "crm",
        kind: "mcp" as const,
        listTools: async () => [
          { name: "other", inputSchema: object, annotations: { readOnlyHint: true } },
          { name: "get", inputSchema: schema, annotations: { readOnlyHint: true } },
        ],
        callTool: async () => {
          sent.push("get");
          return {};
        },
      };
      const app = createTestConnecta({
        connectors: [
          connector,
          {
            ...connector,
            id: "notes",
            listTools: async () => [{ name: "get", inputSchema: object, annotations: { readOnlyHint: true } }],
          },
        ],
        agents: ["assistant"],
        pools: {
          native: { tools: ["crm", "notes"], members: ["agent:assistant"], surface: "native" },
        },
        storage,
        accessTokens: accessTokens(storage),
        logger: { ...silentLogger, warn: (...args: unknown[]) => warnings.push(args) },
      });
      try {
        const token = await issueAgentToken(storage, "assistant");
        const listing = await rpc(app, token, "native", "tools/list", {});
        const names = listing.result.tools.map((tool: { name: string }) => tool.name);
        expect(names).toContain("notes__get");
        if (schema.type === "string" || schema.type === "array" || schema.$ref === "#/missing") {
          expect(names).not.toContain("crm__get");
          expect(names).not.toContain("crm__other");
          expect(warnings).toContainEqual([
            expect.stringContaining("native catalog unavailable"),
            expect.objectContaining({ connector: "crm", tool: "get" }),
          ]);
          const skills = listing.result.tools.find((tool: { name: string }) => tool.name === "skills");
          expect(skills._meta["dev.connecta/surface"].catalogErrors).toEqual(["crm"]);
          expect(JSON.stringify(warnings)).not.toContain("cannot be represented");
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
    expect(await nativeToolName("crm", "get_person", "read")).toBe("crm__get_person");
    expect(await nativeToolName("crm", "get-person2", "read")).toBe("crm__get-person2");
    // Lossy, a nested separator, a leading underscore, or overlong: head + six hex.
    for (const [connector, tool] of [
      ["crm", "export.all"],
      ["crm", "a__b"],
      ["crm", "_private"],
      ["crm", "x".repeat(60)],
    ] as const) {
      const name = await nativeToolName(connector, tool, "read");
      expect(name).toMatch(/^crm__.*_[0-9a-f]{6}$/);
      expect(name.length).toBeLessThanOrEqual(NATIVE_NAME_MAX);
      expect(await nativeToolName(connector, tool, "read")).toBe(name);
    }
    expect(await nativeToolName("crm", "export.all", "read")).not.toBe(
      await nativeToolName("crm", "export_all", "read"),
    );
    // A connector id that does not start with a letter gets an uppercase prefix no id can contain.
    expect(await nativeToolName("1pass", "get", "read")).toBe("C1pass__get");
    for (const name of [await nativeToolName("1pass", "get", "read"), await nativeToolName("crm", "é", "read")]) {
      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
    }
  });

  it(
    "INV-1: bind each classification to its own name, and no read's name, old or new, is ever a write's",
    { tags: ["node"] },
    async () => {
      expect(await nativeToolName("crm", "create_person", "write")).toBe("crm__WRITE__create_person");
      expect(await nativeToolName("1pass", "set", "write")).toBe("C1pass__WRITE__set");
      // Eve displays the last `__` segment, so that stays the tool.
      expect((await nativeToolName("crm", "create_person", "write")).split("__").at(-1)).toBe("create_person");
      // The name every tool had before names bound a classification, whatever it is now.
      const legacy = async (connector: string, tool: string) => {
        const part = /^[a-z]/.test(connector) ? connector : `C${connector}`;
        const safe = tool.replace(/[^A-Za-z0-9_-]/g, "_");
        const plain = `${part}__${safe}`;
        if (safe === tool && /^[A-Za-z0-9-](?:[A-Za-z0-9-]|_(?!_))*$/.test(safe) && plain.length <= NATIVE_NAME_MAX)
          return plain;
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${connector}.${tool}`));
        const hash = [...new Uint8Array(digest).subarray(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join("");
        return `${plain.slice(0, NATIVE_NAME_MAX - 7).replace(/_+$/, "")}_${hash}`;
      };
      const pairs: (readonly [string, string])[] = [
        ["crm", "get"],
        // A name that reads like a write's still stays a read's.
        ["crm", "get_write"],
        ["crm", "write"],
        ["crm", "WRITE"],
        ["crm", "WRITE_"],
        ["crm", "WRITE__get"],
        ["crm", "WRITE__WRITE__get"],
        ["crm", "x__WRITE__y.z"],
        ["crm", ".WRITE..y"],
        ["crm", "_WRITE__y"],
        ["crm__x", "write"],
        ["crm_", "WRITE__y"],
        ["1pass", "get"],
        ["1pass", "WRITE__get"],
        ["crm", "x".repeat(41)],
        ["crm", "x".repeat(60)],
        ["crm", `${"x".repeat(50)}__WRITE__`],
        ["crm", `WRITE__${"x".repeat(50)}`],
        ["c".repeat(60), "get"],
        ["c".repeat(24), "get.it"],
        ["c".repeat(25), "get.it"],
        ["c".repeat(24), "WRITE__get"],
        ["crm", "é"],
        ["crm_", "get"],
        ["crm", "_get"],
        // A write whose plain name would end like a hashed read's takes a hashed name instead.
        ["crm", "get_373b87"],
        ["crm", "abcdef"],
        ["crm", "x_000000"],
      ];
      // Every old name that carries the marker, with the tool a write's plain name would take it from.
      const reachable = await Promise.all(pairs.map(([connector, tool]) => legacy(connector, tool)));
      for (const old of reachable) {
        const at = old.indexOf("__WRITE__");
        if (at > 0) pairs.push([old.slice(0, at).replace(/^C(?=[^a-z])/, ""), old.slice(at + 9)]);
      }
      const reads = new Set<string>();
      const writes = new Set<string>();
      for (const [connector, tool] of pairs) {
        const read = await nativeToolName(connector, tool, "read");
        const write = await nativeToolName(connector, tool, "write");
        // Every read keeps its name, so nothing a host cached needs reserving.
        expect(read).toBe(await legacy(connector, tool));
        expect(write).toContain("__WRITE__");
        // The rule: an old name carries the marker only when hashed, and a write never ends like a hash.
        expect(write).not.toMatch(/_[0-9a-f]{6}$/);
        if (read.includes("__WRITE__")) expect(read).toMatch(/_[0-9a-f]{6}$/);
        for (const name of [read, write]) {
          expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
          expect(name.length).toBeLessThanOrEqual(NATIVE_NAME_MAX);
        }
        expect(await nativeToolName(connector, tool, "write")).toBe(write);
        reads.add(read);
        writes.add(write);
      }
      expect([...reads].filter((name) => writes.has(name))).toEqual([]);
      expect(await legacy("crm", "WRITE__get")).toBe("crm__WRITE__get_373b87");
      expect(await nativeToolName("crm", "get_373b87", "write")).toMatch(/^crm__WRITE__get_373b87_w[0-9a-f]{6}$/);
      expect(await nativeToolName("crm", "get_write", "read")).toBe("crm__get_write");
      expect(await nativeToolName("crm", "write", "read")).toBe("crm__write");
      expect(await nativeToolName("crm__x", "write", "read")).toBe("crm__x__write");
    },
  );
});

describe("route names per surface", () => {
  const note = routeDescription((phrases) => `Raise it only ${phrases.forDirect} read.`);
  const connectors = () => [
    api("crm", {
      tools: [
        {
          name: "get_person",
          description: "Get a person",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: { maxBytes: { type: "integer", description: note } } },
          handler: async () => ({ ok: true }),
        },
        {
          name: "create_person",
          description: "Create a person",
          annotations: { readOnlyHint: false },
          inputSchema: { type: "object" },
          handler: async () => ({ ok: true }),
        },
      ],
    }),
    {
      id: "service",
      kind: "api",
      credential: { label: "Service token" },
      listTools: async () => [{ name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
      callTool: async () => ({ ok: true }),
    } as Connector,
  ];

  it("builds native recovery text with the native contract's wording", async () => {
    const storage = memoryStorage();
    const connecta = createTestConnecta({
      connectors: connectors(),
      agents: ["assistant"],
      pools: {
        meta: { tools: ["crm", "service"], members: ["agent:assistant"] },
        native: { tools: ["crm", "service"], members: ["agent:assistant"], surface: "native" },
        nocode: { tools: ["crm", "service"], members: ["agent:assistant"], surface: "native", executeCode: false },
      },
      publicUrl: BASE,
      logger: silentLogger,
      storage,
      accessTokens: accessTokens(storage),
    });
    const token = await issueAgentToken(storage, "assistant");
    for (const pool of ["native", "nocode"]) {
      const called = await rpc(connecta, token, pool, "tools/call", { name: "service__read", arguments: {} });
      const error = envelope(called.result).error;
      expect(error.message, pool).toBe(
        "Operator-managed credential storage is not configured. Give this error's nextAction to the user or operator.",
      );
      expect(JSON.stringify(error), pool).not.toMatch(
        /search_tools|call_tool|call_destructive_tool|authorize_connector/,
      );
    }
    // A legacy request: the modern one would also need the address header.
    const meta = await rpc(
      connecta,
      token,
      "meta",
      "tools/call",
      { name: "call_tool", arguments: { address: "service.read" } },
      false,
    );
    expect(envelope(meta.result).error.message).toBe(
      "Operator-managed credential storage is not configured. Give this error's nextAction to the user or operator.",
    );
    await connecta.close();
  });

  it("lists authored schema descriptions in the serving pool's wording, with its paging", async () => {
    const storage = memoryStorage();
    const account = (name: string) => ({
      purpose: "Staff",
      serviceAccount: { clientEmail: `${name}@project.iam.gserviceaccount.com`, privateKey: PRIVATE_KEY },
      subject: "pastor@church.example",
    });
    const member = { tools: ["mail", "docs"], members: ["agent:assistant"] };
    const connecta = createTestConnecta({
      connectors: [gmail("mail", account("mail") as never), docs("docs", account("docs") as never)],
      agents: ["assistant"],
      pools: {
        meta: member,
        native: { ...member, surface: "native" },
        nocode: { ...member, surface: "native", executeCode: false },
      },
      publicUrl: BASE,
      logger: silentLogger,
      storage,
      accessTokens: accessTokens(storage),
    });
    const token = await issueAgentToken(storage, "assistant");
    const descriptions = async (pool: string) => {
      const listed =
        pool === "meta"
          ? (
              await rpc(connecta, token, pool, "tools/call", {
                name: "search_tools",
                arguments: { query: "", includeSchemas: "json", limit: 50 },
              })
            ).result.structuredContent
          : (await rpc(connecta, token, pool, "tools/list", {})).result;
      const found = new Set<string>();
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object")
          for (const [key, item] of Object.entries(value))
            if (key === "description" && typeof item === "string" && /^(Whole-result|Characters of text)/.test(item))
              found.add(item);
            else visit(item);
      };
      visit(listed);
      return [...found].sort();
    };
    const docsText =
      "Characters of text kept across all rendered tabs, 0 to 1000000; defaults to 20000. Connecta's cap. Longer text ends with a truncation marker. Above the default, ";
    expect(await descriptions("meta")).toEqual([
      `${docsText}call directly (call_tool, connecta.result to page): execute_code carries at most 256 KiB per result.`,
      "Whole-result byte budget. Raise only for a direct call_tool; execute_code cannot receive large results.",
    ]);
    expect(await descriptions("native")).toEqual([
      `${docsText}call this tool directly and page with connecta.result in execute_code: execute_code carries at most 256 KiB per result.`,
      "Whole-result byte budget. Raise only when calling this tool directly; execute_code cannot receive large results.",
    ]);
    expect(await descriptions("nocode")).toEqual([
      `${docsText}call this tool directly and page with read_result.`,
      "Whole-result byte budget. Raise only when calling this tool directly.",
    ]);
    await connecta.close();
  });

  it("serves the eval code arm's text, schemas included, in program form", async () => {
    const config = {
      connectors: connectors(),
      publicUrl: BASE,
      logger: silentLogger,
      readOnly: false,
      executor: customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }),
    };
    // The mark is on this object, so it goes to createConnecta as it is.
    renderRoutesAsPrograms(config);
    const coded = createConnecta(config);
    const plain = createTestConnecta({ connectors: connectors(), publicUrl: BASE, logger: silentLogger });
    const send = async (c: Fetcher, method: string, params: object) =>
      readJsonRpc(await c.fetch(mcpRpc(method, params)));
    const listed = await send(coded, "tools/list", {});
    expect(listed.result.tools.find((t: { name: string }) => t.name === "execute_code").description).toMatch(
      /^Every operation uses execute_code\. /,
    );
    const refusal = async (c: Fetcher) =>
      envelope(
        (
          await send(c, "tools/call", {
            name: "call_tool",
            arguments: { address: "crm.create_person" },
          })
        ).result,
      ).error.message;
    expect(await refusal(coded)).toContain("Invoke it through connecta.call inside execute_code so");
    expect(await refusal(plain)).toContain("Invoke it through call_destructive_tool so");
    const schema = async (c: Fetcher) =>
      JSON.stringify(
        (await send(c, "tools/call", { name: "search_tools", arguments: { connector: "crm", includeSchemas: "json" } }))
          .result.structuredContent,
      );
    expect(await schema(coded)).toContain("Raise it only for a direct connecta.call inside execute_code read.");
    expect(await schema(plain)).toContain("Raise it only for a direct call_tool read.");
    await coded.close();
    await plain.close();
  });
});
