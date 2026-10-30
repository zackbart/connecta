import { googleBatchGuard, googleHatchBinding, googleNamedOperation } from "../src/providers/_shared/google/hatch.js";
import { googleClient } from "../src/providers/_shared/google/kit.js";
import { NODE, WORKERS } from "./fixtures/runtime-tags.js";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apiConnector } from "../src/connectors/api-connector.js";
import { ConnectorCallError } from "../src/errors.js";
import { attachCallClassification } from "../src/call-classification.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { guardedClient } from "../src/http/client.js";
import { RequestRefused, type VendorErrors } from "../src/http/errors.js";
import { DETAILS_BUDGET_BYTES, hatch, SEARCH_BUDGET } from "../src/http/hatch.js";
import { boundWarnings, WARNING_BUDGET } from "../src/http/fields.js";
import {
  googlePageToken,
  cloudflarePage,
  githubPage,
  stripePage,
  stripeBackwardPage,
  stripeSearchPage,
  stripeV2Page,
  vercelPage,
  type HatchPageAdapter,
} from "../src/http/hatch-paging.js";
import { boundCursor } from "../src/http/paging.js";
import { ContinuationBinding, ContinuationStorage } from "../src/runtime/call.js";
import { Registry } from "../src/registry.js";
import { CatalogService } from "../src/catalog-service.js";
import { runEdge } from "../src/runtime/run.js";
import { memoryStorage } from "../src/storage/memory.js";
import { restSafety, resultSafety } from "../src/http/safety.js";
import { connect, form, get, post, vendor } from "../src/http/vendor.js";
import { vendorIndex } from "../src/http/vendor-index.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import { OperationIndex, type OpenApiData } from "../src/providers/_shared/rest/operation-index.js";
import { valueSafety } from "../src/providers/_shared/rest/value-safety.js";
import { connectorContext } from "./fixtures/misc.js";
import { cloudflareIndex } from "../src/providers/cloudflare/api.js";
import { fixture as cloudflareFixture } from "../src/providers/cloudflare/fixtures.js";
import { fixture as stripeFixture } from "../src/providers/stripe/fixtures.js";
import { fixture as overflowFixture } from "../src/providers/overflow/fixtures.js";
import { fixture as vercelFixture } from "../src/providers/vercel/fixtures.js";

const NATIVE = { ...WORKERS, timeout: 30_000 };

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
  // Declared success responses: /items records (or a list of them) and the created item.
  fields: [
    ["id", "email", "token", "label", "nested", "nested.id", "nested.email"].map((path) => ({
      in: "response" as const,
      path,
    })),
    [],
    [],
    [],
    [],
    [{ in: "response", path: "id" }],
  ],
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
let storage: ReturnType<typeof memoryStorage>;
beforeEach(() => {
  sent = [];
  storage = memoryStorage();
  response = () => Response.json({ id: "i1" });
  installOwnedTransport();
  vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
    sent.push({ url: String(url), method: init.method ?? "GET", body: init.body });
    return response();
  });
});
afterEach(() => vi.unstubAllGlobals());

function setup(
  options: {
    deny?: boolean;
    writeEnabled?: boolean;
    revision?: string;
    verdicts?: Parameters<typeof hatch>[0]["verdicts"];
    pages?: Parameters<typeof hatch>[0]["pages"];
    pageCursor?: "argument" | "parameter";
    binding?: Parameters<typeof hatch>[0]["binding"];
    named?: Parameters<typeof hatch>[0]["named"];
    headers?: Parameters<typeof hatch>[0]["headers"];
    textBodies?: true;
    fieldsRoot?: string;
    data?: OpenApiData;
    context?: ReturnType<typeof connectorContext>;
    pathMatching?: "uri-template";
    maxResponseBytes?: number;
  } = {},
) {
  const index = new OperationIndex(
    { ...(options.data ?? DATA), revision: options.revision ?? (options.data ?? DATA).revision },
    { vendor: "items", title: "Items", ...(options.pathMatching ? { pathMatching: options.pathMatching } : {}) },
  );
  const reviewed = valueSafety(
    {
      title: "Items",
      operations: {
        "GET /items": { verdict: "safe", reason: "Only item metadata is returned.", keep: ["nextPageToken"] },
        "GET /blocked": { verdict: "refuse", reason: "Item access is managed by the operator." },
      },
    },
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
      maxResponseBytes: options.maxResponseBytes ?? 1024,
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
  const tools = hatch({
    name: "items",
    index,
    verdicts: options.verdicts ?? VERDICTS,
    ...(options.pages ? { pages: options.pages } : {}),
    ...(options.pageCursor ? { pageCursor: options.pageCursor } : {}),
    ...(options.binding ? { binding: options.binding } : {}),
    ...(options.named ? { named: options.named } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.textBodies ? { textBodies: options.textBodies } : {}),
    ...(options.fieldsRoot ? { fieldsRoot: options.fieldsRoot } : {}),
    ...(options.writeEnabled === undefined ? {} : { writeEnabled: options.writeEnabled }),
    connection,
  });
  const connector = tracksEveryRequest(apiConnector("items", { tools }));
  const context = options.context ?? connectorContext(storage);
  const call = (kind: string, args: Record<string, unknown>) =>
    connector.callTool(`items_api_${kind}`, args, options.context ?? connectorContext(storage));
  return { index, tools, connection, call, sendPath, authenticate, admit, context };
}

it(
  "INV-2 INV-4 INV-10: discovers hatch vocabulary through the native catalog without authenticating or sending",
  NATIVE,
  async () => {
    const { tools, authenticate, sendPath } = setup();
    const connector = apiConnector("crm", { tools });
    const registry = new Registry([connector], { storage, logger: { debug() {}, info() {}, warn() {}, error() {} } });
    const catalog = new CatalogService(registry, "https://connecta.test");
    const page = await catalog.search({ query: "touch item", safety: "approvalRequired" });
    expect(page.entries.map((entry) => entry.tool.name)).toContain("items_api_search");
    expect(authenticate).not.toHaveBeenCalled();
    expect(sendPath).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  },
);

it(
  "INV-1 INV-2 INV-4 INV-10: offers only fully determined reads as ready calls, through the caller's view",
  NODE,
  async () => {
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const searchWith = async (
      options: Parameters<typeof setup>[0] = {},
      args: Parameters<CatalogService["search"]>[0] = { query: "list items" },
      registryOptions: Partial<ConstructorParameters<typeof Registry>[1]> = {},
      view: (registry: Registry) => Registry | ReturnType<Registry["scoped"]> = (registry) => registry,
      readOnly = false,
    ) => {
      const { tools, authenticate, sendPath } = setup(options);
      const registry = new Registry([apiConnector("crm", { tools })], { storage, logger, ...registryOptions });
      const page = await new CatalogService(view(registry), "https://connecta.test", { readOnly }).search(args);
      expect(authenticate).not.toHaveBeenCalled();
      expect(sendPath).not.toHaveBeenCalled();
      return page;
    };
    const ready = {
      address: "crm.items_api_read",
      args: { path: "/items" },
      classification: "read",
      summary: "List items",
    };
    const page = await searchWith();
    expect(page.readyCalls?.map((entry) => entry.call)).toEqual([ready]);
    // The ready call is the whole call: its args alone succeed.
    const { call } = setup();
    await call("read", ready.args);
    expect(sent.map((request) => [request.method, request.url])).toEqual([["GET", "https://api.example/v1/items"]]);
    sent.length = 0;
    // A read-only endpoint still offers reads; a later page repeats nothing.
    expect((await searchWith({}, undefined, {}, undefined, true)).readyCalls?.map((entry) => entry.call)).toEqual([
      ready,
    ]);
    expect((await searchWith({}, { query: "list items", offset: 1 })).readyCalls).toBeUndefined();
    for (const [label, refused] of [
      [
        "path template",
        await searchWith({ verdicts: { ...VERDICTS, "GET /items/{item}": "read" } }, { query: "get item" }),
      ],
      ["non-GET read", await searchWith({}, { query: "query items" })],
      ["write", await searchWith({}, { query: "touch item" })],
      ["approvalRequired filter", await searchWith({}, { query: "list items", safety: "approvalRequired" })],
      ["hidden read tool", await searchWith({}, undefined, { classification: { crm: { items_api_read: "hidden" } } })],
      [
        "ungranted read tool",
        await searchWith({}, undefined, {}, (registry) =>
          registry.scoped({ connectorIds: ["crm"], toolAccess: new Map([["crm", new Set(["items_api_search"])]]) }),
        ),
      ],
      ["named tool", await searchWith({ named: { "GET /items": "list_items" } })],
      [
        "required query parameter",
        await searchWith({
          data: {
            ...DATA,
            details: DATA.details.replace('["limit","query",0,', '["limit","query",1,'),
          },
        }),
      ],
    ] as const)
      expect(refused.readyCalls, label).toBeUndefined();
    expect(sent).toEqual([]);
  },
);

it(
  "INV-1 INV-10: finds a usable refund operation and explains a refused credential operation without vendor IO",
  NODE,
  async () => {
    const connector = stripeFixture.create();
    const call = (kind: string, args: Record<string, unknown>) =>
      connector.callTool(`stripe_api_${kind}`, args, connectorContext(storage)) as Promise<any>;
    const refunds = await call("search", { query: "issue refund" });
    expect(refunds.operations).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/v1/refunds", tool: "stripe_api_write" }),
    );
    const credentials = await call("search", { query: "create customer session" });
    const refused = credentials.operations.find((op: any) => op.path === "/v1/customer_sessions");
    expect(refused).toMatchObject({ method: "POST", refusal: expect.any(String) });
    expect(refused.tool).toBeUndefined();
    await expect(call("write", { method: "POST", path: refused.path })).rejects.toMatchObject({ code: "invalid_args" });
    // Unknown resource words and prototype names must not invent an operation.
    expect(await call("search", { query: "list DNS zones" })).toMatchObject({
      operations: [],
      page: { hasMore: false },
    });
    expect(await call("search", { query: "constructor" })).toMatchObject({ operations: [] });
    expect(sent).toEqual([]);
  },
);

it(
  "INV-3 INV-5 INV-11: opts reviewed hatches into optional safe totals and construction-owned named suggestions",
  NATIVE,
  async () => {
    let total: unknown = 42;
    const adapter: HatchPageAdapter = {
      param: "limit",
      in: "query",
      decode: (value) => Number(value),
      next: () => null,
      total: () => total as number | undefined,
    };
    const ordinary = setup({
      pages: { "GET /items": { param: adapter.param, in: adapter.in, decode: adapter.decode, next: adapter.next } },
    });
    const counted = setup({ pages: { "GET /items": adapter } });
    const pageSchema = (tools: typeof counted.tools) =>
      (tools.find((tool) => tool.name === "items_api_read")!.outputSchema as any).properties.page.properties;
    expect(pageSchema(ordinary.tools)).not.toHaveProperty("total");
    expect(pageSchema(counted.tools).total).toMatchObject({ type: "integer", minimum: 0 });
    for (const value of [42, 0, undefined, null, "42", -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      total = value;
      const result = (await counted.call("read", { path: "/items", fields: ["id"] })) as any;
      expect(result.data).toEqual({ id: "i1" });
      expect(result.page).toEqual({
        hasMore: false,
        param: "limit",
        in: "query",
        ...([42, 0].includes(value as number) ? { total: value } : {}),
      });
    }
    expect(() => setup({ pages: { "GET /items": { ...adapter, total: true as never } } })).toThrow(/cursor adapter/);
    const binding = { review: "Test fixed suggestions", send: () => Effect.succeed({ status: 200, data: {} }) };
    const named = { "GET /items": "list_items" };
    expect(await setup({ named, binding }).call("details", { method: "GET", path: "/items" })).toHaveProperty(
      "named",
      "list_items",
    );
    expect(
      await setup({ named, binding: { ...binding, named: {} } }).call("details", { method: "GET", path: "/items" }),
    ).not.toHaveProperty("named");
    expect(() => setup({ named, binding: { ...binding, named: { "GET /missing": "bad" } } })).toThrow(/named tool/);
  },
);

it.each([false, true])(
  "INV-1 INV-7 INV-10: keeps vendor summaries separate from bounded refusals and reconstructs complete reasons (overlay: %s)",
  NATIVE,
  async (overlay) => {
    const reason = `${"😀".repeat(1000)} ${"Reviewed policy. ".repeat(2500)} Use the named safe alternative.`;
    const dispatchReason = overlay ? "Static refusal stays authoritative at dispatch." : reason;
    const { call, authenticate, sendPath } = setup({
      verdicts: { "GET /items": "refuse" },
      binding: {
        review: "Static refusal pagination fixture.",
        refusal: () => dispatchReason,
        ...(overlay ? { discoveryRefusal: () => reason } : {}),
        send: () => Effect.die("Must not send"),
      },
    });
    const search = (await call("search", { query: "/items", method: "GET" })) as any;
    const hit = search.operations.find((op: any) => op.path === "/items");
    expect(hit.summary).toBe("List items");
    expect(hit.refusal.length).toBeLessThanOrEqual(SEARCH_BUDGET.refusalChars);
    expect(hit.refusal).not.toMatch(/[\uD800-\uDBFF]…$/);
    expect(search.truncated).toContain("operations[0].refusal");
    const chunks: string[] = [];
    let cursor: string | undefined;
    do {
      const page = (await call("details", { method: "GET", path: "/items", ...(cursor ? { cursor } : {}) })) as any;
      expect(page.summary).toBe("List items");
      expect(page.truncated).toContain("refusal");
      expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(DETAILS_BUDGET_BYTES);
      if (page.chunk?.of === "refusal") chunks.push(page.chunk.text);
      cursor = page.page?.nextCursor;
    } while (cursor);
    expect(JSON.parse(chunks.join(""))).toBe(reason);
    await expect(call("read", { path: "/items" })).rejects.toMatchObject({
      code: "invalid_args",
      message: dispatchReason,
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(sendPath).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  },
);

it(
  "INV-1 INV-10: snapshots discovery-only refusals without changing dispatch verdicts or schema",
  WORKERS,
  async () => {
    const base = setup();
    let enabled = true;
    const discoveryRefusal = vi.fn(() => (enabled ? "Construction-only discovery restriction." : undefined));
    const restricted = setup({
      binding: {
        review: "Fixture discovery policy is separate from the reviewed dispatch table.",
        discoveryRefusal,
        send: (call) => base.connection.sendPath({ method: call.method, path: call.path, template: call.op.path }),
      },
    });
    expect(discoveryRefusal).toHaveBeenCalledTimes(restricted.index.ops.length);
    enabled = false;
    const details = (await restricted.call("details", { method: "GET", path: "/items" })) as any;
    expect(details).toMatchObject({ verdict: "refuse", summary: "List items" });
    expect(details).not.toHaveProperty("tool");
    const refused = (await restricted.call("details", { method: "GET", path: "/blocked" })) as any;
    expect(refused.refusal ?? refused.summary).toContain("Construction-only discovery restriction.");
    const search = (await restricted.call("search", { query: "/items" })) as any;
    expect(search.operations.every((op: any) => op.tool === undefined)).toBe(true);
    expect(discoveryRefusal).toHaveBeenCalledTimes(restricted.index.ops.length);
    expect(base.authenticate).not.toHaveBeenCalled();
    expect(restricted.authenticate).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    const dispatch = (tools: typeof base.tools) => tools.filter((tool) => /_api_(read|write)$/.test(tool.name));
    expect(dispatch(restricted.tools).map(({ inputSchema, outputSchema }) => ({ inputSchema, outputSchema }))).toEqual(
      dispatch(base.tools).map(({ inputSchema, outputSchema }) => ({ inputSchema, outputSchema })),
    );
    expect(await restricted.call("read", { path: "/items" })).toMatchObject({ status: 200, data: { id: "i1" } });
    await expect(restricted.call("read", { path: "/blocked" })).rejects.toMatchObject({ code: "invalid_args" });
    expect(sent).toHaveLength(1);
  },
);

it(
  "INV-10 INV-11: details lists selectable response fields in fields coordinates, capped, with a withheld hint",
  NODE,
  async () => {
    const { call, authenticate, sendPath } = setup();
    const details = (await call("details", { method: "GET", path: "/items" })) as any;
    // Every declared path is selectable. The hint names the subset the rules always withhold:
    // email is the deployment's sensitive field and token a credential name, at any depth. A
    // container is never hinted: without its withheld child it reads unchanged.
    expect(details.response).toEqual({
      anchor: "data",
      fields: ["id", "email", "token", "label", "nested", "nested.id", "nested.email"],
      withheld: ["email", "token", "nested.email"],
    });
    expect(await call("details", { method: "GET", path: "/items" })).toEqual(details);
    // A reviewed redaction that declares no hint names nothing; the hint is never a promise.
    const undeclared = resultSafety({
      reviewed: { redact: (data) => data, withholdsErrors: () => false },
      sensitiveFields: { names: ["email"], choice: "drop" },
    }).withholds({ method: "GET", template: "/items" });
    expect([undeclared(["id"]), undeclared(["token"]), undeclared(["nested", "email"])]).toEqual([false, false, true]);
    const schema = (await (async () => setup().tools.find((tool) => tool.name === "items_api_details")!)())
      .outputSchema as any;
    expect(schema.properties.response.properties.fields.description).toMatch(/Not a readability promise/);
    expect(schema.properties.response.properties.withheld.description).toMatch(
      /Best-effort hint.*unlisted path may still be withheld or redacted/,
    );
    for (const omitted of [
      { method: "POST", path: "/query" },
      { method: "GET", path: "/blocked" },
      { method: "GET", path: "/items", param: "limit" },
    ])
      expect(await call("details", omitted)).not.toHaveProperty("response");
    expect(authenticate).not.toHaveBeenCalled();
    expect(sendPath).not.toHaveBeenCalled();
    // Every advertised path is a valid fields input; withheld values never come back.
    response = () =>
      Response.json({
        id: "i1",
        email: "alice@example.com",
        token: "tok-alice-123456789",
        label: "Widget",
        nested: { id: "n1", email: "bob@example.com" },
      });
    const read = (await call("read", {
      path: "/items",
      fields: details.response.fields,
    })) as any;
    expect(read.data).toMatchObject({ id: "i1", label: "Widget", nested: { id: "n1" } });
    expect(JSON.stringify(read.data)).not.toMatch(/alice@example|bob@example|tok-alice/);

    const many = (count: number, width: number) =>
      Array.from({ length: count }, (_, at) => ({
        in: "response" as const,
        path: `f${String(at).padStart(width, "0")}`,
      }));
    const shaped = (fields: NonNullable<OpenApiData["fields"]>) => setup({ data: { ...DATA, fields } });
    const list = (await shaped([
      [
        { in: "response", path: "[].id" },
        { in: "response", path: "[].owner.name" },
      ],
    ]).call("details", { method: "GET", path: "/items" })) as any;
    // A list body anchors at each item; a root the index names only beneath it is listed too.
    expect(list.response).toEqual({ anchor: "data[]", fields: ["id", "owner", "owner.name"] });
    const capped = (await shaped([[...many(150, 3), { in: "response", path: `deep.${"x".repeat(200)}` }]]).call(
      "details",
      { method: "GET", path: "/items" },
    )) as any;
    expect(capped.response.fields).toEqual(many(100, 3).map((field) => field.path));
    expect(capped.response.omitted).toBe(52);
    const wide = (await shaped([many(60, 99)]).call("details", { method: "GET", path: "/items" })) as any;
    expect(JSON.stringify(wide.response.fields).length).toBeLessThanOrEqual(4096);
    expect(wide.response.fields).toHaveLength(39);
    expect(wide.response.omitted).toBe(21);
    await expect(
      shaped([many(150, 3)]).call("read", { path: "/items", fields: wide.response.fields.slice(0, 1) }),
    ).rejects.toThrow(/\/fields\/0: expected a path beginning with a property of/);
  },
);

it(
  "INV-3 INV-4 INV-10: binds discovery pages to callers and contracts while delivering large descriptions without IO",
  { ...NODE, timeout: 120_000 },
  async () => {
    const closed = setup({ writeEnabled: false });
    expect(closed.tools.map((tool) => tool.name)).not.toContain("items_api_write");
    const closedSearch = (await closed.call("search", { query: "create item", method: "POST" })) as {
      operations: Array<{ tool?: string; method: string; path: string }>;
    };
    expect(closedSearch.operations).toContainEqual(expect.objectContaining({ method: "POST", path: "/items" }));
    expect(
      closedSearch.operations
        .filter((row) => VERDICTS[`${row.method} ${row.path}` as keyof typeof VERDICTS] !== "read")
        .every((row) => row.tool === undefined),
    ).toBe(true);
    expect(closedSearch.operations.every((row) => row.tool !== "items_api_write")).toBe(true);
    await expect(closed.call("write", { method: "POST", path: "/items", body: { name: "alice" } })).rejects.toThrow(
      /Unknown tool/,
    );
    expect(closed.sendPath).not.toHaveBeenCalled();
    expect(closed.authenticate).not.toHaveBeenCalled();
    const verdicts = { ...VERDICTS };
    const { call, tools, index, connection, sendPath, authenticate } = setup({ verdicts });
    await expect(call("search", { query: "item", limit: 9 })).rejects.toMatchObject({ code: "invalid_args" });
    await expect(call("search", { query: "item", cursor: "e30" })).rejects.toMatchObject({ code: "invalid_args" });
    const searchPage = (await call("search", { query: "item", limit: 1 })) as { page: { nextCursor: string } };
    await expect(
      setup({ revision: "r2" }).call("search", { query: "item", cursor: searchPage.page.nextCursor }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    // Same declared label, different operation content: the old continuation is stale.
    await expect(
      setup({ data: { ...DATA, ops: [...DATA.ops].reverse() } }).call("search", {
        query: "item",
        cursor: searchPage.page.nextCursor,
      }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      apiConnector("other_items", { tools }).callTool(
        "items_api_search",
        {
          query: "item",
          cursor: searchPage.page.nextCursor,
        },
        connectorContext(storage),
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    const personal = apiConnector("items", { tools, authScope: "personal" });
    const registry = new Registry([personal], { storage, logger: connectorContext(storage).logger });
    const personalContext = (owner: string) =>
      registry.personalRegistry(owner).contextFor("items", "https://connecta.example", {});
    const alicePage = (await personal.callTool(
      "items_api_search",
      { query: "item", limit: 1 },
      personalContext("alice"),
    )) as { page: { nextCursor: string } };
    await expect(
      personal.callTool(
        "items_api_search",
        { query: "item", cursor: alicePage.page.nextCursor },
        personalContext("bob"),
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      personal.callTool(
        "items_api_search",
        { query: "item", cursor: alicePage.page.nextCursor },
        personalContext("alice"),
      ),
    ).resolves.toHaveProperty("operations");
    // A wrapper keeps the registry's configured id rather than its inner adapter id.
    const inner = apiConnector("items", { tools });
    const aliases = new Registry([{ ...inner, id: "alias_items" }], {
      storage,
      logger: connectorContext(storage).logger,
    });
    await expect(
      inner.callTool(
        "items_api_search",
        { query: "item", cursor: searchPage.page.nextCursor },
        aliases.contextFor("alias_items", "https://connecta.example", {}),
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    const originalStore = storage;
    for (const get of [
      async () => {
        throw new Error("database offline");
      },
      async () => "corrupt-private-material",
    ]) {
      storage = { ...originalStore, get };
      await expect(call("search", { query: "item", limit: 1 })).rejects.toMatchObject({
        code: "unavailable",
        retryable: true,
        message: expect.stringContaining("cursor signing key"),
      });
    }
    storage = originalStore;
    for (const offset of ["", "0", "-1", "1.5", "01", "11", "999999999999999999999"]) {
      const cursor = await runEdge(
        boundCursor
          .encode("items_api_search", { revision: await index.cursorRevision(), query: "item" }, offset)
          .pipe(
            Effect.provideService(ContinuationStorage, storage),
            Effect.provideService(ContinuationBinding, { connection: "items", principal: null }),
          ),
      );
      await expect(call("search", { query: "item", cursor })).rejects.toMatchObject({ code: "invalid_args" });
    }
    // The agent must recover a large description and every required property,
    // using only public details pages, with a bound continuation and no vendor IO.
    const description = `Reviewed ${"long contract ".repeat(4000)}😀`;
    const fields = Object.fromEntries(Array.from({ length: 240 }, (_, i) => [`field_${i}`, Schema.String]));
    const derived = vendorIndex(
      vendor(
        "contract",
        post("create", "/things", {
          payload: form(Schema.Struct({ ...fields, note: Schema.String.annotate({ description }) })),
          success: Schema.Struct({ id: Schema.String }),
        }),
      ),
      { prefix: "contract", title: "Contract", revision: "r1" },
    );
    const connector = apiConnector("contract", {
      tools: hatch({ name: "contract", index: derived, verdicts: { "POST /things": "write" }, connection }),
    });
    const properties = new Set<string>();
    const required = new Set<string>();
    let note = "";
    let cursor: string | undefined;
    let firstCursor: string | undefined;
    let pages = 0;
    do {
      const reply = (await connector.callTool(
        "contract_api_details",
        {
          method: "POST",
          path: "/things",
          ...(cursor ? { cursor } : {}),
        },
        connectorContext(storage),
      )) as any;
      expect(new TextEncoder().encode(JSON.stringify(reply)).length).toBeLessThanOrEqual(DETAILS_BUDGET_BYTES);
      // The response contract travels once, on the first page.
      if (pages === 0) expect(reply.response).toEqual({ anchor: "data", fields: ["id"] });
      else expect(reply).not.toHaveProperty("response");
      for (const name of Object.keys(reply.body?.schema?.properties ?? {})) properties.add(name);
      for (const name of reply.body?.schema?.required ?? []) required.add(name);
      if (reply.chunk) {
        expect(reply.chunk.of).toBe("body.schema.properties.note");
        note += reply.chunk.text;
      }
      cursor = reply.page?.nextCursor;
      firstCursor ??= cursor;
      expect(++pages).toBeLessThan(20);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect([...properties].sort()).toEqual(Object.keys(fields).sort());
    expect([...required].sort()).toEqual([...Object.keys(fields), "note"].sort());
    expect(JSON.parse(note)).toEqual({ type: "string", description });
    await expect(
      connector.callTool(
        "contract_api_details",
        {
          method: "POST",
          path: "/things",
          param: "note",
          cursor: firstCursor,
        },
        connectorContext(storage),
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(sendPath).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  },
);

it("INV-1 INV-3 INV-9: validates and admits only reviewed requests through sendPath once", NATIVE, async () => {
  const withheld = "https://files.example/file?signature=%5Bredacted%5D";
  const cases: Array<{
    kind: string;
    args: Record<string, unknown>;
    message?: string;
    body?: string;
    url?: string;
    data?: unknown;
    verdicts?: Parameters<typeof hatch>[0]["verdicts"];
    method?: string;
  }> = [
    // A sole reviewed read method other than GET is the default, POST and HEAD alike.
    {
      kind: "read",
      verdicts: { "POST /query": "read" },
      args: { path: "/query", body: { filter: "open" } },
      method: "POST",
      body: '{"filter":"open"}',
    },
    {
      kind: "read",
      verdicts: { "HEAD /items/{item}": "read" },
      args: { path: "/items/i1" },
      method: "HEAD",
      data: null,
    },
    {
      kind: "read",
      args: { path: "/items", query: { tag: ["b", "a"], limit: 2 } },
      url: "/items?tag=b&tag=a&limit=2",
    },
    { kind: "read", args: { method: "POST", path: "/query", body: { filter: "open" } }, body: '{"filter":"open"}' },
    { kind: "write", args: { method: "GET", path: "/touch" } },
    { kind: "write", args: { method: "DELETE", path: "/items/i1" } },
    { kind: "write", args: { method: "POST", path: "/items", body: { name: "alice" } }, body: '{"name":"alice"}' },
    {
      kind: "write",
      args: { method: "POST", path: "/form", body: { name: "alice", tag: ["a", "b"] } },
      body: "name=alice&tag=a&tag=b",
    },
    {
      kind: "write",
      args: { method: "POST", path: "/items", body: { name: "unredacted" } },
      body: '{"name":"unredacted"}',
    },
    {
      kind: "write",
      args: { method: "POST", path: "/items", body: { name: "the log says: Authorization: Bearer [redacted]" } },
      body: JSON.stringify({ name: "the log says: Authorization: Bearer [redacted]" }),
    },
    ...[
      ["[redacted]", true],
      ["pre[redacted]", false],
      ["sk_live_[redacted]", false],
      ["[redacted][redacted]", false],
      ["%5Bredacted%5D", true],
      ["%5bredacted%5d", true],
      ["%255Bredacted%255D", true],
      ["%25255Bredacted%25255D", true],
      ["&#91;redacted&#93;", true],
      ["&#x5b;redacted&#x5d;", true],
      ["&lbrack;redacted&rbrack;", true],
      ["&amp;#91;redacted&amp;#93;", true],
      ["\\[redacted\\]", true],
      ["\\u005bredacted\\u005d", true],
      ["https://x.test/a?token=[redacted]", true],
      ["https://hooks.test/[redacted]", true],
      ["Bearer [redacted]", false],
    ].flatMap(([text, whole]) => {
      const marker = String(text);
      const body = { name: marker };
      const keyed = { name: "alice", payload: { [marker]: "x" } };
      return [
        {
          kind: "write",
          args: { method: "POST", path: "/items", body },
          ...(whole ? { message: "withheld" } : { body: JSON.stringify(body) }),
        },
        {
          kind: "write",
          args: { method: "POST", path: "/items", body: keyed },
          ...(whole ? { message: "withheld" } : { body: JSON.stringify(keyed) }),
        },
        {
          kind: "write",
          args: { method: "DELETE", path: `/items/${encodeURIComponent(marker)}` },
          message: "withheld",
        },
        { kind: "write", args: { method: "DELETE", path: `/items/i_${marker}` }, message: "withheld" },
        { kind: "read", args: { path: `/items/i_${marker}` }, message: "withheld" },
        { kind: "read", args: { path: "/items", query: { tag: [marker] } }, message: "withheld" },
        { kind: "read", args: { path: "/items", query: { [marker]: "x" } }, message: "withheld" },
      ];
    }),
    { kind: "read", args: { path: "/touch" }, message: "items_api_write" },
    { kind: "write", args: { method: "GET", path: "/items" }, message: "items_api_read" },
    { kind: "read", args: { path: "/blocked" }, message: "refuses" },
    { kind: "read", args: { path: "/items/i1" }, message: "refuses" },
    { kind: "write", args: { method: "GET", path: "/blocked" }, message: "refuses" },
    { kind: "write", args: { method: "GET", path: "/items/i1" }, message: "refuses" },
    { kind: "read", args: { path: "/missing" }, message: "Nearest:" },
    { kind: "read", args: { path: "/items/../touch" }, message: "dot segment" },
    { kind: "read", args: { path: "/items?limit=1" }, message: "query" },
    // A misspelled key is caller text: the refusal names its position and the declared name it suggests.
    { kind: "read", args: { path: "/items", query: { limt: 2 } }, message: "/query/<key>: expected limit?" },
    {
      kind: "read",
      args: { path: "/items", query: { link: { nested: true } } },
      message: "/query/link: expected string",
    },
    { kind: "read", args: { path: "/items", body: {} }, message: "takes query" },
    { kind: "write", args: { method: "POST", path: "/items", body: {} }, message: "name" },
    // A write never leaves with a projection its declared response cannot satisfy.
    {
      kind: "write",
      args: { method: "POST", path: "/items", body: { name: "alice" }, fields: ["nope"] },
      message: "property of data: one of id",
    },
    { kind: "write", args: { method: "DELETE", path: "/items/i1", fields: ["id"] }, message: "declares no response" },
    { kind: "write", args: { method: "POST", path: "/upload", body: {} }, message: "multipart" },
    { kind: "read", args: { path: "/elsewhere" }, message: "different server" },
    { kind: "read", args: { method: "HEAD", path: "/items/i1" }, data: null },
    { kind: "read", args: { path: "/items", raw: true }, message: "/<key>: expected one of the accepted keys" },
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
    const { call, sendPath, authenticate } = setup(entry.verdicts ? { verdicts: entry.verdicts } : {});
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
      expect(sendPath.mock.calls[0]?.[0]).toMatchObject({ method: entry.method ?? entry.args["method"] ?? "GET" });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.url).toBe(`https://api.example/v1${entry.url ?? entry.args["path"]}`);
      expect(sent[0]?.body).toBe(entry.body);
    }
  }
  // Typed path contracts are checked before authentication on both runtimes.
  for (const schema of [
    { t: "integer" },
    { t: "integer", l: 0, u: 42 },
    { t: "integer", l: 1, u: 42 },
    { t: "integer", e: [1, 42] },
    { t: "number" },
  ]) {
    const details = JSON.parse(DATA.details);
    details.o[1] = [[["item", "path", 1, schema]], 0];
    details.o[6] = [[["item", "path", 1, schema]], 0];
    const data = { ...DATA, details: JSON.stringify(details) };
    for (const segment of [
      "0",
      "1",
      "42",
      "-1",
      "43",
      "9007199254740991",
      "-9007199254740991",
      "01",
      "-0",
      "+1",
      " 42",
      "42 ",
      "1.0",
      "1.50",
      "42.0",
      "0.0",
      "-0.0",
      "0.5",
      "-0.5",
      "42.5",
      "0x10",
      "1e3",
      " +5",
      "1e2",
      "0x2a",
      "４２",
      "．．",
      ":id",
      "<id>",
      "%34%32",
      "%2b1",
      "%20%34%32",
      "9007199254740992",
      "-9007199254740992",
      "%2e%2e",
      "..",
      "a%2Fb",
    ]) {
      const syntax = schema.t === "integer" ? /^(?:0|-?[1-9][0-9]*)$/ : /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
      const decoded = decodeURIComponent(segment);
      const canonical = syntax.test(decoded) && !Object.is(Number(decoded), -0);
      const number = Number(decodeURIComponent(segment));
      const valid =
        canonical &&
        (schema.t === "integer"
          ? Number.isSafeInteger(number)
          : Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER) &&
        (!("l" in schema) || number >= schema.l!) &&
        (!("u" in schema) || number <= schema.u!) &&
        (!("e" in schema) || schema.e!.includes(number));
      for (const kind of ["read", "write"] as const) {
        sent = [];
        const { call, authenticate, sendPath } = setup({
          data,
          verdicts: { ...VERDICTS, "GET /items/{item}": "read" },
        });
        const args = { path: `/items/${segment}`, ...(kind === "write" ? { method: "DELETE" } : {}) };
        if (valid) {
          await call(kind, args);
          expect(sent, JSON.stringify({ schema, segment, kind })).toHaveLength(1);
        } else {
          await expect(call(kind, args), JSON.stringify({ schema, segment, kind })).rejects.toMatchObject({
            code: "invalid_args",
          });
          expect(authenticate).not.toHaveBeenCalled();
          expect(sendPath).not.toHaveBeenCalled();
          expect(sent).toEqual([]);
        }
      }
    }
  }
  const enumFailure = (() => {
    try {
      return cloudflareIndex.resolve("GET", "/accounts/a/one/applications/app1/setup-flows");
    } catch (error) {
      return error;
    }
  })();
  expect(enumFailure).toMatchObject({ code: "invalid_args" });
  expect((enumFailure as Error).message).not.toContain("Integer ids");
  for (const [fixture, credential, args, type, body] of [
    ...[
      "/accounts/0123456789abcdef0123456789abcdef/workers/scripts/script_1/content/v2",
      "/accounts/0123456789abcdef0123456789abcdef/workers/dispatch/namespaces/ns_1/scripts/script_1/content",
      "/accounts/0123456789abcdef0123456789abcdef/workers/services/service_1/environments/production/content",
    ].flatMap((path) =>
      [
        "application/javascript",
        "application/javascript+module",
        "text/javascript",
        "text/x-python",
        "multipart/form-data",
        "application/octet-stream",
        "text/plain",
        "text/html",
      ].map(
        (type) =>
          [
            cloudflareFixture,
            "cf-media-token",
            { path },
            type,
            "export default { fetch() { return new Response('hello'); } }",
          ] as const,
      ),
    ),
    ...[
      "/accounts/0123456789abcdef0123456789abcdef/r2/buckets/bucket_1/objects/key_1",
      "/accounts/0123456789abcdef0123456789abcdef/storage/kv/namespaces/ns_1/values/key_1",
    ].flatMap((path) =>
      ["text/plain", "image/png", "application/x-object-data"].map(
        (type) => [cloudflareFixture, "cf-media-token", { path }, type, "stored object bytes"] as const,
      ),
    ),
    [
      cloudflareFixture,
      "cf-media-token",
      { path: "/accounts/0123456789abcdef0123456789abcdef/magic/connectors/c1/telemetry/events/1700000000.5" },
      "application/json",
      '{"id":"event_1"}',
    ],
    [stripeFixture, "sk_test_media_fixture", { path: "/v1/quotes/qt_1/pdf" }, "application/pdf", "%PDF"],
    [
      cloudflareFixture,
      "cf-media-token",
      { path: "/zones/023e105f4ecef8ad9ca31a8372d0c353/dns_records/export" },
      "text/plain",
      "a. 1 IN A 192.0.2.1",
    ],
    [
      cloudflareFixture,
      "cf-media-token",
      { path: "/accounts/0123456789abcdef0123456789abcdef/intel/indicator-feeds/1/data" },
      "text/csv",
      "id,name\n1,Alice",
    ],
    [
      cloudflareFixture,
      "cf-media-token",
      { path: "/accounts/0123456789abcdef0123456789abcdef/cloudforce-one/v2/threat-signals/feeds/feed_1/raw" },
      "application/xml",
      "<feed/>",
    ],
    [
      cloudflareFixture,
      "cf-media-token",
      {
        method: "POST",
        path: "/accounts/0123456789abcdef0123456789abcdef/analytics_engine/sql",
        body: "SELECT count() FROM events",
      },
      "application/x-ndjson; charset=utf-8",
      '{"count":3}\n',
    ],
    [
      cloudflareFixture,
      "cf-media-token",
      { path: "/accounts/0123456789abcdef0123456789abcdef/storage/kv/namespaces/ns_1/values/key_1" },
      "application/octet-stream",
      "bounded bytes",
    ],
    [
      vercelFixture,
      "vercel-media-token",
      { path: "/v1/billing/charges", query: { from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" } },
      "application/jsonl",
      '{"id":"charge_1"}\n',
    ],
  ] as const) {
    sent = [];
    response = () => new Response(body, { headers: { "content-type": type } });
    const ctx = {
      ...connectorContext(),
      credential: { get: async () => credential, getAll: async () => ({ value: credential }) },
    };
    const answer = await fixture.create("media").callTool(`${fixture.name}_api_read`, args, ctx);
    expect(answer).toMatchObject({ status: 200 });
    if (args.path.includes("script_1") || args.path.includes("key_1")) {
      const data = (answer as any).data;
      expect(typeof data === "string" ? data : atob(data.base64)).toBe(body);
    }
    expect(sent).toHaveLength(1);
  }
  const refund = overflowFixture.create("media");
  for (const [type, body, status, accepted] of [
    ["application/json", '"Refund initiated"', 202, true],
    ["text/plain; charset=utf-8", "Refund initiated", 202, true],
    ["text/html", "Refund initiated", 202, false],
    ["application/octet-stream", "Refund initiated", 202, false],
    ["application/pdf", "Refund initiated", 202, false],
    ["application/json", '{"ok":true}', 202, false],
    ["text/plain", '{"ok":true}', 202, false],
    ["text/html", '{"ok":true}', 202, false],
    ["application/problem+json", '"Refund initiated"', 202, false],
    ["application/json", "", 202, true],
    ["application/json", null, 204, true],
    ["text/html", "", 200, true],
  ] as const) {
    sent = [];
    response = () => new Response(body, { status, headers: { "content-type": type } });
    const values = { clientId: "media-client", apiKey: "overflow-media-key" };
    const ctx = { ...connectorContext(), credential: { get: async () => values.apiKey, getAll: async () => values } };
    attachCallClassification(ctx, "write");
    const promise = refund.callTool(
      "overflow_api_write",
      { method: "POST", path: "/contributions/a143db98-198a-42ab-a2b0-5fcb2a18bfbb/initiate-refund" },
      ctx,
    );
    if (accepted) await expect(promise).resolves.toEqual({ status, data: body ? "Refund initiated" : null });
    else {
      await expect(promise).rejects.toMatchObject({
        code: "connector_call_failed",
        writeOutcome: "unknown",
        retryable: false,
        message: expect.stringContaining("check the target before repeating"),
      });
      if (body?.startsWith("{"))
        await expect(promise).rejects.toMatchObject({ message: expect.not.stringContaining("unexpected text/HTML") });
    }
    expect(sent).toHaveLength(1);
  }
  for (const path of [
    "/accounts/0123456789abcdef0123456789abcdef/r2/buckets/bucket_1/objects/key_1",
    "/accounts/0123456789abcdef0123456789abcdef/storage/kv/namespaces/ns_1/values/key_1",
  ]) {
    for (const type of ["application/json", "application/problem+json", "text/plain"]) {
      sent = [];
      response = () =>
        new Response('{"password":"stored-password","apiKey":"stored-key","token":"cf-media-token"}', {
          headers: { "content-type": type },
        });
      const ctx = {
        ...connectorContext(),
        credential: { get: async () => "cf-media-token", getAll: async () => ({ value: "cf-media-token" }) },
      };
      const answer = (await cloudflareFixture.create("media").callTool("cloudflare_api_read", { path }, ctx)) as any;
      expect(JSON.stringify(answer)).not.toContain(btoa("cf-media-token"));
      if (type !== "text/plain")
        expect(answer.data).toEqual({ password: "[redacted]", apiKey: "[redacted]", token: "[redacted]" });
      else expect(atob(answer.data.base64)).not.toContain("cf-media-token");
      expect(sent).toHaveLength(1);
    }
  }
  // Fold the opt-in page adapters into the existing native request matrix.
  const pageData = (param: string, at: "query" | "body" = "query"): OpenApiData => {
    const details = JSON.parse(DATA.details);
    if (at === "query")
      details.o[0][0].push([param, "query", 0, { t: param === "page" || param === "until" ? "integer" : "string" }]);
    else {
      details.o[4][1][1].p[param] = { t: "string" };
      details.o[4][1][1].p["extra"] = { t: "object", x: 1 };
    }
    // A reviewed POST with the identical request contract isolates method binding.
    details.o[5] = structuredClone(details.o[0]);
    return {
      ...DATA,
      details: JSON.stringify(details),
      fields: DATA.ops.map(() =>
        ["id", "data", "has_more", "result_info", "pagination"].map((path) => ({ in: "response", path })),
      ),
    };
  };
  // Google's opt-in wire mask preserves protocol metadata independently of
  // Connecta fields, including on an empty intermediate page.
  const batchReview = { kinds: ["insertText"], revision: true };
  expect(
    googleBatchGuard(
      { requests: [{ insertText: { text: "ok" } }], writeControl: { requiredRevisionId: "r1" } },
      batchReview,
    ),
  ).toBeUndefined();
  for (const body of [
    { requests: [{ insertText: {} }] },
    { requests: [{ insertText: {}, deleteContentRange: {} }], writeControl: { requiredRevisionId: "r1" } },
    { requests: [{ previewKind: {} }], writeControl: { requiredRevisionId: "r1" } },
  ])
    expect(googleBatchGuard(body, batchReview)).toBeDefined();
  const googleData = pageData("pageToken");
  const googleDetails = JSON.parse(googleData.details);
  googleDetails.o[0][0].push(["fields", "query", 0, { t: "string" }]);
  googleDetails.o[5] = JSON.parse(DATA.details).o[5];
  const google = setup({
    pathMatching: "uri-template",
    data: { ...googleData, details: JSON.stringify(googleDetails) },
    pages: { "GET /items": googlePageToken },
    pageCursor: "argument",
  });
  const wrappedRequests: string[] = [];
  let repeatWrappedSend = false;
  const googleTools = hatch({
    name: "google",
    index: google.index,
    verdicts: { "GET /items": "read", "POST /items": "write" },
    pages: { "GET /items": googlePageToken },
    pageCursor: "argument",
    binding: googleHatchBinding(google.connection, {
      index: google.index,
      review: "Fixture: JSON below a fixed Google root, delegated grant and connection safety.",
      wrapSend: (call, send) => {
        wrappedRequests.push(call.path);
        // Mutating the detached view cannot change the admitted wire request.
        Object.assign(call, { path: "/blocked" });
        return Effect.gen(function* () {
          const answer = yield* send();
          if (repeatWrappedSend) yield* send();
          return { ...answer, warnings: ["The secondary save was not confirmed."] };
        });
      },
    }),
    connection: google.connection,
  });
  const googleConnector = tracksEveryRequest(apiConnector("google", { tools: googleTools }));
  const googleCall = (args: Record<string, unknown>) =>
    googleConnector.callTool("google_api_read", args, connectorContext(storage));
  // An indexed operation without an admission verdict never reaches a send wrapper.
  const beforeUnadmitted = sent.length;
  await expect(googleCall({ path: "/blocked" })).rejects.toMatchObject({ code: "invalid_args" });
  expect(wrappedRequests).toEqual([]);
  expect(sent).toHaveLength(beforeUnadmitted);
  expect(google.authenticate).not.toHaveBeenCalled();
  response = () => Response.json({ data: [], nextPageToken: "next-token" });
  const firstGoogle = (await googleCall({ path: "/items", query: { fields: "data(id)" }, fields: ["data"] })) as any;
  expect(firstGoogle).toMatchObject({ data: { data: [] }, page: { hasMore: true, param: "pageToken", in: "query" } });
  expect(firstGoogle.warnings).toEqual(["The secondary save was not confirmed."]);
  expect(new URL(sent.at(-1)!.url).pathname).toBe("/v1/items");
  expect(new URL(sent.at(-1)!.url).searchParams.get("fields")).toBe("data(id),nextPageToken");
  response = () => Response.json({ data: [] });
  expect(
    await googleCall({
      path: "/items",
      query: { fields: "data(id)" },
      fields: ["data"],
      cursor: firstGoogle.page.nextCursor,
    }),
  ).toMatchObject({ page: { hasMore: false } });
  expect(new URL(sent.at(-1)!.url).searchParams.get("pageToken")).toBe("next-token");
  expect(wrappedRequests).toEqual(["/items", "/items"]);
  repeatWrappedSend = true;
  const beforeRepeat = sent.length;
  await expect(
    googleConnector.callTool(
      "google_api_write",
      { method: "POST", path: "/items", body: { name: "alice" } },
      connectorContext(storage),
    ),
  ).rejects.toMatchObject({ code: "connector_call_failed", writeOutcome: "unknown", retryable: false });
  expect(sent).toHaveLength(beforeRepeat + 1);
  repeatWrappedSend = false;
  for (const args of [
    { path: "/items", query: { pageToken: "raw" } },
    { path: "/items", query: { fields: "data(" } },
    { path: "/items", query: { fields: "data(id)name" } },
    { path: "/items", query: { userId: "bob" } },
    { path: "/items", fields: ["missing"] },
  ]) {
    const before = sent.length;
    google.authenticate.mockClear();
    await expect(googleCall(args)).rejects.toMatchObject({ code: "invalid_args" });
    expect(sent).toHaveLength(before);
    expect(google.authenticate).not.toHaveBeenCalled();
  }
  for (const token of [3, null, {}, "https://other.example/next", "[redacted]"]) {
    response = () => Response.json({ nextPageToken: token });
    await expect(googleCall({ path: "/items" })).rejects.toMatchObject({ code: "connector_call_failed" });
  }
  for (const token of [undefined, ""]) {
    response = () => Response.json({ nextPageToken: token });
    expect(await googleCall({ path: "/items" })).toMatchObject({ page: { hasMore: false } });
  }
  const collisionIndex = new OperationIndex(
    {
      ...DATA,
      ops: [...DATA.ops, ["GET", "/items/search", "LiteralSearch", "Search", 0]],
      details: JSON.stringify({ d: [], o: Array(DATA.ops.length + 1).fill(0) }),
    },
    { vendor: "google", title: "Google", pathMatching: "uri-template" },
  );
  expect(() => googleNamedOperation(collisionIndex, "GET", "/items/search", "/items/{item}")).toThrow(
    "different operation",
  );
  expect(() => googleNamedOperation(collisionIndex, "GET", "/items/%73earch", "/items/{item}")).toThrow(
    "different operation",
  );
  googleNamedOperation(collisionIndex, "GET", "/items/ordinary", "/items/{item}");
  const defaults = setup();
  expect(() => googleClient(google.connection, google.index)).not.toThrow();
  expect(() => googleClient(google.connection, undefined as never)).toThrow("reviewed operation index");
  expect(() =>
    googleHatchBinding(google.connection, { review: "Missing index" } as Parameters<typeof googleHatchBinding>[1]),
  ).toThrow("reviewed operation index");
  expect(() => googleClient(defaults.connection, defaults.index)).toThrow("uri-template");
  expect(() => googleHatchBinding(defaults.connection, { index: defaults.index, review: "Refuse defaults" })).toThrow(
    "uri-template",
  );
  const binding = googleHatchBinding(google.connection, { index: google.index, review: "Canonical paths only" });
  expect(() =>
    hatch({ name: "wrong", index: defaults.index, verdicts: {}, connection: defaults.connection, binding }),
  ).toThrow("reviewed operation index");
  for (const path of ["/files/%67enerateCseToken", "/forms/f%3AsetPublishSettings"])
    expect(
      binding.refuse!({ path, method: "GET", query: {}, params: {}, body: undefined, op: google.index.ops[0]! }),
    ).toContain("literally");
  expect(googlePageToken.prepareQuery!({ fields: "data(id),nextPageToken" })).toEqual({
    fields: "data(id),nextPageToken",
  });
  expect(googlePageToken.prepareQuery!({ fields: "data/nextPageToken" })).toEqual({
    fields: "data/nextPageToken,nextPageToken",
  });
  for (const fields of ["nextPageToken/x", "nextPageToken(x)", "data(id),nextPageToken/x"])
    expect(googlePageToken.prepareQuery!({ fields })).toEqual({ fields: `${fields},nextPageToken` });
  for (const row of [
    {
      adapter: stripePage,
      first: { data: [{ id: "last-id" }], has_more: true },
      last: { data: [], has_more: false },
      raw: "last-id",
    },
    {
      adapter: cloudflarePage,
      first: { result_info: { page: 1, total_pages: 2 } },
      last: { result_info: { page: 2, total_pages: 2 } },
      raw: "2",
    },
    {
      adapter: cloudflarePage,
      first: { result_info: { page: 1, total_count: 3, per_page: 2, count: 2 } },
      last: { result_info: { page: 2, total_count: 3, per_page: 2, count: 1 } },
      raw: "2",
    },
    {
      adapter: cloudflarePage,
      first: { result_info: { page: 1, per_page: 2, count: 2 } },
      last: { result_info: { page: 2, per_page: 2, count: 1 } },
      raw: "2",
    },
    {
      adapter: vercelPage,
      first: { pagination: { next: 1720000000 } },
      last: { pagination: { next: null } },
      raw: "1720000000",
    },
    {
      adapter: vercelPage,
      first: { pagination: { next: "00123" } },
      last: { pagination: { next: null } },
      raw: "00123",
    },
    {
      adapter: githubPage("https://api.example/v1"),
      first: [{ id: "i1" }],
      last: [],
      raw: "2",
      link: '<https://api.example/repositories/1300192/items?tag=a%20b&tag=active&limit=2&page=2>; rel="next", <https://api.example/v1/items?page=5>; rel="last"',
    },
    {
      adapter: githubPage("https://api.example/v1"),
      first: [{ id: "i1" }],
      last: [],
      raw: "2",
      link: "<https://api.example/repositories/1300192/items?page=2&limit=2&tag=a+b&tag=active>; rel=next",
    },
  ]) {
    const { adapter } = row;
    const data = pageData(adapter.param);
    const paged = setup({ data, pages: { "GET /items": adapter } });
    sent = [];
    response = () => Response.json(row.first, { headers: "link" in row ? { link: row.link! } : {} });
    const args = { path: "/items", query: { limit: 2, tag: ["active", "a b"] }, fields: ["id"] };
    const first = (await paged.call("read", args)) as any;
    expect(first.page).toEqual({ hasMore: true, nextCursor: expect.any(String), param: adapter.param, in: "query" });
    expect(JSON.parse(atob(first.page.nextCursor.replace(/-/g, "+").replace(/_/g, "/")))).toMatchObject({
      v: 2,
      m: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(first.page.nextCursor).not.toBe(row.raw);
    expect(first.data).toEqual(Array.isArray(row.first) ? [{ id: "i1" }] : {});
    // A continuation belongs to the path, method, filters, fields and revision.
    for (const changed of [
      { ...args, query: { ...args.query, tag: ["a b", "active"], [adapter.param]: first.page.nextCursor } },
      { ...args, query: { tag: ["other"], [adapter.param]: first.page.nextCursor } },
      { ...args, path: "/items/other", query: { tag: ["active"], [adapter.param]: first.page.nextCursor } },
      { ...args, fields: ["data"], query: { tag: ["active"], [adapter.param]: first.page.nextCursor } },
      { ...args, query: { tag: ["active"], [adapter.param]: "plain-vendor-cursor" } },
      { ...args, query: { tag: ["active"], [adapter.param]: 2 } },
    ])
      await expect(paged.call("read", changed)).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      paged.call("write", {
        ...args,
        method: "GET",
        query: { ...args.query, [adapter.param]: first.page.nextCursor },
      }),
    ).rejects.toMatchObject({
      code: "invalid_args",
      message: expect.stringContaining("must be called with items_api_read"),
    });
    for (const replay of [
      { data: { ...data, revision: "r2" }, method: "GET" },
      {
        data: {
          ...data,
          ops: data.ops.map((op, position) =>
            position === 0 ? ([op[0], op[1], op[2], "Changed contract content", op[4]] as const) : op,
          ),
        },
        method: "GET",
      },
      { data, method: "POST" },
    ]) {
      const other = setup({
        data: replay.data,
        context: paged.context,
        verdicts: { ...VERDICTS, "POST /items": "read" },
        pages: { "GET /items": adapter, "POST /items": adapter },
      });
      await expect(
        other.call("read", {
          ...args,
          method: replay.method,
          query: { ...args.query, [adapter.param]: first.page.nextCursor },
        }),
      ).rejects.toMatchObject({ code: "invalid_args" });
      expect(other.sendPath).not.toHaveBeenCalled();
      expect(other.authenticate).not.toHaveBeenCalled();
    }
    expect(sent).toHaveLength(1);
    response = () => Response.json(row.last);
    const last = (await paged.call("read", {
      ...args,
      query: { tag: ["active", "a b"], limit: 2, [adapter.param]: first.page.nextCursor },
    })) as any;
    expect(last.page).toEqual({ hasMore: false, param: adapter.param, in: "query" });
    expect(new URL(sent[1]!.url).searchParams.get(adapter.param)).toBe(row.raw);
    expect(new URL(sent[1]!.url).pathname).toBe("/v1/items");
  }
  // A binding replaces neither guard unless it explicitly owns that check.
  for (const allowOtherServers of [false, true]) {
    for (const allowOtherBodyTypes of [false, true]) {
      const send = vi.fn(() => Effect.succeed({ status: 200, data: { id: "bound" } }));
      const bound = setup({
        binding: {
          review: "Fixture routing and multipart framing, independently opted in.",
          send,
          ...(allowOtherServers ? { allowOtherServers: true as const } : {}),
          ...(allowOtherBodyTypes ? { allowOtherBodyTypes: true as const } : {}),
        },
      });
      for (const [allowed, kind, args, message] of [
        [allowOtherServers, "read", { path: "/elsewhere" }, "different server"],
        [allowOtherBodyTypes, "write", { method: "POST", path: "/upload", body: { file: "bytes" } }, "multipart"],
      ] as const) {
        send.mockClear();
        if (allowed) {
          expect(await bound.call(kind, args)).toEqual({ status: 200, data: { id: "bound" } });
          expect(send).toHaveBeenCalledTimes(1);
        } else {
          await expect(bound.call(kind, args)).rejects.toMatchObject({
            code: "invalid_args",
            message: expect.stringContaining(message),
          });
          expect(send).not.toHaveBeenCalled();
        }
        expect(bound.sendPath).not.toHaveBeenCalled();
        expect(bound.authenticate).not.toHaveBeenCalled();
      }
    }
  }
  // Size-cut metadata and warnings are opt-in, for both result and catalog compatibility.
  for (const enabled of [false, true]) {
    const bound = setup({
      binding: {
        review: "Fixture supplies reviewed size-cut paths after safe content framing.",
        ...(enabled ? { truncated: true as const, warnings: true as const } : {}),
        send: () =>
          Effect.succeed({
            status: 200,
            data: { id: "safe", label: "unused" },
            truncated: ["data.id"],
            warnings: ["A secondary save is unconfirmed."],
          }),
      },
    });
    for (const [kind, args] of [
      ["read", { path: "/items" }],
      ["write", { method: "POST", path: "/items", body: { name: "alice" } }],
    ] as const) {
      expect(await bound.call(kind, { ...args, fields: ["id"] })).toEqual({
        status: 200,
        data: { id: "safe" },
        ...(enabled ? { truncated: ["data.id"], warnings: ["A secondary save is unconfirmed."] } : {}),
      });
    }
  }
  // A separate cursor preserves raw first-request record anchors and keeps
  // every returned continuation signed, including reverse/search/v2 paging.
  for (const row of [
    {
      adapter: stripePage,
      param: "starting_after",
      first: { data: [{ id: "first-id" }, { id: "last-id" }], has_more: true },
      last: { data: [], has_more: false },
      raw: "last-id",
      anchor: "initial-id",
    },
    {
      adapter: stripeBackwardPage,
      param: "ending_before",
      first: { data: [{ id: "first-id" }, { id: "last-id" }], has_more: true },
      last: { data: [], has_more: false },
      raw: "first-id",
      anchor: "initial-id",
    },
    {
      adapter: stripeSearchPage,
      param: "page",
      first: { data: [], has_more: true, next_page: "next-search" },
      last: { has_more: false },
      raw: "next-search",
    },
    {
      adapter: stripeV2Page,
      param: "page",
      first: { data: [], next_page_url: "https://api.stripe.com/items?page=next-v2" },
      last: { next_page_url: null },
      raw: "next-v2",
    },
  ]) {
    const details = JSON.parse(DATA.details);
    for (const param of ["starting_after", "ending_before", "page"])
      details.o[0][0].push([param, "query", 0, { t: "string" }]);
    const data = { ...DATA, details: JSON.stringify(details) };
    const adapters = row.param === "page" ? row.adapter : [stripePage, stripeBackwardPage];
    const paged = setup({ data, pageCursor: "argument", pages: { "GET /items": adapters } });
    sent = [];
    response = () => Response.json(row.first);
    const query = { limit: 2, tag: ["active", "a b"] };
    const first = (await paged.call("read", {
      path: "/items",
      query: { ...query, ...("anchor" in row ? { [row.param]: row.anchor } : {}) },
      fields: ["id"],
    })) as any;
    expect(first.page).toMatchObject({
      hasMore: true,
      param: row.param,
      in: "query",
      nextCursor: expect.any(String),
    });
    if (row.param !== "page") {
      for (const param of ["starting_after", "ending_before"]) {
        await expect(
          paged.call("read", { path: "/items", query: { ...query, [param]: first.page.nextCursor } }),
        ).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining("top-level cursor") });
      }
    }
    await expect(
      paged.call("read", { path: "/items/nonpaged", method: "HEAD", cursor: first.page.nextCursor }),
    ).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining("does not page") });
    for (const invalid of [
      { path: "/items", query, fields: ["id"], cursor: row.raw },
      { path: "/items", query: { ...query, [row.param]: row.raw }, fields: ["id"], cursor: first.page.nextCursor },
      { path: "/items", query: { ...query, tag: ["other"] }, fields: ["id"], cursor: first.page.nextCursor },
      ...(row.param !== "page"
        ? [{ path: "/items", query: { ...query, starting_after: "a", ending_before: "b" } }]
        : [{ path: "/items", query: { ...query, page: row.raw } }]),
    ])
      await expect(paged.call("read", invalid)).rejects.toMatchObject({ code: "invalid_args" });
    expect(sent).toHaveLength(1);
    response = () => Response.json(row.last);
    const last = (await paged.call("read", {
      path: "/items",
      query,
      fields: ["id"],
      cursor: first.page.nextCursor,
    })) as any;
    expect(last.page).toEqual({ hasMore: false, param: row.param, in: "query" });
    expect(new URL(sent.at(-1)!.url).searchParams.get(row.param)).toBe(row.raw);
    expect(new URL(sent.at(-1)!.url).searchParams.getAll("tag")).toEqual(["active", "a b"]);
    const count = sent.length;
    await expect(
      apiConnector("other", { tools: paged.tools }).callTool(
        "items_api_read",
        { path: "/items", query, fields: ["id"], cursor: first.page.nextCursor },
        connectorContext(storage),
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(sent).toHaveLength(count);
    if (row.adapter === stripeV2Page) {
      response = () => Response.json({ id: "kept", next_page_url: "/items?page=next-v2&limit=20" });
      const incomplete = (await paged.call("read", { path: "/items" })) as any;
      expect(incomplete).toMatchObject({
        data: { id: "kept" },
        page: { hasMore: true, param: "page", in: "query" },
      });
      expect(incomplete.page).not.toHaveProperty("nextCursor");
      expect(new URL(sent.at(-1)!.url).search).toBe("");
    }
  }
  // Configured query routing participates in validation and cursor identity.
  const routedTransport = setup();
  let routingDefault = "scope-a";
  const routed = setup({
    data: pageData("until"),
    pages: { "GET /items": { ...vercelPage, initialAnchor: true } },
    binding: {
      review: "Fixture routing default resolved before signed continuation binding.",
      query: (call) => ({ ...call.query, tag: call.query["tag"] ?? [routingDefault] }),
      send: (call, options) =>
        routedTransport.connection.sendPath(
          {
            method: call.method,
            path: call.path,
            template: call.op.path,
            query: Object.entries(call.query).flatMap(([k, v]) =>
              (Array.isArray(v) ? v : [v]).map((x) => [k, String(x)] as const),
            ),
          },
          options,
        ),
    },
  });
  response = () => Response.json({ pagination: { next: 123 } });
  const routedFirst = (await routed.call("read", { path: "/items", query: { until: 500 } })) as any;
  expect(new URL(sent.at(-1)!.url).searchParams.get("until")).toBe("500");
  expect(new URL(sent.at(-1)!.url).searchParams.get("tag")).toBe("scope-a");
  routingDefault = "scope-b";
  const routedSends = sent.length;
  await expect(
    routed.call("read", { path: "/items", query: { until: routedFirst.page.nextCursor } }),
  ).rejects.toMatchObject({ code: "invalid_args" });
  expect(sent).toHaveLength(routedSends);
  response = () => Response.json({ pagination: { next: null } });
  await routed.call("read", { path: "/items", query: { tag: ["scope-a"], until: routedFirst.page.nextCursor } });
  expect(new URL(sent.at(-1)!.url).searchParams.get("until")).toBe("123");
  const hosting = vercelFixture.create();
  const hostingContext = {
    ...connectorContext(storage),
    credential: { get: async () => "hosting-key", getAll: async () => ({ value: "hosting-key" }) },
  };
  // Every pinned framed billing/command success remains rows, including a dispatched command write.
  for (const [method, path, media, body] of [
    ["GET", "/v1/billing/charges", "application/jsonl", undefined],
    ["GET", "/v1/billing/contract-commitments", "application/jsonl", undefined],
    ["GET", "/v2/sandboxes/sessions/sbx_1/cmd/cmd_1/logs", "application/x-ndjson", undefined],
    ["POST", "/v2/sandboxes/sessions/sbx_1/cmd", "application/x-ndjson", { command: "echo", args: ["hello"] }],
  ] as const) {
    sent = [];
    const rows = [
      { id: "row_1", message: "hello" },
      { id: "row_2", message: "done" },
    ];
    response = () =>
      new Response(rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { headers: { "content-type": media } });
    const result = (await hosting.callTool(
      method === "GET" ? "vercel_api_read" : "vercel_api_write",
      {
        method,
        path,
        ...(path === "/v1/billing/charges"
          ? { query: { from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z" } }
          : {}),
        ...(body ? { body } : {}),
      },
      hostingContext,
    )) as any;
    expect(result.data, `${method} ${path}`).toEqual(rows);
    expect(sent).toHaveLength(1);
  }
  // Body continuations use the same binding, without ever dispatching the opaque bytes.
  const bodyAdapter: HatchPageAdapter = { ...stripePage, param: "after", in: "body" };
  const bodyPaged = setup({ data: pageData("after", "body"), pages: { "POST /query": bodyAdapter } });
  response = () => Response.json({ data: [{ id: "next-body" }], has_more: true });
  const bodyFirst = (await bodyPaged.call("read", {
    method: "POST",
    path: "/query",
    body: { filter: "open", extra: { a: { b: 1, c: 2 }, z: 0 } },
  })) as any;
  response = () => Response.json({ has_more: false });
  await bodyPaged.call("read", {
    method: "POST",
    path: "/query",
    body: { extra: { z: 0, a: { c: 2, b: 1 } }, after: bodyFirst.page.nextCursor, filter: "open" },
  });
  expect(JSON.parse(sent.at(-1)!.body as string)).toEqual({
    filter: "open",
    extra: { a: { b: 1, c: 2 }, z: 0 },
    after: "next-body",
  });
  response = () => Response.json({ data: [{ id: "next-body" }], has_more: true });
  const emptyBody = (await bodyPaged.call("read", { method: "POST", path: "/query" })) as any;
  response = () => Response.json({ has_more: false });
  await bodyPaged.call("read", { method: "POST", path: "/query", body: { after: emptyBody.page.nextCursor } });
  expect(sent.at(-1)!.body).toBe('{"after":"next-body"}');
  // Malformed metadata is a bounded failure; no invented cursor and no extra request.
  for (const [adapter, data] of [
    [stripePage, { has_more: true, data: [] }],
    [cloudflarePage, { result_info: { page: 1, total_pages: "two" } }],
    [vercelPage, { pagination: { next: {} } }],
  ] as const) {
    const paged = setup({ data: pageData(adapter.param), pages: { "GET /items": adapter } });
    sent = [];
    response = () => Response.json(data);
    await expect(paged.call("read", { path: "/items" })).rejects.toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
    expect(sent).toHaveLength(1);
  }
  const links = setup({ data: pageData("page"), pages: { "GET /items": githubPage("https://api.example/v1") } });
  for (const link of [
    '<https://other.example/v1/items?page=2>; rel="next"',
    '<https://api.example/v1/items?page=2&secret=stolen>; rel="next"',
    '<https://api.example/v1/items?page=2&tag=extra>; rel="next"',
    '<https://api.example/v1/items?page=2&page=3>; rel="next"',
    '<https://api.example/v1/items?page=2#fragment>; rel="next"',
    "<https://api.example/v1/items?page=2>; rel=next, <https://api.example/v1/items?page=3>; rel=next",
  ]) {
    response = () => Response.json([], { headers: { link } });
    await expect(links.call("read", { path: "/items" })).rejects.toMatchObject({ code: "connector_call_failed" });
  }
  response = () =>
    Response.json([], {
      headers: { link: "<https://api.example/repositories/1300192/items?page=2&tag=duplicate>; rel=next" },
    });
  await expect(
    links.call("read", { path: "/items", query: { tag: ["duplicate", "duplicate"] } }),
  ).rejects.toMatchObject({ code: "connector_call_failed" });
  response = () => Response.json({ result_info: { cursor: "opaque" } });
  const cursorStyle = setup({
    data: pageData("page"),
    pages: {
      "GET /items": {
        ...cloudflarePage,
        cursorInputMessage: "Omit page on the first call; pass page.nextCursor as cursor in query.page.",
      },
    },
    pageCursor: "parameter",
  });
  for (const page of [1, "1", "vendor-next"]) {
    await expect(cursorStyle.call("read", { path: "/items", query: { page } })).rejects.toMatchObject({
      code: "invalid_args",
      message: expect.stringContaining("Omit page on the first call"),
    });
  }
  expect(cursorStyle.sendPath).not.toHaveBeenCalled();
  expect(cursorStyle.authenticate).not.toHaveBeenCalled();
  expect(await cursorStyle.call("read", { path: "/items" })).not.toHaveProperty("page");
  expect(() =>
    githubPage("https://api.example").next([], {
      path: "/items",
      query: { nested: { key: "value" } },
      headers: { link: "<https://api.example/items?page=2&nested=%5Bobject+Object%5D>; rel=next" },
    }),
  ).toThrow();
  // Optional vendor framing keeps resolution, fields and closed-header checks before dispatch.
  const framedCalls: unknown[] = [];
  const framedDetails = JSON.parse(DATA.details);
  framedDetails.o[4] = [[], ["text/plain", { t: "string" }]];
  const framed = setup({
    data: {
      ...DATA,
      details: JSON.stringify(framedDetails),
      fields: DATA.ops.map(() => [{ in: "response" as const, path: "result[].id" }]),
    },
    fieldsRoot: "result",
    textBodies: true,
    headers: { "x-region": { description: "Reviewed region.", values: ["eu", "us"] } },
    binding: {
      review: "Test deployment defaults and text framing.",
      allowOtherBodyTypes: true,
      path: (path) => path.replace("{item}", "i1"),
      prepareBody: (body) => (Array.isArray(body) ? body.map((row) => JSON.stringify(row)).join("\n") : body),
      send: (call) => {
        framedCalls.push(call);
        return Effect.succeed({ status: 200, data: { result: [{ id: "i1", email: "safe" }] } });
      },
    },
  });
  await expect(framed.call("write", { method: "DELETE", path: "/items/{item}", fields: ["id"] })).rejects.toThrow(
    "result[].id",
  );
  await expect(framed.call("read", { path: "/items", headers: { "x-region": "elsewhere" } })).rejects.toThrow();
  expect(framedCalls).toHaveLength(0);
  expect(
    await framed.call("write", {
      method: "DELETE",
      path: "/items/{item}",
      headers: { "x-region": "eu" },
      fields: ["result[].id"],
    }),
  ).toEqual({ status: 200, data: { result: [{ id: "i1" }] } });
  expect(framedCalls).toMatchObject([{ path: "/items/i1", headers: { "x-region": "eu" } }]);
  for (const body of ["SELECT 1", [{ id: "i1" }]]) await framed.call("read", { method: "POST", path: "/query", body });
  expect(framedCalls.slice(1)).toMatchObject([{ body: "SELECT 1" }, { body: '{"id":"i1"}' }]);
  await expect(framed.call("read", { method: "POST", path: "/query", body: [{ id: "[redacted]" }] })).rejects.toThrow(
    "withheld",
  );
  expect(framedCalls).toHaveLength(3);
});

it("INV-5: bounds fields miss warnings and never echoes response keys", NODE, async () => {
  // A 220 KB key in an open map, missed by all 50 fields entries, once produced about 11 MB of warnings.
  const huge = `zz_${"k".repeat(220_000)}`;
  const { call } = setup({ maxResponseBytes: 1_000_000 });
  response = () => Response.json({ id: "i1", label: { [huge]: 1 }, nested: { [huge]: 1 } });
  const fields = Array.from({ length: 50 }, (_, at) => (at % 2 ? "label.zz_missing" : "nested.zz_missing"));
  const result = (await call("read", { path: "/items", fields })) as { warnings: string[] };
  expect(result.warnings).toHaveLength(WARNING_BUDGET.warnings + 1);
  expect(result.warnings.at(-1)).toBe(`${50 - WARNING_BUDGET.warnings} more warnings omitted.`);
  expect(result.warnings.every((warning) => warning.length <= WARNING_BUDGET.chars)).toBe(true);
  expect(result.warnings.join("").length).toBeLessThanOrEqual(WARNING_BUDGET.totalChars);
  expect(JSON.stringify(result)).not.toContain("zz_k");
  // Long warnings are cut, reviewed ones included, within the same total.
  expect(boundWarnings(Array.from({ length: 30 }, () => "w".repeat(2_000)))).toEqual([
    ...Array.from({ length: 7 }, () => `${"w".repeat(WARNING_BUDGET.chars - 1)}…`),
    "23 more warnings omitted.",
  ]);
  // A cut never splits a surrogate pair.
  const [cut] = boundWarnings([`${"a".repeat(WARNING_BUDGET.chars - 2)}😀${"b".repeat(10)}`]);
  expect(cut).toBe(`${"a".repeat(WARNING_BUDGET.chars - 2)}…`);
  expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
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
    // A declared field the privacy projection dropped narrows to nothing and is reported, never refused;
    // an empty list accepts valid fields without a report.
    {
      args: { path: "/items", fields: ["email", "id"] },
      data: { id: "i1", email: "private" },
      expected: { id: "i1" },
      warnings: [
        "fields/0 matched nothing in this response after value safety and privacy filtering, at segment 1; declared there: id, email, token, label, nested.",
      ],
    },
    { args: { path: "/items", fields: ["id"] }, data: [], expected: [] },
    // The pinned index declares roots only, so a nested miss is reported with the properties the
    // contract declares where matching stopped, never refused and never the response's own keys:
    // in an open map those are data. A path past a scalar keeps it whole, and a path any listed
    // item matched is no miss.
    {
      args: { path: "/items", fields: ["id.zz_deeper", "nested.zz_nope"] },
      data: { id: "i1", nested: { id: "i2", email: "private", zz_customer_key: "v" } },
      expected: { id: "i1", nested: {} },
      warnings: [
        "fields/1 matched nothing in this response after value safety and privacy filtering, at segment 2; declared there: id, email.",
      ],
    },
    {
      args: { path: "/items", fields: ["label.zz_missing"] },
      data: { id: "i1", label: { zz_customer_key: "v", zz_other_key: "w" } },
      expected: { label: {} },
      warnings: [
        "fields/0 matched nothing in this response after value safety and privacy filtering, at segment 2; the operation declares no properties there.",
      ],
    },
    {
      args: { path: "/items", fields: ["nested.id"] },
      data: [{ id: "a", nested: { id: "n1" } }, { id: "b" }],
      expected: [{ nested: { id: "n1" } }, {}],
    },
    { args: { path: "/items", fields: ["nope"] }, message: "property of data", sends: 0, auth: 0 },
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
      const result = await call("read", entry.args);
      expect(result).toEqual({
        status: 200,
        data: entry.expected,
        ...(entry.warnings ? { warnings: entry.warnings } : {}),
      });
      expect(JSON.stringify(result)).not.toMatch(/zz_|private|stored-secret/);
    }
    expect(sent).toHaveLength(entry.sends ?? 1);
    expect(authenticate).toHaveBeenCalledTimes(entry.auth ?? 1);
  }
  const details = JSON.parse(DATA.details);
  details.o[0][0].push(["starting_after", "query", 0, { t: "string" }]);
  const paged = setup({
    data: {
      ...DATA,
      details: JSON.stringify(details),
      fields: JSON.stringify({ p: ["data", "id"], d: [[0, 1]], o: DATA.ops.map(() => 0) }),
    },
    pages: { "GET /items": stripePage },
  });
  for (const id of ["credential-123456789", "prefix[redacted]tail", "%5Bredacted%5D"]) {
    response = () => Response.json({ data: [{ id, token: "stored-secret" }], has_more: true });
    await expect(paged.call("read", { path: "/items", fields: ["data"] })).rejects.toMatchObject({
      code: "connector_call_failed",
      retryable: false,
      message: expect.stringContaining("withheld paging cursor"),
    });
  }
  response = () => Response.json({ data: [{ id: "next-clean", token: "stored-secret" }], has_more: true });
  const safe = (await paged.call("read", { path: "/items", fields: ["data"] })) as any;
  expect(safe.data).toEqual({ data: [{ id: "next-clean", token: "[redacted]" }] });
  const claims = JSON.parse(atob(safe.page.nextCursor.replace(/-/g, "+").replace(/_/g, "/")));
  expect(JSON.parse(claims.c)).toBe("next-clean");
  claims.c = JSON.stringify("[redacted]");
  const replay = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const count = sent.length;
  await expect(
    paged.call("read", { path: "/items", fields: ["data"], query: { starting_after: replay } }),
  ).rejects.toMatchObject({ code: "invalid_args" });
  expect(sent).toHaveLength(count);
  // A valid cursor still cannot be restored to a placeholder by its adapter.
  for (const decoded of ["[redacted]", "&#91;redacted&#93;", "prefix&#91;redacted&#93;tail"]) {
    const changedDecoder = setup({
      data: {
        ...DATA,
        details: JSON.stringify(details),
        fields: JSON.stringify({ p: ["data", "id"], d: [[0, 1]], o: DATA.ops.map(() => 0) }),
      },
      context: paged.context,
      pages: {
        "GET /items": { ...stripePage, decode: () => decoded },
      },
    });
    await expect(
      changedDecoder.call("read", {
        path: "/items",
        fields: ["data"],
        query: { starting_after: safe.page.nextCursor },
      }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(changedDecoder.sendPath).not.toHaveBeenCalled();
    expect(changedDecoder.authenticate).not.toHaveBeenCalled();
  }
  // Protocol headers are opt-in, sent-secret redacted, and never copied to the tool result.
  const headerPaged = setup({
    data: { ...DATA, details: JSON.stringify(details) },
    pages: {
      "GET /items": {
        ...stripePage,
        headers: ["x-cursor"],
        next: (_data, call) => {
          expect(call.headers).toEqual({ "x-cursor": "[redacted]" });
          return null;
        },
      },
    },
  });
  response = () =>
    Response.json({ id: "i1" }, { headers: { "x-cursor": "credential-123456789", "set-cookie": "private" } });
  expect(await headerPaged.call("read", { path: "/items" })).toEqual({
    status: 200,
    data: { id: "i1" },
    page: { hasMore: false, param: "starting_after", in: "query" },
  });
});
