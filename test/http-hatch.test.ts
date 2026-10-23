import { NODE, WORKERS } from "./fixtures/runtime-tags.js";
import { Effect, Schema } from "effect";
import { kitInputDisagreements } from "./helpers/kit-schema.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apiConnector } from "../src/connectors/api-connector.js";
import { ConnectorCallError } from "../src/errors.js";
import { configureGuardedTransport } from "../src/guarded-transport.js";
import { guardedClient } from "../src/http/client.js";
import { RequestRefused, type VendorErrors } from "../src/http/errors.js";
import { DETAILS_BUDGET_BYTES, hatch, SEARCH_BUDGET } from "../src/http/hatch.js";
import { Integer } from "../src/http/json-schema.js";
import { restSafety, resultSafety } from "../src/http/safety.js";
import { connect, form, get, post, Summary, vendor } from "../src/http/vendor.js";
import { vendorIndex } from "../src/http/vendor-index.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import { OperationIndex, type OpenApiData } from "../src/providers/_shared/rest/operation-index.js";
import { valueSafety } from "../src/providers/_shared/rest/value-safety.js";
import { connectorContext } from "./fixtures/misc.js";

const DATA: OpenApiData = {
  source: "https://api.example/openapi.json",
  revision: "r1",
  digest: "sha256:0",
  version: "1",
  servers: ["https://api.example", "https://files.example"],
  tags: ["items"],
  ops: [
    ["GET", "/items", "ListItems", "List items", 0],
    ["GET", "/items/{item}", "GetItem", "Get item", 0],
    ["GET", "/touch", "TouchItem", "Touch item", 0],
    ["GET", "/blocked", "Blocked", "Blocked item", 0],
    ["POST", "/query", "QueryItems", "Query items", 0],
    ["POST", "/items", "CreateItem", "Create item", 0],
    ["DELETE", "/items/{item}", "DeleteItem", "Delete item", 0],
    ["POST", "/form", "CreateForm", "Create item form", 0],
    ["POST", "/upload", "Upload", "Upload item", 0],
    ["GET", "/elsewhere", "OtherServer", "Other item server", 0, 1],
    ["HEAD", "/items/{item}", "HeadItem", "Check item", 0],
  ],
  details: JSON.stringify({
    d: [],
    o: [
      [
        [
          ["limit", "query", 0, { t: "integer" }],
          ["tag", "query", 0, { t: "array", i: { t: "string" } }],
          ["link", "query", 0, { t: "string" }],
        ],
        0,
      ],
      0,
      0,
      0,
      [[], ["application/json", { t: "object", p: { filter: { t: "string" } } }]],
      [
        [],
        [
          "application/json",
          {
            t: "object",
            r: ["name"],
            p: { name: { t: "string" }, link: { t: "string" }, payload: { t: "object", x: 1 } },
          },
        ],
      ],
      0,
      [
        [],
        [
          "application/x-www-form-urlencoded",
          { t: "object", p: { name: { t: "string" }, tag: { t: "array", i: { t: "string" } } } },
        ],
      ],
      [[], ["multipart/form-data", { t: "object", p: { file: { t: "string", f: "binary" } } }]],
      0,
      0,
    ],
  }),
};
const VERDICTS = {
  "GET /items": "read",
  "GET /touch": "write",
  "GET /blocked": "refuse",
  "POST /query": "read",
  "POST /items": "write",
  "DELETE /items/{item}": "destructive",
  "POST /form": "write",
  "POST /upload": "write",
  "GET /elsewhere": "read",
  "HEAD /items/{item}": "read",
} as const;
const ERRORS: VendorErrors = {
  provider: "Items",
  facts: () => ({}),
  detail: ({ withheld, body }) => (withheld ? "Vendor text withheld." : String(body)),
  unreadable: "Items returned an unreadable body.",
  statuses: {
    401: () => ({ code: "auth_required" }),
    403: () => ({ code: "provider_permission_denied" }),
    404: () => ({ code: "not_found" }),
  },
};

let sent: Array<{ url: string; method: string; body: unknown }>;
let response: () => Response;
beforeEach(() => {
  sent = [];
  response = () => Response.json({ id: "i1" });
  configureGuardedTransport({
    send: async (url, init) => {
      sent.push({ url: String(url), method: init.method ?? "GET", body: init.body });
      return response();
    },
  });
});
afterEach(() => configureGuardedTransport(undefined));

function setup(options: { deny?: boolean; verdicts?: Parameters<typeof hatch>[0]["verdicts"] } = {}) {
  const index = new OperationIndex(DATA, { vendor: "items", title: "Items" });
  const reviewed = valueSafety(
    { title: "Items", operations: { "GET /items": { verdict: "safe", reason: "Only item metadata is returned." } } },
    () => index,
  );
  const authenticate = vi.fn(() => ({ Authorization: "Bearer credential-123456789" }));
  const admit = vi.fn(() =>
    options.deny ? Effect.fail(new RequestRefused({ message: "Account pin refused." })) : Effect.void,
  );
  const connection = connect(
    vendor("items", get("list", "/items")),
    guardedClient({
      provider: "Items",
      baseUrl: "https://api.example/v1",
      maxResponseBytes: 1024,
      admit,
      authenticate: Effect.sync(authenticate),
    }),
    {
      errors: ERRORS,
      safety: resultSafety({
        reviewed: restSafety(reviewed, index),
        sensitiveFields: { names: ["email"], choice: "drop" },
      }),
    },
  );
  const sendPath = vi.spyOn(connection, "sendPath");
  const tools = hatch({ name: "items", index, verdicts: options.verdicts ?? VERDICTS, connection });
  const connector = tracksEveryRequest(apiConnector("items", { tools }));
  const call = (kind: string, args: Record<string, unknown>) =>
    connector.callTool(`items_api_${kind}`, args, connectorContext());
  return { index, tools, connection, call, sendPath, authenticate, admit };
}

it(
  "INV-1 INV-10 INV-11: snapshots explicit verdicts, routes discovery without I/O, and validates construction",
  NODE,
  async () => {
    const verdicts = { ...VERDICTS };
    const { call, tools, index, connection, sendPath, authenticate } = setup({ verdicts });
    expect(tools.map((tool) => [tool.name, tool.annotations])).toEqual([
      ["items_api_search", { readOnlyHint: true }],
      ["items_api_details", { readOnlyHint: true }],
      ["items_api_read", { readOnlyHint: true }],
      ["items_api_write", { readOnlyHint: false, destructiveHint: true }],
    ]);
    // Compact pages of at most eight, continued by cursor until hasMore is false.
    const rows: Array<Record<string, unknown>> = [];
    let page: { hasMore: boolean; nextCursor?: string } = { hasMore: true };
    while (page.hasMore) {
      const reply = (await call("search", {
        query: "item",
        limit: 8,
        ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
      })) as { operations: Array<Record<string, unknown>>; page: typeof page };
      expect(reply.operations.length).toBeLessThanOrEqual(8);
      expect(Object.keys(reply.operations[0]!)).not.toContain("tag");
      rows.push(...reply.operations);
      page = reply.page;
      expect("nextCursor" in page).toBe(page.hasMore);
    }
    expect(rows).toHaveLength(11);
    // An exact path noun leads, root collection first.
    const first = (await call("search", { query: "items", limit: 3 })) as { operations: Array<{ path: string }> };
    expect(first.operations.map(({ path }) => path)).toEqual(["/items", "/items", "/items/{item}"]);
    await expect(call("search", { query: "item", limit: 9 })).rejects.toMatchObject({ code: "invalid_args" });
    await expect(call("search", { query: "item", cursor: "e30" })).rejects.toMatchObject({ code: "invalid_args" });
    for (const [method, path, verdict, tool] of [
      ["GET", "/items", "read", "items_api_read"],
      ["GET", "/touch", "write", "items_api_write"],
      ["DELETE", "/items/{item}", "destructive", "items_api_write"],
      ["POST", "/query", "read", "items_api_read"],
      ["GET", "/blocked", "refuse", undefined],
      ["GET", "/items/{item}", "refuse", undefined],
    ]) {
      const details = (await call("details", { method, path })) as Record<string, unknown>;
      expect(details).toMatchObject({ method, path, verdict, revision: "r1" });
      expect(details["tool"]).toBe(tool);
      expect(rows.find((row) => row["method"] === method && row["path"] === path)?.["tool"]).toBe(tool);
    }
    Object.assign(verdicts, { "GET /items": "write" });
    expect(await call("details", { method: "GET", path: "/items" })).toMatchObject({ verdict: "read" });
    expect(hatch({ name: "items", index, connection, verdicts: {} }).map((tool) => tool.name)).toEqual([
      "items_api_search",
      "items_api_details",
      "items_api_read",
    ]);
    for (const bad of [{ "GET /missing": "read" }, { "GET /items": "unknown" }]) {
      expect(() => hatch({ name: "items", index, connection, verdicts: bad as never })).toThrow();
    }
    for (const tool of tools) {
      const base = tool.name.endsWith("_search")
        ? { query: "items" }
        : tool.name.endsWith("_details") || tool.name.endsWith("_write")
          ? { method: "GET", path: "/items" }
          : { path: "/items" };
      expect(kitInputDisagreements(tool, base), tool.name).toEqual([]);
      expect(tool.inputSchema).toMatchObject({ additionalProperties: false });
      expect(Object.keys((tool.inputSchema as { properties: object }).properties)).not.toEqual(
        expect.arrayContaining(["raw"]),
      );
    }
    // A kit vendor with no OpenAPI pin indexes its own declarations, and details stay in budget.
    const optional = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [
        `note_${i}`,
        Schema.optionalKey(Schema.String.annotate({ description: "n".repeat(120) })),
      ]),
    );
    const derived = vendorIndex(
      vendor(
        "forms",
        post("createThing", "/things/:thing_id", {
          params: { thing_id: Schema.String },
          query: { account_id: Schema.String },
          payload: form(
            Schema.Struct({
              name: Schema.String.annotate({ description: "Display name." }),
              amount: Schema.optionalKey(Integer),
              ...optional,
            }),
          ),
          success: Schema.Struct({ object: Schema.optionalKey(Schema.Struct({ widget_id: Schema.String })) }),
        }).annotate(Summary, "Create a thing"),
      ),
      { prefix: "forms", title: "Forms", revision: "v1" },
    );
    const forms = tracksEveryRequest(
      apiConnector("forms", {
        tools: hatch({ name: "forms", index: derived, verdicts: { "POST /things/{thing_id}": "write" }, connection }),
      }),
    );
    const formsCall = (kind: string, args: Record<string, unknown>) =>
      forms.callTool(`forms_api_${kind}`, args, connectorContext()) as Promise<Record<string, any>>;
    expect((await formsCall("search", { query: "thing" })).operations).toEqual([
      {
        method: "POST",
        path: "/things/{thing_id}",
        operationId: "createThing",
        summary: "Create a thing",
        tool: "forms_api_write",
      },
    ]);
    // A field the operation returns finds it too, marked, after every path or summary match.
    expect((await formsCall("search", { query: "widget" })).operations).toEqual([
      expect.objectContaining({ path: "/things/{thing_id}", matched: "response field object.widget_id" }),
    ]);
    const contract = await formsCall("details", { method: "POST", path: "/things/t1" });
    expect(new TextEncoder().encode(JSON.stringify(contract)).length).toBeLessThanOrEqual(DETAILS_BUDGET_BYTES);
    expect(contract.parameters).toEqual([
      { name: "thing_id", in: "path", required: true, schema: { type: "string" } },
      { name: "account_id", in: "query", required: true, schema: { type: "string" } },
    ]);
    expect(contract.body).toMatchObject({
      contentType: "application/x-www-form-urlencoded",
      required: true,
      schema: { required: ["name"], properties: { name: { type: "string", description: "Display name." } } },
    });
    expect(contract.truncated).toEqual(expect.arrayContaining(["body.schema.properties.note_299"]));
    expect(contract.truncated).not.toContain("body.schema.properties.name");
    expect((await formsCall("details", { method: "POST", path: "/things/{thing_id}", param: "amount" })).body).toEqual({
      contentType: "application/x-www-form-urlencoded",
      schema: { type: "object", properties: { amount: { type: "number" } } },
    });
    // Search trims whole entries to its byte budget and continues by cursor.
    const long = new OperationIndex(
      {
        ...DATA,
        ops: Array.from(
          { length: 10 },
          (_, i) => ["GET", `/${"x".repeat(2000)}${i}`, `Long${i}`, "Long path", 0] as const,
        ),
        details: JSON.stringify({ d: [], o: [] }),
      },
      { vendor: "long", title: "Long" },
    );
    const trimmed = (await tracksEveryRequest(
      apiConnector("long", { tools: hatch({ name: "long", index: long, verdicts: {}, connection }) }),
    ).callTool("long_api_search", { query: "xxx", limit: 8 }, connectorContext())) as {
      operations: unknown[];
      page: { hasMore: boolean };
    };
    expect(trimmed.operations.length).toBeLessThan(8);
    expect(new TextEncoder().encode(JSON.stringify(trimmed)).length).toBeLessThanOrEqual(SEARCH_BUDGET.bytes + 200);
    expect(trimmed.page.hasMore).toBe(true);
    expect(sendPath).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  },
);

it("INV-1 INV-3 INV-9: validates and admits only reviewed requests through sendPath once", WORKERS, async () => {
  const withheld = "https://files.example/file?signature=%5Bredacted%5D";
  const cases: Array<{
    kind: string;
    args: Record<string, unknown>;
    message?: string;
    body?: string;
    url?: string;
    data?: unknown;
  }> = [
    { kind: "read", args: { path: "/items", query: { tag: ["b", "a"], limit: 2 } }, url: "/items?tag=b&tag=a&limit=2" },
    { kind: "read", args: { method: "POST", path: "/query", body: { filter: "open" } }, body: '{"filter":"open"}' },
    { kind: "write", args: { method: "GET", path: "/touch" } },
    { kind: "write", args: { method: "DELETE", path: "/items/i1" } },
    { kind: "write", args: { method: "POST", path: "/items", body: { name: "alice" } }, body: '{"name":"alice"}' },
    {
      kind: "write",
      args: { method: "POST", path: "/form", body: { name: "alice", tag: ["a", "b"] } },
      body: "name=alice&tag=a&tag=b",
    },
    { kind: "read", args: { path: "/touch" }, message: "items_api_write" },
    { kind: "write", args: { method: "GET", path: "/items" }, message: "items_api_read" },
    { kind: "read", args: { path: "/blocked" }, message: "refuses" },
    { kind: "read", args: { path: "/items/i1" }, message: "refuses" },
    { kind: "write", args: { method: "GET", path: "/blocked" }, message: "refuses" },
    { kind: "write", args: { method: "GET", path: "/items/i1" }, message: "refuses" },
    { kind: "read", args: { path: "/missing" }, message: "Nearest:" },
    { kind: "read", args: { path: "/items/../touch" }, message: "dot segment" },
    { kind: "read", args: { path: "/items?limit=1" }, message: "query" },
    { kind: "read", args: { path: "/items", query: { limt: 2 } }, message: "limt" },
    { kind: "read", args: { path: "/items", query: { link: { nested: true } } }, message: "link" },
    { kind: "read", args: { path: "/items", body: {} }, message: "takes query" },
    { kind: "write", args: { method: "POST", path: "/items", body: {} }, message: "name" },
    { kind: "write", args: { method: "POST", path: "/upload", body: {} }, message: "multipart" },
    { kind: "read", args: { path: "/elsewhere" }, message: "different server" },
    { kind: "read", args: { method: "HEAD", path: "/items/i1" }, data: null },
    { kind: "read", args: { path: "/items", raw: true }, message: "raw" },
    {
      kind: "write",
      args: { method: "POST", path: "/items", body: { name: "alice", link: withheld } },
      message: "withheld",
    },
    {
      kind: "write",
      args: { method: "POST", path: "/items", body: { name: "alice", payload: { nested: { [withheld]: true } } } },
      message: "withheld",
    },
  ];
  for (const entry of cases) {
    const { call, sendPath, authenticate } = setup();
    sent = [];
    if (entry.message) {
      await expect(call(entry.kind, entry.args), JSON.stringify(entry.args)).rejects.toMatchObject({
        code: "invalid_args",
        message: expect.stringContaining(entry.message),
      });
      expect(sendPath).not.toHaveBeenCalled();
      expect(authenticate).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    } else {
      expect(await call(entry.kind, entry.args)).toEqual({
        status: 200,
        data: entry.data === undefined ? { id: "i1" } : entry.data,
      });
      expect(sendPath).toHaveBeenCalledTimes(1);
      expect(sendPath.mock.calls[0]?.[0]).toMatchObject({ method: entry.args["method"] ?? "GET" });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.url).toBe(`https://api.example/v1${entry.url ?? entry.args["path"]}`);
      expect(sent[0]?.body).toBe(entry.body);
    }
  }
});

it("INV-3 INV-5 INV-6 INV-9: preserves admission, privacy, withheld errors and one write attempt", NODE, async () => {
  for (const entry of [
    { args: { path: "/items" }, deny: true, message: "Account pin", sends: 0, auth: 0 },
    {
      args: { path: "/items", fields: ["id", "nested.id"] },
      data: { id: "i1", email: "private", token: "stored-secret", nested: { id: "i2", email: "private" } },
      expected: { id: "i1", nested: { id: "i2" } },
    },
    {
      args: { path: "/items", fields: ["id", "label", "token"] },
      data: [{ id: "i1", email: "private", label: "credential-123456789", token: "stored-secret" }],
      expected: [{ id: "i1", label: "[redacted]", token: "[redacted]" }],
    },
    { args: { path: "/items", fields: ["email"] }, data: { id: "i1", email: "private" }, message: "property of data" },
    { args: { path: "/items" }, status: 403, data: { error: "stored-secret" }, message: "Vendor text withheld" },
    { args: { method: "GET", path: "/touch" }, kind: "write", status: 503, message: "", sends: 1 },
  ]) {
    sent = [];
    const { call, authenticate } = setup(entry.deny === undefined ? {} : { deny: entry.deny });
    response = () => Response.json(entry.data ?? { error: "vendor failure" }, { status: entry.status ?? 200 });
    if (entry.message !== undefined) {
      const failure = await call(entry.kind ?? "read", entry.args).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ConnectorCallError);
      expect((failure as Error).message).toContain(entry.message);
      expect((failure as Error).message).not.toContain("stored-secret");
      if (entry.status === 503) expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    } else {
      expect(await call("read", entry.args)).toEqual({ status: 200, data: entry.expected });
    }
    expect(sent).toHaveLength(entry.sends ?? 1);
    expect(authenticate).toHaveBeenCalledTimes(entry.auth ?? 1);
  }
});
