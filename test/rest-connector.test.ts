// The shared REST connector (src/providers/_shared/rest/) over a synthetic
// vendor: validation against the pinned index before transport, the reviewed
// read/write split, one envelope, bounded reads, and auth dispatch. Stripe's
// own configuration is tested in src/providers/stripe/provider.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiConnector } from "../src/connectors/api-connector.js";
import { ConnectorCallError } from "../src/errors.js";
import { OperationIndex, type OpenApiData, type SchemaNode } from "../src/providers/_shared/rest/operation-index.js";
import { restTools, restTransport, type RestVendor } from "../src/providers/_shared/rest/tools.js";
import { byAuth, hostedOAuth } from "../src/providers/_shared/rest/dispatch.js";
import { recordRecovery, recoveryFor } from "../src/call-recovery.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import type { ProviderContext } from "../src/provider.js";
import type { Connector, ConnectorContext } from "../src/types.js";
import { connectorContext } from "./fixtures/misc.js";

const widget: SchemaNode = { t: "object", p: { name: { t: "string" }, size: { t: "string", e: ["s", "m"] } } };
const DATA: OpenApiData = {
  source: "https://vendor.example/openapi.json",
  revision: "r1",
  digest: `sha256:${"0".repeat(64)}`,
  version: "2026-01-01",
  servers: ["https://api.vendor.example", "https://files.vendor.example"],
  tags: ["widgets", "uploads"],
  ops: [
    ["GET", "/v1/widgets", "ListWidgets", "List widgets", 0],
    ["POST", "/v1/widgets", "CreateWidget", "Create a widget", 0],
    ["POST", "/v1/widgets/query", "QueryWidgets", "Query widgets", 0],
    ["GET", "/v1/widgets/search", "SearchWidgets", "Search widgets", 0],
    ["GET", "/v1/widgets/{widget}", "GetWidget", "Retrieve a widget", 0],
    ["DELETE", "/v1/widgets/{widget}", "DeleteWidget", "Delete a widget", 0],
    ["POST", "/v1/uploads", "CreateUpload", "Upload a file", 1],
    ["GET", "/v1/exports", "ListExports", "List exports", 1, 1],
    ["HEAD", "/v1/widgets/{widget}", "HeadWidget", "Check a widget", 0],
  ],
  details: JSON.stringify({
    d: [widget],
    o: [
      [
        [
          ["limit", "query", 0, { t: "integer" }, "Most results."],
          ["team", "query", 0, { t: "string" }],
          ["tags", "query", 0, { t: "array", i: { t: "string" } }],
        ],
        0,
      ],
      [
        [["team", "query", 0, { t: "string" }]],
        ["application/json", { t: "object", r: ["name"], p: { name: { t: "string" }, spec: { $: 0 } } }],
      ],
      [[], ["application/json", { t: "object", p: { filter: { t: "string" } } }]],
      [[["q", "query", 1, { t: "string" }]], 0],
      [[["widget", "path", 1, { t: "string" }]], 0],
      [[["widget", "path", 1, { t: "string" }]], 0],
      [[], ["multipart/form-data", { t: "object", p: { file: { t: "string", f: "binary" } } }]],
      0,
      [[["widget", "path", 1, { t: "string" }]], 0],
    ],
  }),
};

interface Sent {
  url: URL;
  method: string;
  headers: Headers;
  body: string | undefined;
}

let sent: Sent[];
let respond: (request: Sent) => Response | Promise<Response>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  respond = () => Response.json({ items: [] });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: Sent = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    sent.push(request);
    return await respond(request);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function vendor(overrides: Partial<RestVendor> = {}, timeoutMs = 30_000): RestVendor {
  const index = new OperationIndex(DATA, { vendor: "acme", title: "Acme" });
  const api = restTransport({
    provider: "Acme",
    baseUrl: "https://api.vendor.example",
    maxResponseBytes: 1024 * 1024,
    timeoutMs,
    authenticate: async () => ({ Authorization: "Bearer secret-token" }),
  });
  return {
    vendor: "acme",
    title: "Acme",
    index,
    transport: (server) => (server === undefined ? api : `Acme serves ${server} elsewhere.`),
    failure: (status, _headers, body) =>
      new ConnectorCallError(status === 404 ? "not_found" : "invalid_args", `Acme ${status}: ${JSON.stringify(body)}`),
    readPosts: [["POST", "/v1/widgets/query", "Filters widgets without changing them."]],
    upload: "Use acme_api_upload.",
    ...overrides,
  };
}

function connector(overrides: Partial<RestVendor> = {}, timeoutMs?: number): Connector {
  return apiConnector("acme", { tools: restTools(vendor(overrides, timeoutMs)) });
}

const ctx = (): ConnectorContext => connectorContext();

async function refusal(promise: Promise<unknown>): Promise<ConnectorCallError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ConnectorCallError);
  return error as ConnectorCallError;
}

describe("restTools()", () => {
  it("INV-1: names four tools from the vendor and classifies reads and the destructive write", async () => {
    const tools = await connector().listTools(ctx());
    expect(tools.map((tool) => [tool.name, tool.annotations])).toEqual([
      ["acme_api_search", { readOnlyHint: true }],
      ["acme_api_details", { readOnlyHint: true }],
      ["acme_api_read", { readOnlyHint: true }],
      ["acme_api_write", { readOnlyHint: false, destructiveHint: true }],
    ]);
    const write = tools.find((tool) => tool.name === "acme_api_write")!;
    expect((write.inputSchema as any).properties.method.enum).toEqual(["POST", "DELETE"]);
    expect((write.inputSchema as any).required).toEqual(["method", "path"]);
    // No idempotency header configured, so no idempotency argument.
    expect((write.inputSchema as any).properties.idempotencyKey).toBeUndefined();
    const read = tools.find((tool) => tool.name === "acme_api_read")!;
    expect((read.inputSchema as any).properties.method.enum).toEqual(["GET", "HEAD", "POST"]);
  });

  it("INV-10: searches and describes the pinned index without sending a request", async () => {
    const acme = connector();
    const found = (await acme.callTool("acme_api_search", { query: "query widgets" }, ctx())) as any;
    expect(found.operations[0]).toMatchObject({ method: "POST", path: "/v1/widgets/query", tool: "acme_api_read" });
    const byPath = (await acme.callTool("acme_api_search", { query: "/v1/widgets/w_1" }, ctx())) as any;
    expect(byPath.operations.map((op: any) => `${op.method} ${op.path}`).slice(0, 2)).toEqual([
      "GET /v1/widgets/{widget}",
      "DELETE /v1/widgets/{widget}",
    ]);
    const details = (await acme.callTool("acme_api_details", { method: "POST", path: "/v1/widgets" }, ctx())) as any;
    expect(details).toMatchObject({
      tool: "acme_api_write",
      revision: "r1",
      parameters: [{ name: "team", in: "query", required: false }],
      body: {
        contentType: "application/json",
        schema: { required: ["name"], properties: { spec: { properties: { size: { enum: ["s", "m"] } } } } },
      },
    });
    const one = (await acme.callTool(
      "acme_api_details",
      { method: "GET", path: "/v1/widgets", param: "limit" },
      ctx(),
    )) as any;
    expect(one.parameters).toEqual([
      { name: "limit", in: "query", required: false, description: "Most results.", schema: { type: "integer" } },
    ]);
    expect(sent).toEqual([]);
  });

  it("refuses unknown paths, wrong methods, and unsafe segments before transport", async () => {
    const acme = connector();
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["acme_api_read", { path: "/v1/widget" }, "Nearest: GET /v1/widgets"],
      ["acme_api_write", { method: "POST", path: "/v1/widgets/search" }, "accepts GET, not POST"],
      ["acme_api_read", { path: "/v1/widgets/../uploads" }, "dot segment"],
      ["acme_api_read", { path: "/v1/widgets/%2e%2e" }, "dot segment"],
      ["acme_api_read", { path: "/v1/widgets/a%2Fb" }, "encoded separator"],
      ["acme_api_read", { path: "/v1/widgets/{widget}" }, "{placeholder}"],
      ["acme_api_read", { path: "/v1/widgets?limit=1" }, "put query parameters in query"],
      ["acme_api_read", { path: "/v1//widgets" }, "no empty segments"],
      ["acme_api_read", { path: "v1/widgets" }, 'begins with "/"'],
    ];
    for (const [tool, args, message] of cases) {
      const error = await refusal(acme.callTool(tool, args, ctx()));
      expect(error.code, `${tool} ${JSON.stringify(args)}`).toBe("invalid_args");
      expect(error.message).toContain(message);
    }
    expect(sent).toEqual([]);
  });

  it("checks parameter names, required members, enums, and shapes, naming accepted keys", async () => {
    const acme = connector();
    const unknown = await refusal(acme.callTool("acme_api_read", { path: "/v1/widgets", query: { limt: 1 } }, ctx()));
    expect(unknown.validation?.issues[0]).toEqual({
      path: "/query/limt",
      code: "additionalProperties",
      expected: "limit? one of limit, team, tags",
    });
    expect(unknown.repair?.issues[0]).toEqual({
      path: "/query/limt",
      receivedType: "number",
      acceptedKeys: ["limit", "team", "tags"],
    });
    const missing = await refusal(acme.callTool("acme_api_read", { path: "/v1/widgets/search" }, ctx()));
    expect(missing.validation?.issues[0]).toMatchObject({ path: "/query/q", code: "required" });
    const nested = await refusal(
      acme.callTool(
        "acme_api_write",
        { method: "POST", path: "/v1/widgets", body: { name: "a", spec: { size: "xl", colour: "red" } } },
        ctx(),
      ),
    );
    expect(nested.validation?.issues.map((issue) => `${issue.path} ${issue.code}`)).toEqual([
      "/body/spec/size enum",
      "/body/spec/colour additionalProperties",
    ]);
    const shape = await refusal(
      acme.callTool("acme_api_read", { path: "/v1/widgets", query: { tags: "solo" } }, ctx()),
    );
    expect(shape.validation?.issues[0]).toMatchObject({ path: "/query/tags", code: "type", expected: "array" });
    const bodiless = await refusal(
      acme.callTool("acme_api_write", { method: "DELETE", path: "/v1/widgets/w_1", body: { force: true } }, ctx()),
    );
    expect(bodiless.validation?.issues[0]).toMatchObject({ path: "/body", expected: "no body for this operation" });
    expect(sent).toEqual([]);
  });

  it("INV-1: admits only GET and reviewed read-only POSTs through _api_read", async () => {
    const acme = connector();
    const write = await refusal(
      acme.callTool("acme_api_read", { method: "POST", path: "/v1/widgets", body: { name: "a" } }, ctx()),
    );
    expect(write.message).toContain("is not a reviewed read; call it with acme_api_write");
    const getBody = await refusal(acme.callTool("acme_api_read", { path: "/v1/widgets", body: {} }, ctx()));
    expect(getBody.message).toContain("takes query, not body");
    expect(sent).toEqual([]);
    await acme.callTool("acme_api_read", { method: "POST", path: "/v1/widgets/query", body: { filter: "x" } }, ctx());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "POST", body: '{"filter":"x"}' });
  });

  it("frames JSON by default, answers in one envelope, and projects select paths through lists", async () => {
    respond = () => Response.json({ items: [{ id: "w_1", name: "a", secret: 1 }, { id: "w_2" }], total: 2 });
    const result = await connector().callTool(
      "acme_api_read",
      { path: "/v1/widgets", query: { limit: 2, tags: ["a", "b"] }, select: ["items.id", "total"] },
      ctx(),
    );
    expect(result).toEqual({ status: 200, data: { items: [{ id: "w_1" }, { id: "w_2" }], total: 2 } });
    expect(sent[0]!.url.search).toBe("?limit=2&tags=a&tags=b");
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer secret-token");
    // A shorter path keeps its whole subtree, whichever order the paths arrive in.
    for (const select of [
      ["items", "items.id"],
      ["items.id", "items"],
    ]) {
      const whole = (await connector().callTool("acme_api_read", { path: "/v1/widgets", select }, ctx())) as any;
      expect(whole.data).toEqual({ items: [{ id: "w_1", name: "a", secret: 1 }, { id: "w_2" }] });
    }
  });

  it("reads text, NDJSON, and binary success bodies into data", async () => {
    const acme = connector();
    const bodies: Array<[Response, unknown]> = [
      [new Response("plain words", { headers: { "content-type": "text/plain" } }), "plain words"],
      [
        new Response('{"a":1}\nnot json\n{"b":2}\n', { headers: { "content-type": "application/x-ndjson" } }),
        [{ a: 1 }, { line: "not json" }, { b: 2 }],
      ],
      [
        new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { headers: { "content-type": "application/pdf" } }),
        { contentType: "application/pdf", bytes: 4, base64: "JVBERg==" },
      ],
      [new Response(null, { status: 204 }), null],
    ];
    for (const [response, data] of bodies) {
      respond = () => response;
      expect(((await acme.callTool("acme_api_read", { path: "/v1/widgets/w_1" }, ctx())) as any).data).toEqual(data);
    }
  });

  it("bounds a response that never finishes by the transport's read cap", async () => {
    respond = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"items": ['));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    // The stub honors the signal the transport adds, as fetch does.
    const stub = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await stub(input, init);
      const reader = response.body!.getReader();
      return new Response(
        new ReadableStream({
          async pull(controller) {
            const next = await Promise.race([
              reader.read(),
              new Promise<never>((_, reject) => {
                const signal = init!.signal!;
                if (signal.aborted) reject(signal.reason);
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
            ]);
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
        }),
        { headers: response.headers },
      );
    }) as typeof fetch;
    const error = await refusal(connector({}, 50).callTool("acme_api_read", { path: "/v1/widgets" }, ctx()));
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("did not finish its response within the read cap");
    expect(error.details).toMatchObject({ code: "timeout" });
  });

  it("applies vendor scope before validation and runs reviewed refusals before transport", async () => {
    const acme = connector({
      scope: (call) => {
        if (call.params["widget"] === "w_pinned_out") throw new ConnectorCallError("invalid_args", "Outside the pin.");
        return call.method === "GET" && call.op.path === "/v1/widgets"
          ? { ...call, query: { team: "t_default", ...call.query } }
          : call;
      },
      refuse: (call) => (call.query["tags"] ? "Tag reads are refused here." : undefined),
    });
    await acme.callTool("acme_api_read", { path: "/v1/widgets" }, ctx());
    expect(sent[0]!.url.searchParams.get("team")).toBe("t_default");
    expect((await refusal(acme.callTool("acme_api_read", { path: "/v1/widgets/w_pinned_out" }, ctx()))).message).toBe(
      "Outside the pin.",
    );
    expect(
      (await refusal(acme.callTool("acme_api_read", { path: "/v1/widgets", query: { tags: ["a"] } }, ctx()))).message,
    ).toBe("Tag reads are refused here.");
    expect(sent).toHaveLength(1);
  });

  it("refuses uploads and other hosts with the vendor's pointer instead of sending", async () => {
    const error = await refusal(
      connector().callTool("acme_api_write", { method: "POST", path: "/v1/uploads", body: {} }, ctx()),
    );
    expect(error.message).toBe(
      "POST /v1/uploads takes a multipart/form-data upload, which acme_api_write does not send. Use acme_api_upload.",
    );
    const host = await refusal(connector().callTool("acme_api_read", { path: "/v1/exports", query: { x: 1 } }, ctx()));
    expect(host.message).toBe("Acme serves https://files.vendor.example elsewhere.");
    expect(sent).toEqual([]);
  });

  it("INV-9: dispatches a write once and maps its failure through the vendor", async () => {
    respond = () => Response.json({ message: "boom" }, { status: 500 });
    const error = await refusal(
      connector().callTool("acme_api_write", { method: "POST", path: "/v1/widgets", body: { name: "a" } }, ctx()),
    );
    expect(error.message).toBe('Acme 500: {"message":"boom"}');
    expect(sent).toHaveLength(1);
  });

  it("reads HEAD as a read whose data is the response headers, and refuses it as a write", async () => {
    // A HEAD's Content-Length describes the GET body: past the 1 MiB ceiling, it still answers.
    respond = () => new Response(null, { status: 200, headers: { etag: '"v1"', "content-length": "10000000" } });
    const acme = connector();
    const result = (await acme.callTool("acme_api_read", { method: "HEAD", path: "/v1/widgets/w_1" }, ctx())) as any;
    expect(result).toMatchObject({ status: 200, data: { etag: '"v1"', "content-length": "10000000" } });
    expect(sent[0]!.method).toBe("HEAD");
    // The same declaration on a GET is still refused before it is read.
    respond = () =>
      new Response("{}", { headers: { "content-type": "application/json", "content-length": "10000000" } });
    const get = await refusal(acme.callTool("acme_api_read", { path: "/v1/widgets/w_1" }, ctx()));
    expect(get.message).toContain("past this connector's 1048576-byte response ceiling");
    sent.splice(1);
    const write = await refusal(acme.callTool("acme_api_write", { method: "HEAD", path: "/v1/widgets/w_1" }, ctx()));
    expect(write.code).toBe("invalid_args");
    const body = await refusal(
      acme.callTool("acme_api_read", { method: "HEAD", path: "/v1/widgets/w_1", body: {} }, ctx()),
    );
    expect(body.message).toContain("takes query, not body");
    expect(sent).toHaveLength(1);
  });

  it("INV-9: returns a generated idempotency key when the response body is lost after dispatch", async () => {
    respond = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    const callCtx = ctx();
    const error = await refusal(
      connector({ idempotencyHeader: "Idempotency-Key" }).callTool(
        "acme_api_write",
        { method: "POST", path: "/v1/widgets", body: { name: "a" } },
        callCtx,
      ),
    );
    const key = sent[0]!.headers.get("idempotency-key");
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(error.code).toBe("unavailable");
    expect(error.details).toMatchObject({ code: "ECONNRESET" });
    expect(error.message).toContain("its response could not be read");
    expect(error.message).toContain(`Idempotency-Key: ${key}`);
    expect(error.message).not.toContain("socket hang up");
    // Recorded before dispatch, for a deadline that interrupts the call.
    expect(recoveryFor(callCtx)).toEqual({ idempotencyKey: key });
    expect(sent).toHaveLength(1);
  });

  it("INV-9: advertises a lost reply as retryable only for reads and writes that carried an idempotency key", async () => {
    const lost = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    respond = lost;
    // No idempotency header: a write's outcome is unknown and must not be retried.
    const plain = connector();
    const write = await refusal(
      plain.callTool("acme_api_write", { method: "POST", path: "/v1/widgets", body: { name: "a" } }, ctx()),
    );
    expect(write.code).toBe("connector_call_failed");
    expect(write.retryable).toBe(false);
    expect(write.message).toContain("whether the write took effect is unknown");
    expect(write.message).not.toContain("socket hang up");
    // A read is safe to repeat.
    const read = await refusal(plain.callTool("acme_api_read", { path: "/v1/widgets/w_1" }, ctx()));
    expect(read).toMatchObject({ code: "unavailable", retryable: true });
    // A reviewed read-only POST is a read.
    const query = await refusal(
      plain.callTool("acme_api_read", { method: "POST", path: "/v1/widgets/query", body: { filter: "x" } }, ctx()),
    );
    expect(query).toMatchObject({ code: "unavailable", retryable: true });
    // With the vendor's idempotency header sent, the write is safe to repeat with its key.
    const keyed = connector({ idempotencyHeader: "Idempotency-Key" });
    const sentKey = await refusal(
      keyed.callTool("acme_api_write", { method: "POST", path: "/v1/widgets", body: { name: "a" } }, ctx()),
    );
    expect(sentKey).toMatchObject({ code: "unavailable", retryable: true });
    // DELETE carries no key even for that vendor, so it stays unknown and unretryable.
    const deleted = await refusal(
      keyed.callTool("acme_api_write", { method: "DELETE", path: "/v1/widgets/w_1" }, ctx()),
    );
    expect(deleted).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(sent.map((request) => request.headers.has("idempotency-key"))).toEqual([false, false, false, true, false]);
  });

  it("INV-9: carries recorded recovery on a direct write whose reply was lost, not only on a deadline", async () => {
    respond = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    const app = createTestConnecta({
      connectors: [apiConnector("acme", { tools: restTools(vendor({ idempotencyHeader: "Idempotency-Key" })) })],
      logger: silentLogger,
    });
    try {
      const rpc = await readJsonRpc(
        await mcpRpc(app, "tools/call", {
          name: "call_destructive_tool",
          arguments: {
            address: "acme.acme_api_write",
            args: { method: "POST", path: "/v1/widgets", body: { name: "a" } },
          },
        }),
      );
      const error = rpc.result.structuredContent.error;
      const key = sent[0]!.headers.get("idempotency-key");
      expect(error.code).toBe("unavailable");
      expect(error.uncertainCall).toMatchObject({ address: "acme.acme_api_write", recovery: { idempotencyKey: key } });
      expect(error.retry).toContain("uncertainCall.recovery.idempotencyKey");
      expect(sent).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("INV-9: returns the generated idempotency key with write_outcome_unknown when the call deadline interrupts it", async () => {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }) as typeof fetch;
    const app = createTestConnecta({
      connectors: [apiConnector("acme", { tools: restTools(vendor({ idempotencyHeader: "Idempotency-Key" })) })],
      logger: silentLogger,
    });
    try {
      const rpc = await readJsonRpc(
        await mcpRpc(app, "tools/call", {
          name: "call_destructive_tool",
          arguments: {
            address: "acme.acme_api_write",
            args: { method: "POST", path: "/v1/widgets", body: { name: "a" } },
            timeoutMs: 200,
          },
        }),
      );
      const error = rpc.result.structuredContent.error;
      expect(error.code).toBe("write_outcome_unknown");
      expect(sent).toHaveLength(1);
      const key = sent[0]!.headers.get("idempotency-key");
      expect(key).toMatch(/^[0-9a-f-]{36}$/);
      expect(error.uncertainCall).toMatchObject({ address: "acme.acme_api_write", recovery: { idempotencyKey: key } });
      expect(error.retry).toContain("uncertainCall.recovery.idempotencyKey");
    } finally {
      await app.close();
    }
  });

  it("bounds recovery facts to a few short named strings", () => {
    const callCtx = ctx();
    recordRecovery(callCtx, { idempotencyKey: "k1", "bad name": "x", long: "y".repeat(200) });
    recordRecovery(callCtx, { a: "1", b: "2", c: "3", d: "4" });
    expect(recoveryFor(callCtx)).toEqual({ idempotencyKey: "k1", a: "1", b: "2", c: "3" });
    expect(recoveryFor(ctx())).toBeUndefined();
  });

  it("INV-11: refuses a reviewed read-only POST the pinned index no longer carries", () => {
    expect(() => restTools(vendor({ readPosts: [["POST", "/v1/widgets/preview", "Gone."]] }))).toThrow(
      "Acme reviewed read-only POST /v1/widgets/preview is not in the pinned API index.",
    );
  });
});

describe("auth dispatch", () => {
  const provider: ProviderContext = {
    connectorOptions: {},
    classify: { tools: { list: "read" } },
    usageGuide: () => ({ content: "" }),
  };

  it("INV-11: dispatches on auth.type and refuses a type no case handles", () => {
    const oauth = vi.fn((id: string) => ({ id }) as Connector);
    const key = vi.fn((id: string) => ({ id }) as Connector);
    type Options = { purpose: string; auth: { type: "oauth" } } | { purpose: string; auth: { type: "key" } };
    const create = byAuth<Options>({ oauth, key });
    create("a", { purpose: "p", auth: { type: "key" } }, provider);
    expect(key).toHaveBeenCalledTimes(1);
    expect(() => create("b", { purpose: "p", auth: { type: "token" } } as never, provider)).toThrow(
      'auth.type must be one of "oauth", "key".',
    );
    expect(oauth).not.toHaveBeenCalled();
  });

  it("builds the hosted connection with OAuth only and the provider's review", () => {
    const hosted = hostedOAuth("acme_mcp", provider, {
      url: "https://mcp.vendor.example/mcp",
      title: "Acme",
      description: "Acme hosted",
      usageGuide: { content: "# Acme\n" },
    });
    expect(hosted.describe?.()).toMatchObject({
      source: { kind: "remote-mcp" },
      endpoint: { origin: "https://mcp.vendor.example", path: "/mcp" },
      auth: { mode: "oauth" },
      transport: { requireHttps: true },
    });
    expect(hosted.classification).toEqual({ tools: { list: "read" } });
    expect(hosted.credential).toBeUndefined();
  });
});
