import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { readJsonRpc } from "../../../test/fixtures/http.js";
import { issueAgentToken } from "../../../test/helpers/agent-tokens.js";
import { createTestConnecta, makeRegistry, silentLogger } from "../../../test/helpers.js";
import { accessTokens } from "../../access-tokens.js";
import type { ConnectorCaller } from "../../connector-caller.js";
import { CredentialVault } from "../../credentials.js";
import { memoryStorage } from "../../storage/memory.js";
import type { Connector, ConnectorContext } from "../../types.js";
import { intercom, type IntercomOptions } from "./index.js";

const TOKEN = "dG9rOmZpeHR1cmUtaW50ZXJjb20tdG9rZW4=";
const CONVERSATION = "123456789";
const VAULT_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

interface Sent {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown> | undefined;
}
const sent: Sent[] = [];
let respond: (request: Sent) => Response;

const conversation = (extra: Record<string, unknown> = {}) => ({
  type: "conversation",
  id: CONVERSATION,
  state: "open",
  admin_assignee_id: 1001,
  team_assignee_id: null,
  snoozed_until: null,
  source: { type: "conversation", id: "1", body: "<p>Hi</p>", attachments: [] },
  conversation_parts: { type: "conversation_part.list", conversation_parts: [{ id: "77", part_type: "note" }] },
  ...extra,
});

beforeEach(() => {
  installOwnedTransport();
  sent.length = 0;
  respond = (request) =>
    request.url.pathname.includes("/tags")
      ? Response.json({ type: "tag", id: "55", name: "billing" })
      : Response.json(conversation());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const text = typeof init.body === "string" ? init.body : undefined;
      const request: Sent = {
        url: new URL(input),
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body: text ? JSON.parse(text) : undefined,
      };
      sent.push(request);
      expect(init.redirect).toBe("manual");
      return respond(request);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function connectorContext(token: string | null = TOKEN): ConnectorContext {
  return {
    storage: memoryStorage(),
    logger: silentLogger,
    baseUrl: "https://connecta.example",
    credential: { get: async () => token, getAll: async () => (token === null ? null : { value: token }) },
  };
}

function setup(overrides: Partial<IntercomOptions> = {}) {
  const connector = intercom("support", { purpose: "Customer support", admin: "1001", ...overrides });
  const ctx = connectorContext();
  return {
    connector,
    ctx,
    call: (tool: string, args: Record<string, unknown>) => connector.callTool(tool, args, ctx) as Promise<any>,
  };
}

function callerContext(connector: Connector, caller: ConnectorCaller | undefined): ConnectorContext {
  const registry = makeRegistry([connector]);
  const ctx = registry
    .scoped({ connectorIds: "all", ...(caller ? { caller } : {}) })
    .contextFor("support", "https://connecta.example");
  return Object.assign(ctx, { credential: connectorContext().credential });
}

const WRITES: ReadonlyArray<readonly [string, Record<string, unknown>, string, string, Record<string, unknown>]> = [
  [
    "reply_to_conversation",
    { conversationId: CONVERSATION, body: "Thanks, alice." },
    "POST",
    `/conversations/${CONVERSATION}/reply`,
    { message_type: "comment", type: "admin", body: "Thanks, alice." },
  ],
  [
    "add_conversation_note",
    { conversationId: CONVERSATION, body: "Escalated to billing." },
    "POST",
    `/conversations/${CONVERSATION}/reply`,
    { message_type: "note", type: "admin", body: "Escalated to billing." },
  ],
  [
    "close_conversation",
    { conversationId: CONVERSATION },
    "POST",
    `/conversations/${CONVERSATION}/parts`,
    { message_type: "close", type: "admin", skip_notifications: true },
  ],
  [
    "open_conversation",
    { conversationId: CONVERSATION },
    "POST",
    `/conversations/${CONVERSATION}/parts`,
    { message_type: "open", skip_notifications: true },
  ],
  [
    "snooze_conversation",
    { conversationId: CONVERSATION, until: "2099-01-02T03:04:05Z" },
    "POST",
    `/conversations/${CONVERSATION}/parts`,
    { message_type: "snoozed", snoozed_until: 4071006245 },
  ],
  [
    "assign_conversation",
    { conversationId: CONVERSATION, assigneeType: "team", assigneeId: "42" },
    "POST",
    `/conversations/${CONVERSATION}/parts`,
    { message_type: "assignment", type: "team", assignee_id: "42", skip_notifications: true },
  ],
  [
    "unassign_conversation",
    { conversationId: CONVERSATION },
    "POST",
    `/conversations/${CONVERSATION}/parts`,
    { message_type: "assignment", type: "admin", assignee_id: "0", skip_notifications: true },
  ],
  [
    "tag_conversation",
    { conversationId: CONVERSATION, tagId: "55" },
    "POST",
    `/conversations/${CONVERSATION}/tags`,
    { id: "55" },
  ],
  [
    "untag_conversation",
    { conversationId: CONVERSATION, tagId: "55" },
    "DELETE",
    `/conversations/${CONVERSATION}/tags/55`,
    {},
  ],
];

describe("intercom", () => {
  it("classifies reads, the destructive customer reply and close, and the other conversation writes without vendor I/O", async () => {
    const { connector, ctx } = setup();
    const tools = await connector.listTools(ctx);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect([...byName.keys()].sort()).toEqual(
      [...WRITES.map(([name]) => name), "intercom_api_details", "intercom_api_read", "intercom_api_search"].sort(),
    );
    for (const name of ["intercom_api_details", "intercom_api_read", "intercom_api_search"])
      expect(byName.get(name)!.annotations?.readOnlyHint).toBe(true);
    for (const [name] of WRITES) {
      expect(byName.get(name)!.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: name === "reply_to_conversation" || name === "close_conversation",
      });
      expect(JSON.stringify(byName.get(name)!.inputSchema)).not.toContain("admin_id");
    }
    const readOnly = intercom("support", { purpose: "Customer support", readOnly: true });
    await expect(
      readOnly.callTool("add_conversation_note", { conversationId: CONVERSATION, body: "Hi" }, ctx),
    ).rejects.toMatchObject({ code: "auth_required" });
    expect(() => intercom("support", { purpose: "Customer support" })).toThrow(/requires admin/);
    expect(() =>
      intercom("support", { purpose: "Customer support", admin: "1001", auth: { type: "oauth" } as never }),
    ).toThrow(/remoteMcp\(\) at https:\/\/mcp\.intercom\.com\/mcp/);
    expect(() => intercom("support", { purpose: "Customer support", admin: "alice@example.com" })).toThrow(
      /numeric Intercom admin id/,
    );
    const search = await connector.callTool("intercom_api_search", { query: "reply to a conversation" }, ctx);
    expect(JSON.stringify(search)).toContain("reply_to_conversation");
    const details = await connector.callTool(
      "intercom_api_details",
      { method: "POST", path: "/conversations/{conversation_id}/reply" },
      ctx,
    );
    expect(JSON.stringify(details)).toContain("refuse");
    expect(sent).toHaveLength(0);
  });

  it("fills every write's admin_id from the configured admin and refuses a caller-supplied one before dispatch", async () => {
    const { call } = setup();
    for (const [tool, args, method, path, body] of WRITES) {
      sent.length = 0;
      await call(tool, args);
      expect(sent).toHaveLength(1);
      const [request] = sent;
      expect(request!.method).toBe(method);
      expect(request!.url.origin + request!.url.pathname).toBe(`https://api.intercom.io${path}`);
      expect(request!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(request!.headers.get("intercom-version")).toBe("2.18");
      expect(request!.headers.get("accept")).toBe("application/json");
      expect(request!.body).toEqual({ ...body, admin_id: "1001" });
    }
    sent.length = 0;
    for (const [tool, args] of WRITES)
      await expect(call(tool, { ...args, admin_id: "666" })).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      call("intercom_api_read", {
        method: "POST",
        path: "/conversations/search",
        body: { query: { field: "state", operator: "=", value: "open" }, admin_id: "666" },
      }),
    ).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining("admin_id") });
    await expect(
      call("intercom_api_read", { method: "POST", path: `/conversations/${CONVERSATION}/reply`, body: {} }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(call("intercom_api_write", { method: "POST", path: "/tags", body: {} })).rejects.toBeDefined();
    expect(sent).toHaveLength(0);
  });

  it("resolves a mapped admin from the admitted person or agent and fails closed for anyone else", async () => {
    const admin = (identity: { principal?: { id: string }; agent?: string }) =>
      identity.agent === "assistant"
        ? "3001"
        : identity.principal?.id === "alice@example.com"
          ? "2001"
          : identity.principal?.id === "mallory@example.com"
            ? "not-an-id"
            : undefined;
    const connector = intercom("support", { purpose: "Customer support", admin });
    const person = (id: string): ConnectorCaller => ({
      authenticated: true,
      identity: { actor: { kind: "user", id }, principal: { namespace: "fixture", id }, interactive: true },
    });
    const note = (ctx: ConnectorContext) =>
      connector.callTool("add_conversation_note", { conversationId: CONVERSATION, body: "Checked." }, ctx);
    await note(callerContext(connector, person("alice@example.com")));
    await note(
      callerContext(connector, {
        authenticated: true,
        identity: { actor: { kind: "agent", id: "assistant" }, agent: "assistant", interactive: false },
      }),
    );
    expect(sent.map((request) => request.body?.["admin_id"])).toEqual(["2001", "3001"]);
    sent.length = 0;
    await expect(note(callerContext(connector, person("bob@example.com")))).rejects.toMatchObject({
      code: "auth_required",
    });
    await expect(note(callerContext(connector, person("mallory@example.com")))).rejects.toMatchObject({
      code: "connector_call_failed",
    });
    await expect(
      note(callerContext(connector, { ...person("alice@example.com"), authenticated: false })),
    ).rejects.toMatchObject({ code: "auth_required" });
    await expect(note(callerContext(connector, undefined))).rejects.toMatchObject({ code: "auth_required" });
    expect(sent).toHaveLength(0);
  });

  it("sends each region to its documented host", async () => {
    for (const [region, origin] of [
      ["us", "https://api.intercom.io"],
      ["eu", "https://api.eu.intercom.io"],
      ["au", "https://api.au.intercom.io"],
    ] as const) {
      sent.length = 0;
      respond = () => Response.json({ type: "admin.list", admins: [] });
      await setup({ region }).call("intercom_api_read", { path: "/admins" });
      expect(sent[0]!.url.origin).toBe(origin);
    }
    expect(() => intercom("support", { purpose: "Customer support", admin: "1001", region: "ca" as never })).toThrow(
      /region/,
    );
  });

  it("withholds attachment, file and signed embedded URLs while keeping their metadata", async () => {
    const signed = "https://downloads.intercomcdn.com/i/o/1/abc/report.pdf?expires=1&signature=feedface";
    respond = () =>
      Response.json(
        conversation({
          source: {
            type: "conversation",
            id: "1",
            body: `<p>See <a href="${signed}">report</a></p>`,
            attachments: [{ type: "upload", name: "report.pdf", url: signed, content_type: "application/pdf" }],
            author: { type: "user", id: "c1", name: "Bob", email: "bob@example.com" },
          },
          conversation_parts: {
            type: "conversation_part.list",
            conversation_parts: [
              {
                id: "77",
                part_type: "comment",
                body: `<img src="${signed}">`,
                attachments: [{ type: "upload", name: "screenshot.png", url: "https://downloads.example.com/bearer" }],
              },
            ],
          },
        }),
      );
    const { call } = setup();
    const read = await call("intercom_api_read", { path: `/conversations/${CONVERSATION}` });
    const text = JSON.stringify(read);
    expect(text).not.toContain("feedface");
    expect(text).not.toContain("downloads.example.com/bearer");
    expect(read.data.source.attachments[0]).toMatchObject({ name: "report.pdf", url: "[redacted]" });
    expect(read.data.source.author.email).toBe("bob@example.com");
    expect(read.data.conversation_parts.conversation_parts[0].attachments[0]).toMatchObject({
      name: "screenshot.png",
      url: "[redacted]",
    });
  });

  it("withholds credential links in every text field of conversations, tickets, notes and contacts, keeping ordinary links", async () => {
    const capability = "https://files.example.com/report?token=opaque-capability";
    const ordinary = "https://help.example.com/articles/42-refunds";
    const text = `See ${capability} and ${ordinary}`;
    const html = `<a href="${capability}">report</a> <a href="${ordinary}">help</a>`;
    const { call } = setup();
    const cases: Array<readonly [Record<string, unknown>, unknown]> = [
      [
        { path: `/conversations/${CONVERSATION}`, query: { include_translations: true } },
        conversation({
          title: text,
          source: { type: "conversation", id: "1", subject: text, body: html, attachments: [] },
          custom_attributes: { notes: text },
          conversation_parts: {
            type: "conversation_part.list",
            conversation_parts: [
              { id: "77", body: "ok", translations: { original: "en", de: html }, future_field: text },
            ],
          },
        }),
      ],
      [
        { path: "/conversations" },
        { type: "conversation.list", conversations: [{ id: "1", source: { subject: text } }] },
      ],
      [
        {
          method: "POST",
          path: "/conversations/search",
          body: { query: { field: "state", operator: "=", value: "open" } },
        },
        { type: "conversation.list", conversations: [{ id: "1", title: text, source: { subject: text } }] },
      ],
      [
        { path: "/tickets/123" },
        {
          type: "ticket",
          id: "123",
          ticket_attributes: { _default_title_: text, _default_description_: html },
          ticket_parts: { ticket_parts: [{ id: "1", body: html, unknown_text: text }] },
        },
      ],
      [
        { method: "POST", path: "/tickets/search", body: { query: {} } },
        { type: "ticket.list", tickets: [{ id: "1", ticket_attributes: { _default_description_: html } }] },
      ],
      [{ path: "/notes/9" }, { type: "note", id: "9", body: html }],
      [{ path: "/contacts/c1" }, { type: "contact", id: "c1", name: "Bob", custom_attributes: { profile: text } }],
      [{ path: "/articles/5" }, { type: "article", id: "5", body: html, description: text }],
    ];
    for (const [args, body] of cases) {
      respond = () => Response.json(body);
      const result = JSON.stringify(await call("intercom_api_read", args));
      expect(result, JSON.stringify(args)).not.toContain("opaque-capability");
      expect(result, JSON.stringify(args)).toContain(ordinary);
    }
    respond = () =>
      Response.json(
        conversation({
          conversation_parts: { type: "conversation_part.list", conversation_parts: [{ id: "77", body: html }] },
        }),
      );
    expect(
      JSON.stringify(await call("add_conversation_note", { conversationId: CONVERSATION, body: "Checked." })),
    ).not.toContain("opaque-capability");
  });

  it("encodes query parameters by the pinned style", async () => {
    const { call } = setup();
    await call("intercom_api_read", {
      path: `/conversations/${CONVERSATION}`,
      query: { include_part_types: ["note", "comment"] },
    });
    respond = () => Response.json({ type: "list", data: [] });
    await call("intercom_api_read", {
      path: "/content/search",
      query: { query: "refund", states: ["published", "draft"] },
    });
    respond = () => Response.json({ type: "event.list", events: [] });
    await call("intercom_api_read", { path: "/events", query: { filter: { user_id: "alice" }, type: "user" } });
    expect(sent.map((request) => request.url.search)).toEqual([
      "?include_part_types=note%2Ccomment",
      "?query=refund&states=published%2Cdraft",
      "?user_id=alice&type=user",
    ]);
    sent.length = 0;
    await expect(
      call("intercom_api_read", { path: `/conversations/${CONVERSATION}`, query: { include_part_types: ["a,b"] } }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(sent).toHaveLength(0);
  });

  it("pages every conversation part oldest first and warns when an unpaged read hit the 500-part cap", async () => {
    const { call } = setup();
    const parts = (count: number, from = 0) =>
      Array.from({ length: count }, (_, at) => ({ id: String(from + at + 1), part_type: "comment", body: "x" }));
    respond = () =>
      Response.json(
        conversation({
          conversation_parts: { type: "conversation_part.list", conversation_parts: parts(500), total_count: 500 },
        }),
      );
    const capped = await call("intercom_api_read", { path: `/conversations/${CONVERSATION}` });
    expect(capped.warnings?.join(" ")).toContain("query.page 1");
    expect(capped.page).toBeUndefined();
    respond = (request) => {
      const page = Number(request.url.searchParams.get("page"));
      return Response.json(
        conversation({
          conversation_parts: {
            type: "conversation_part.list",
            conversation_parts: parts(2, (page - 1) * 2),
            total_count: 2,
            pages: {
              type: "pages",
              page,
              per_page: 2,
              total_pages: 2,
              next: page < 2 ? `https://api.intercom.io/conversations/${CONVERSATION}?page=${page + 1}` : null,
            },
          },
        }),
      );
    };
    const first = await call("intercom_api_read", {
      path: `/conversations/${CONVERSATION}`,
      query: { page: 1, per_page: 2 },
    });
    expect(first.warnings).toBeUndefined();
    expect(first.page).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
    const last = await call("intercom_api_read", {
      path: `/conversations/${CONVERSATION}`,
      query: { per_page: 2 },
      cursor: first.page.nextCursor,
    });
    expect(last.page).toMatchObject({ hasMore: false });
    expect(sent.slice(-2).map((request) => request.url.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(last.data.conversation_parts.conversation_parts.map((part: { id: string }) => part.id)).toEqual(["3", "4"]);
  });

  it("pages starting_after lists through a bound cursor and refuses withheld or unrelated families", async () => {
    const { call } = setup();
    respond = () =>
      Response.json({
        type: "conversation.list",
        conversations: [],
        pages: { type: "pages", next: { page: 2, starting_after: "WzE3MDAwMDAwMDBd" }, per_page: 1 },
      });
    const first = await call("intercom_api_read", { path: "/conversations", query: { per_page: 1 } });
    expect(first.page).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
    respond = (request) => {
      expect(request.url.searchParams.get("starting_after")).toBe("WzE3MDAwMDAwMDBd");
      return Response.json({ type: "conversation.list", conversations: [], pages: { type: "pages", per_page: 1 } });
    };
    const last = await call("intercom_api_read", {
      path: "/conversations",
      query: { per_page: 1 },
      cursor: first.page.nextCursor,
    });
    expect(last.page).toMatchObject({ hasMore: false });
    sent.length = 0;
    for (const path of ["/auth_tokens", "/data_connectors", "/ip_allowlist", "/calls/1/recording"])
      await expect(call("intercom_api_read", { path })).rejects.toMatchObject({ code: "invalid_args" });
    expect(sent).toHaveLength(0);
  });

  it("lets a pool grant the reads alone or one exact write address alone", async () => {
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, VAULT_KEY);
    await vault.setAll("support", { value: TOKEN }, "operator");
    const connector = intercom("support", {
      purpose: "Customer support",
      admin: (identity) => (identity.agent === "assistant" ? "3001" : undefined),
    });
    const app = createTestConnecta({
      connectors: [connector],
      agents: ["assistant"],
      pools: {
        reads: { tools: ["support"], members: ["agent:assistant"], surface: "native", readOnly: true },
        notes: { tools: ["support.add_conversation_note"], members: ["agent:assistant"], surface: "native" },
      },
      publicUrl: "https://connecta.example",
      logger: silentLogger,
      storage,
      vault,
      accessTokens: accessTokens(storage),
    });
    const token = await issueAgentToken(storage, "assistant");
    const rpc = async (pool: string, method: string, params: Record<string, unknown>) =>
      readJsonRpc(
        await app.fetch(
          new Request(`https://connecta.example/agent/${pool}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              Authorization: `Bearer ${token}`,
              "MCP-Protocol-Version": "2026-07-28",
              "Mcp-Method": method,
              ...(typeof params["name"] === "string" ? { "Mcp-Name": params["name"] } : {}),
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method,
              params: {
                ...params,
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                  "io.modelcontextprotocol/clientCapabilities": {},
                },
              },
            }),
          }),
        ),
      );
    try {
      const reads = (await rpc("reads", "tools/list", {})).result.tools.map((tool: { name: string }) => tool.name);
      expect(reads).toContain("support__intercom_api_read");
      expect(reads.filter((name: string) => name.includes("WRITE"))).toEqual([]);
      const notes = (await rpc("notes", "tools/list", {})).result.tools
        .map((tool: { name: string }) => tool.name)
        .filter((name: string) => name.startsWith("support__"));
      expect(notes).toEqual(["support__WRITE__add_conversation_note"]);
      sent.length = 0;
      const noted = await rpc("notes", "tools/call", {
        name: "support__WRITE__add_conversation_note",
        arguments: { conversationId: CONVERSATION, body: "Checked." },
      });
      expect(noted.result.isError).toBeFalsy();
      expect(sent.map((request) => [request.method, request.url.pathname, request.body?.["admin_id"]])).toEqual([
        ["POST", `/conversations/${CONVERSATION}/reply`, "3001"],
      ]);
      sent.length = 0;
      for (const [pool, name, args] of [
        ["notes", "support__WRITE__reply_to_conversation", { conversationId: CONVERSATION, body: "Hi" }],
        ["notes", "support__intercom_api_read", { path: "/admins" }],
        ["reads", "support__WRITE__add_conversation_note", { conversationId: CONVERSATION, body: "Hi" }],
      ] as const)
        await rpc(pool, "tools/call", { name, arguments: args });
      expect(sent).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
