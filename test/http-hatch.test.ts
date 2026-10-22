import { Effect } from "effect";
import { kitInputDisagreements } from "./helpers/kit-schema.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apiConnector } from "../src/connectors/api-connector.js";
import { ConnectorCallError } from "../src/errors.js";
import { configureGuardedTransport } from "../src/guarded-transport.js";
import { guardedClient } from "../src/http/client.js";
import { RequestRefused, type VendorErrors } from "../src/http/errors.js";
import { hatch } from "../src/http/hatch.js";
import { resultSafety } from "../src/http/safety.js";
import { connect, get, vendor } from "../src/http/vendor.js";
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
        reviewed: {
          redact: (data, op) => reviewed.redact(data, op.method, op.template),
          withholdsErrors: (op) => {
            const indexed = index.operation(op.method, op.template);
            return indexed ? reviewed.withholdsErrors(indexed) : true;
          },
        },
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

it("INV-1 INV-10 INV-11: snapshots explicit verdicts, routes discovery without I/O, and validates construction", async () => {
  const verdicts = { ...VERDICTS };
  const { call, tools, index, connection, sendPath, authenticate } = setup({ verdicts });
  expect(tools.map((tool) => [tool.name, tool.annotations])).toEqual([
    ["items_api_search", { readOnlyHint: true }],
    ["items_api_details", { readOnlyHint: true }],
    ["items_api_read", { readOnlyHint: true }],
    ["items_api_write", { readOnlyHint: false, destructiveHint: true }],
  ]);
  const rows = ((await call("search", { query: "item", limit: 50 })) as { operations: Array<Record<string, unknown>> })
    .operations;
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
  expect(sendPath).not.toHaveBeenCalled();
  expect(authenticate).not.toHaveBeenCalled();
  expect(sent).toEqual([]);
});

it("INV-1 INV-3 INV-9: validates and admits only reviewed requests through sendPath once", async () => {
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

it("INV-3 INV-5 INV-6 INV-9: preserves admission, privacy, withheld errors and one write attempt", async () => {
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
