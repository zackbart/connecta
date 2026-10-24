import { NODE, WORKERS } from "./fixtures/runtime-tags.js";
import { Effect, Schema } from "effect";
import { kitInputDisagreements } from "./helpers/kit-schema.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apiConnector } from "../src/connectors/api-connector.js";
import { ConnectorCallError } from "../src/errors.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { guardedClient } from "../src/http/client.js";
import { RequestRefused, type VendorErrors } from "../src/http/errors.js";
import { DETAILS_BUDGET_BYTES, hatch, SEARCH_BUDGET } from "../src/http/hatch.js";
import {
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
import { runEdge } from "../src/runtime/run.js";
import { memoryStorage } from "../src/storage/memory.js";
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
    pageCursor?: "argument";
    binding?: Parameters<typeof hatch>[0]["binding"];
    data?: OpenApiData;
    context?: ReturnType<typeof connectorContext>;
  } = {},
) {
  const index = new OperationIndex(
    { ...(options.data ?? DATA), revision: options.revision ?? (options.data ?? DATA).revision },
    { vendor: "items", title: "Items" },
  );
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
  const tools = hatch({
    name: "items",
    index,
    verdicts: options.verdicts ?? VERDICTS,
    ...(options.pages ? { pages: options.pages } : {}),
    ...(options.pageCursor ? { pageCursor: options.pageCursor } : {}),
    ...(options.binding ? { binding: options.binding } : {}),
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
  "INV-1 INV-10 INV-11: snapshots explicit verdicts, routes discovery without I/O, and validates construction",
  NODE,
  async () => {
    const closed = setup({ writeEnabled: false });
    expect(closed.tools.map((tool) => tool.name)).not.toContain("items_api_write");
    const closedSearch = (await closed.call("search", { query: "create item", method: "POST" })) as {
      operations: Array<{ tool?: string }>;
    };
    expect(closedSearch.operations.every((row) => row.tool === undefined)).toBe(true);
    await expect(closed.call("write", { method: "POST", path: "/items", body: { name: "alice" } })).rejects.toThrow(
      /Unknown tool/,
    );
    expect(closed.sendPath).not.toHaveBeenCalled();
    expect(closed.authenticate).not.toHaveBeenCalled();
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
    // `method` is omitted only when GET is the one read method; enums follow the verdicts.
    const readMethod = (table: Parameters<typeof hatch>[0]["verdicts"]) => {
      const schema = hatch({ name: "items", index, connection, verdicts: table }).find(
        (tool) => tool.name === "items_api_read",
      )!.inputSchema as { properties: Record<string, any>; required: string[] };
      return { method: schema.properties["method"]?.enum, required: schema.required.includes("method") };
    };
    expect(readMethod({ "GET /items": "read" })).toEqual({ method: undefined, required: false });
    expect(readMethod({ "POST /query": "read" })).toEqual({ method: ["POST"], required: false });
    expect(readMethod({ "HEAD /items/{item}": "read" })).toEqual({ method: ["HEAD"], required: false });
    expect(readMethod({ "POST /query": "read", "HEAD /items/{item}": "read" })).toEqual({
      method: ["HEAD", "POST"],
      required: true,
    });
    expect(hatch({ name: "items", index, connection, verdicts: {} }).map((tool) => tool.name)).toEqual([
      "items_api_search",
      "items_api_details",
      "items_api_read",
    ]);
    for (const methods of [[], ["HEAD"]] as const)
      expect(() =>
        hatch({
          name: "items",
          index,
          connection,
          verdicts: VERDICTS,
          idempotency: { header: "Idempotency-Key", methods },
        }),
      ).toThrow(/idempotency methods/);
    expect(() =>
      hatch({
        name: "items",
        index,
        connection,
        verdicts: VERDICTS,
        binding: { review: "", send: () => Effect.succeed({ status: 200, data: null }) },
      }),
    ).toThrow(/binding needs/);
    expect(() => hatch({ name: "items", index, connection, verdicts: { "GET /missing": "read" } })).toThrow(
      "Hatch verdict GET /missing is not in the API index.",
    );
    expect(() =>
      hatch({ name: "items", index, connection, verdicts: VERDICTS, named: { "GET /missing": "missing" } }),
    ).toThrow("Hatch named tool for GET /missing needs an indexed operation.");
    expect(() =>
      hatch({ name: "items", index, connection, verdicts: VERDICTS, pages: { "GET /missing": stripePage } }),
    ).toThrow("Hatch paging for GET /missing needs an indexed read and a cursor adapter.");
    for (const bad of [{ "GET /missing": "read" }, { "GET /items": "unknown" }]) {
      expect(() => hatch({ name: "items", index, connection, verdicts: bad as never })).toThrow();
    }
    for (const pages of [
      { "GET /missing": stripePage },
      { "GET /items": stripePage }, // starting_after is not declared by this index
      { "GET /touch": { ...stripePage, param: "limit" } }, // not a read
    ])
      expect(() => hatch({ name: "items", index, connection, verdicts: VERDICTS, pages })).toThrow();
    // The compiler's shared response-field representation serves discovery,
    // without changing the legacy REST search/details or any provider catalog.
    const compiled = new OperationIndex(
      {
        ...DATA,
        ops: [["GET", "/widgets", "ListWidgets", "List widgets", 0]],
        details: JSON.stringify({ d: [], o: [] }),
        fields: JSON.stringify({ p: ["[].birth_date"], d: [[0]], o: [0] }),
      },
      { vendor: "compiled", title: "Compiled" },
    );
    const compiledConnector = apiConnector("compiled", {
      tools: hatch({
        name: "compiled",
        index: compiled,
        verdicts: { "GET /widgets": "read" },
        connection,
      }),
    });
    expect(
      await compiledConnector.callTool("compiled_api_search", { query: "birth" }, connectorContext()),
    ).toMatchObject({
      operations: [{ path: "/widgets", matched: "response field [].birth_date" }],
    });
    await expect(
      compiledConnector.callTool("compiled_api_read", { path: "/widgets", fields: ["misspelled"] }, connectorContext()),
    ).rejects.toMatchObject({ code: "invalid_args" });
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
          success: Schema.Struct({
            object: Schema.optionalKey(
              Schema.Struct({ widget_id: Schema.String, owner: Schema.Struct({ date_of_birth: Schema.String }) }),
            ),
          }),
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
      forms.callTool(`forms_api_${kind}`, args, connectorContext(storage)) as Promise<Record<string, any>>;
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
    // A field only a nested record declares is still found.
    expect((await formsCall("search", { query: "birth" })).operations).toEqual([
      expect.objectContaining({ matched: "response field object.owner.date_of_birth" }),
    ]);
    // Every details answer stays within 32 KiB: a large contract pages whole pieces, and a piece
    // too large for one answer arrives as chunks of its JSON. Following every cursor terminates and
    // reconstructs the whole contract: each parameter, each property with its requiredness, and every
    // other keyword of the body schema.
    const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    const walk = async (call: typeof formsCall, args: Record<string, unknown>) => {
      const pages: Array<Record<string, any>> = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        if (cursor) {
          expect(seen.has(cursor)).toBe(false);
          seen.add(cursor);
        }
        const page = await call("details", { ...args, ...(cursor ? { cursor } : {}) });
        expect(size(page)).toBeLessThanOrEqual(DETAILS_BUDGET_BYTES);
        pages.push(page);
        cursor = page["page"]?.hasMore ? page["page"].nextCursor : undefined;
      } while (cursor && pages.length < 400);
      expect(cursor).toBeUndefined();
      const firstCursor = pages[0]?.["page"]?.nextCursor;
      if (firstCursor) {
        const claims = JSON.parse(atob(firstCursor.replace(/-/g, "+").replace(/_/g, "/")));
        const tampered = btoa(JSON.stringify({ ...claims, c: '{"i":0,"o":1}' }))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
        await expect(call("details", { ...args, cursor: tampered })).rejects.toMatchObject({ code: "invalid_args" });
        const label = derived.revision;
        const scope = { revision: await derived.cursorRevision(), ...args };
        if (call === formsCall) {
          Object.defineProperty(derived, "revision", { value: "v2", configurable: true });
          await expect(call("details", { ...args, cursor: firstCursor })).rejects.toMatchObject({
            code: "invalid_args",
          });
          Object.defineProperty(derived, "revision", { value: label, configurable: true });
          for (const at of [
            { i: 0, o: 0 },
            { i: -1, o: 0 },
            { i: 0, o: 0.5 },
            { i: 0, o: 999999999 },
            { i: 9999, o: 0 },
          ]) {
            const cursor = await runEdge(
              boundCursor
                .encode("forms_api_details", scope, JSON.stringify(at))
                .pipe(
                  Effect.provideService(ContinuationStorage, storage),
                  Effect.provideService(ContinuationBinding, { connection: "forms", principal: null }),
                ),
            );
            await expect(call("details", { ...args, cursor })).rejects.toMatchObject({ code: "invalid_args" });
          }
        }
      }
      const labels: Record<string, string> = {};
      const parameters: unknown[] = [];
      const schema: Record<string, any> = {};
      const properties: Record<string, unknown> = {};
      const required = new Set<string>();
      let body: Record<string, unknown> | undefined;
      let pending: { of: string; text: string } | undefined;
      const settle = () => {
        if (!pending) return;
        const value = JSON.parse(pending.text);
        if (pending.of === "operationId" || pending.of === "summary") labels[pending.of] = value;
        else if (pending.of.startsWith("parameters.")) parameters.push(value);
        else if (pending.of === "body.schema") Object.assign(schema, value);
        else properties[pending.of.slice("body.schema.properties.".length)] = value;
        pending = undefined;
      };
      for (const page of pages) {
        if (pending && page["chunk"]?.of !== pending.of) settle();
        if (page["chunk"]) pending = { of: page["chunk"].of, text: (pending?.text ?? "") + page["chunk"].text };
        parameters.push(...page["parameters"]);
        if (page["body"]) {
          const { schema: part, ...wrapper } = page["body"];
          body = wrapper;
          const { properties: some, required: names, ...frame } = part;
          Object.assign(schema, frame);
          Object.assign(properties, some ?? {});
          for (const name of names ?? []) required.add(name);
        }
      }
      settle();
      const first = pages[0]!;
      return {
        pages,
        contract: {
          method: first["method"],
          path: first["path"],
          operationId: labels["operationId"] ?? first["operationId"],
          summary: labels["summary"] ?? first["summary"],
          parameters,
          ...(body
            ? {
                body: {
                  ...body,
                  schema: {
                    ...schema,
                    ...(Object.keys(properties).length ? { properties } : {}),
                    ...(required.size ? { required: [...required].sort() } : {}),
                  },
                },
              }
            : {}),
        },
      };
    };
    const original = (index: OperationIndex, param?: string) => {
      const contract = index.contract(index.ops[0]!, param);
      const schema = contract.body?.schema as { required?: string[] } | undefined;
      return schema?.required
        ? { ...contract, body: { ...contract.body!, schema: { ...schema, required: [...schema.required].sort() } } }
        : contract;
    };
    const contract = await walk(formsCall, { method: "POST", path: "/things/t1" });
    expect(contract.pages.length).toBeGreaterThan(1);
    expect(contract.contract).toEqual(original(derived));
    expect((await formsCall("details", { method: "POST", path: "/things/{thing_id}", param: "amount" })).body).toEqual({
      contentType: "application/x-www-form-urlencoded",
      schema: { type: "object", properties: { amount: { type: "number" } } },
    });
    const heavy = (fields: Record<string, Schema.Top>, verdict = "write") => {
      const index = vendorIndex(
        vendor("heavy", post("heavy", "/heavy", { payload: form(Schema.Struct(fields)), success: Schema.Unknown })),
        { prefix: "heavy", title: "Heavy", revision: "v1" },
      );
      const connector = apiConnector("heavy", {
        tools: hatch({ name: "heavy", index, verdicts: { "POST /heavy": verdict as "write" }, connection }),
      });
      return {
        index,
        call: (kind: string, args: Record<string, unknown>) =>
          connector.callTool(`heavy_api_${kind}`, args, connectorContext(storage)) as Promise<Record<string, any>>,
      };
    };
    // An irreducibly large required contract pages every required property.
    const many = heavy(
      Object.fromEntries(
        Array.from({ length: 240 }, (_, i) => [
          `required_${i}`,
          Schema.String.annotate({ description: "r".repeat(180) }),
        ]),
      ),
    );
    expect((await walk(many.call, { method: "POST", path: "/heavy" })).contract).toEqual(original(many.index));
    // A property larger than an answer arrives as chunks and keeps its requiredness, through param too.
    const big = heavy({
      must: Schema.String.annotate({ description: `${"x".repeat(40000)}😀` }),
      other: Schema.String,
    });
    const property = (original(big.index).body!.schema as { properties: { must: unknown } }).properties.must;
    const splitPair = JSON.stringify(property).indexOf("😀") + 1;
    expect(splitPair).toBeGreaterThan(0);
    const splitCursor = await runEdge(
      boundCursor
        .encode(
          "heavy_api_details",
          { revision: await big.index.cursorRevision(), method: "POST", path: "/heavy" },
          JSON.stringify({ i: 1, o: splitPair }),
        )
        .pipe(
          Effect.provideService(ContinuationStorage, storage),
          Effect.provideService(ContinuationBinding, { connection: "heavy", principal: null }),
        ),
    );
    await expect(big.call("details", { method: "POST", path: "/heavy", cursor: splitCursor })).rejects.toMatchObject({
      code: "invalid_args",
    });
    const whole = await walk(big.call, { method: "POST", path: "/heavy" });
    expect(whole.pages.some((page) => page["chunk"]?.of === "body.schema.properties.must")).toBe(true);
    expect(whole.contract).toEqual(original(big.index));
    expect((await walk(big.call, { method: "POST", path: "/heavy", param: "must" })).contract).toEqual(
      original(big.index, "must"),
    );
    // An object body's own keywords (a long description, additionalProperties) are carried too.
    const framed = new OperationIndex(
      {
        ...DATA,
        ops: [["POST", "/framed", "Framed", "Framed body", 0]],
        details: JSON.stringify({
          d: [],
          o: [
            [
              [["limit", "query", 0, { t: "number" }]],
              [
                "application/json",
                {
                  t: "object",
                  d: `Root ${"x".repeat(40000)}`,
                  p: { known: { t: "string" } },
                  r: ["known"],
                  m: { t: "number" },
                },
                1,
              ],
            ],
          ],
        }),
        fields: [],
      },
      { vendor: "framed", title: "Framed" },
    );
    const framedCall = (kind: string, args: Record<string, unknown>) =>
      apiConnector("framed", { tools: hatch({ name: "framed", index: framed, verdicts: {}, connection }) }).callTool(
        `framed_api_${kind}`,
        args,
        connectorContext(storage),
      ) as Promise<Record<string, any>>;
    const framedPages = await walk(framedCall, { method: "POST", path: "/framed" });
    expect(framedPages.pages.some((page) => page["chunk"]?.of === "body.schema")).toBe(true);
    expect(framedPages.contract).toEqual(original(framed));
    // Search trims whole entries to its exact byte budget, page and cursor included, and continues by cursor.
    const long = new OperationIndex(
      {
        ...DATA,
        ops: Array.from(
          { length: 10 },
          (_, i) => ["GET", `/${"x".repeat(2000)}${i}`, `Long${i}`, "Long path", 0] as const,
        ),
        details: JSON.stringify({ d: [], o: [] }),
        fields: [],
      },
      { vendor: "long", title: "Long" },
    );
    const searchLong = (args: Record<string, unknown>) =>
      tracksEveryRequest(
        apiConnector("long", { tools: hatch({ name: "long", index: long, verdicts: {}, connection }) }),
      ).callTool("long_api_search", args, connectorContext(storage)) as Promise<Record<string, any>>;
    const trimmed = await searchLong({ query: "xxx", limit: 8 });
    expect(trimmed["operations"].length).toBeLessThan(8);
    expect(size(trimmed)).toBeLessThanOrEqual(SEARCH_BUDGET.bytes);
    expect(trimmed["page"].hasMore).toBe(true);
    expect(size(await searchLong({ query: "xxx", limit: 8, cursor: trimmed["page"].nextCursor }))).toBeLessThanOrEqual(
      SEARCH_BUDGET.bytes,
    );
    // A sole entry with an oversized label is cut, marked, and served whole by details.
    const label = new OperationIndex(
      {
        ...DATA,
        ops: [["GET", "/things", "x".repeat(40000), "Things", 0]],
        details: JSON.stringify({ d: [], o: [] }),
      },
      { vendor: "label", title: "Label" },
    );
    const labelled = apiConnector("label", { tools: hatch({ name: "label", index: label, verdicts: {}, connection }) });
    const found = (await labelled.callTool(
      "label_api_search",
      { query: "things" },
      connectorContext(storage),
    )) as Record<string, any>;
    expect(size(found)).toBeLessThanOrEqual(SEARCH_BUDGET.bytes);
    expect(found["truncated"]).toEqual(["operations[0].operationId"]);
    const labels = await walk(
      (kind, args) =>
        labelled.callTool(`label_api_${kind}`, args, connectorContext(storage)) as Promise<Record<string, any>>,
      { method: "GET", path: "/things" },
    );
    expect(labels.pages[0]!["truncated"]).toEqual(["operationId"]);
    expect(labels.contract).toEqual(original(label));
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
    { kind: "read", args: { path: "/items", query: { limt: 2 } }, message: "limt" },
    { kind: "read", args: { path: "/items", query: { link: { nested: true } } }, message: "link" },
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
      paged.call("write", { ...args, method: "GET", query: { ...args.query, [adapter.param]: first.page.nextCursor } }),
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
    // The same durable root key still cannot authorize another connection or
    // personal credential owner; only the admitted context supplies that binding.
    const continuation = { ...args, query: { ...args.query, [adapter.param]: first.page.nextCursor } };
    const beforeAlias = sent.length;
    await expect(
      apiConnector("other_items", { tools: paged.tools }).callTool(
        "items_api_read",
        continuation,
        connectorContext(storage),
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(sent).toHaveLength(beforeAlias);
    const personal = apiConnector("items", { tools: paged.tools, authScope: "personal" });
    const registry = new Registry([personal], { storage, logger: paged.context.logger });
    const personalContext = (owner: string) =>
      registry.personalRegistry(owner).contextFor("items", "https://connecta.example", {});
    response = () => Response.json(row.first, { headers: "link" in row ? { link: row.link! } : {} });
    const alice = (await personal.callTool("items_api_read", args, personalContext("alice"))) as any;
    const personalContinuation = { ...args, query: { ...args.query, [adapter.param]: alice.page.nextCursor } };
    const beforeOwner = sent.length;
    await expect(
      personal.callTool("items_api_read", personalContinuation, personalContext("bob")),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(sent).toHaveLength(beforeOwner);
    response = () => Response.json(row.last);
    expect(await personal.callTool("items_api_read", personalContinuation, personalContext("alice"))).toMatchObject({
      page: { hasMore: false },
    });
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
    expect(first.page).toMatchObject({ hasMore: true, param: row.param, in: "query", nextCursor: expect.any(String) });
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
  const cursorStyle = setup({ data: pageData("page"), pages: { "GET /items": cloudflarePage } });
  expect(await cursorStyle.call("read", { path: "/items" })).not.toHaveProperty("page");
  expect(() =>
    githubPage("https://api.example").next([], {
      path: "/items",
      query: { nested: { key: "value" } },
      headers: { link: "<https://api.example/items?page=2&nested=%5Bobject+Object%5D>; rel=next" },
    }),
  ).toThrow();
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
    // A declared field the privacy projection dropped narrows to nothing; an empty list accepts valid fields.
    { args: { path: "/items", fields: ["email", "id"] }, data: { id: "i1", email: "private" }, expected: { id: "i1" } },
    { args: { path: "/items", fields: ["id"] }, data: [], expected: [] },
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
      expect(await call("read", entry.args)).toEqual({ status: 200, data: entry.expected });
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
