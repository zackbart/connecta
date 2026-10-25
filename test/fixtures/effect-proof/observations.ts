// Shared by the Node bundle and real service-bound workerd isolates.
import { Context, Effect, Layer, Scope } from "effect";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createConnecta, customExecutor } from "../../../src/index.js";
import { api } from "../../../src/connectors/api.js";
import { memoryStorage } from "../../../src/storage/memory.js";
import { accessTokens, AccessTokenManager } from "../../../src/access-tokens.js";
import { operatorUi } from "../../../src/ui.js";
import { encryptedCredentialVault } from "../../../src/credentials.js";
import { runEdge } from "../../../src/runtime/run.js";
import { matchModule } from "./router.js";
import type { RouteContext } from "../../../src/routes/shared.js";
import type { KVStorage } from "../../../src/types.js";

const BASE = "https://proof.test";
const principal = { namespace: "proof", id: "alice" };
const executor = () => customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });

export function rpcRequest(method: string, params: Record<string, unknown> = {}, modern = true, path = "/mcp", extra: Record<string, string> = {}) {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer proof", ...extra });
  if (modern) {
    headers.set("mcp-protocol-version", "2026-07-28");
    if (!headers.has("mcp-method")) headers.set("mcp-method", method);
    if (typeof params.name === "string" && !headers.has("mcp-name")) headers.set("mcp-name", params.name);
    if (typeof params.uri === "string" && !headers.has("mcp-name")) headers.set("mcp-name", params.uri);
  } else headers.set("mcp-protocol-version", "2025-06-18");
  return new Request(BASE + path, { method: "POST", headers, body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method, params: modern ? { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      ...(params._meta as object | undefined),
    } } : params,
  }) });
}

export async function shape(response: Response) {
  return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
}

export async function runRoutes() {
  const realNow = Date.now;
  Date.now = () => 1_798_675_200_000;
  const traces: string[] = [];
  const backend = memoryStorage();
  const storage: KVStorage = {
    ...backend,
    get: (...args) => { traces.push("storage.get"); return backend.get(...args); },
    set: (...args) => { traces.push("storage.set"); return backend.set(...args); },
    delete: (...args) => { traces.push("storage.delete"); return backend.delete(...args); },
    list: (...args) => { traces.push("storage.list"); return backend.list(...args); },
    compareAndSet: (...args) => { traces.push("storage.cas"); return backend.compareAndSet(...args); },
  };
  const auth = {
    kind: "proof", activityActorNamespace: "proof",
    authorize(request: Request) {
      traces.push("auth");
      if (request.bodyUsed) throw new Error("Body consumed before authorization");
      return request.headers.get("authorization") === "Bearer proof"
        ? { ok: true as const, principal, userId: "alice" }
        : { ok: false as const, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
    },
  };
  const ui = operatorUi();
  const deployment = createConnecta({
    connectors: [api("notes", { description: "Notes", tools: [
      { name: "read", description: "Read notes", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, handler: async () => ({ value: "ok" }) },
      { name: "write", description: "Write notes", inputSchema: { type: "object" }, annotations: { readOnlyHint: false }, handler: async () => { traces.push("write"); return { saved: true }; } },
      { name: "hidden", description: "Hidden", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, handler: async () => { traces.push("hidden"); return null; } },
    ] })],
    classification: { notes: { hidden: "hidden" } },
    executor: executor(), readOnly: false, storage,
    vault: encryptedCredentialVault(storage, btoa("0123456789abcdef0123456789abcdef")),
    auth, maintainers: [principal], publicUrl: BASE, logger: "silent",
    ui: { ...ui, handle(context) { traces.push("ui"); return ui.handle(context); } },
    pools: {
      meta: { tools: ["notes"], members: [principal] },
      native: { tools: ["notes"], members: [principal], surface: "native" },
      nocode: { tools: ["notes"], members: [principal], surface: "native", executeCode: false },
      reads: { tools: ["notes"], members: [principal], surface: "native", readOnly: true },
    },
  });
  const observations: Array<{ label: string; response: Awaited<ReturnType<typeof shape>>; trace: string[] }> = [];
  const observe = async (label: string, request: Request) => {
    traces.length = 0;
    const response = await shape(await deployment.fetch(request));
    observations.push({ label, response, trace: [...traces] });
    return response;
  };
  try {
    for (const path of ["/", "/ui", "/ui/data", "/ui/credentials/notes", "/ui/oauth/notes", "/connect/notes", "/oauth/callback/notes", "/.well-known/oauth-client-metadata", "/.well-known/oauth-protected-resource", "/.well-known/missing", "/health", "/mcp", "/mcp/meta", "/missing", "/%68ealth", "//health", "/health/", "/%2e/health", "/AGENT/native", "//agent/native", "/%61gent/native", "/%2561gent/native", "/agent%2Fnative", "/agent", "/agent/../ui/data", "/agent/native/", "/agentish/ui/data"]) {
      for (const method of ["GET", "HEAD", "OPTIONS", "DELETE"]) {
        await observe(`${method} ${path}`, new Request(BASE + path, { method }));
      }
    }
    for (const path of ["/mcp", "/mcp/meta"]) {
      await observe(`origin-first ${path}`, new Request("http://127.0.0.1" + path, { method: "POST", headers: { origin: "https://refused.test" }, body: "malformed" }));
      await observe(`upgrade ${path}`, new Request("http://127.0.0.1" + path));
      await observe(`auth-before-body ${path}`, new Request(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: "malformed" }));
    }
    let bodyReads = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { bodyReads++; controller.enqueue(new TextEncoder().encode("malformed")); controller.close(); } }, { highWaterMark: 0 });
    const unread = new Request(BASE + "/mcp", { method: "POST", body, duplex: "half" } as RequestInit);
    await observe("unread unauthorized body", unread);
    // The server transfers this Request's body to its local-signal Request.
    // Check disturbance on that local Request in authorize, not this source.
    observations.at(-1)!.trace.push(`native-body-pulls:${bodyReads}`);
    await unread.body?.cancel().catch(() => {});

    for (const modern of [true, false]) {
      const prefix = modern ? "modern" : "legacy";
      for (const path of ["/mcp", "/mcp/meta", "/mcp/native", "/mcp/nocode", "/mcp/reads"]) {
        await observe(`${prefix} ${path} list`, rpcRequest("tools/list", {}, modern, path));
      }
      for (const [name, args] of [
        ["search_tools", { query: "read" }], ["authorize_connector", { connector: "notes" }],
        ["call_tool", { address: "notes.read", args: {} }], ["call_destructive_tool", { address: "notes.write", args: {} }],
        ["execute_code", { code: "async () => { return null; }" }], ["skills", {}],
      ] as const) {
        await observe(`${prefix} tool ${name}`, rpcRequest("tools/call", { name, arguments: args }, modern));
      }
      for (const method of ["server/discover", "ping", "resources/list", "resources/templates/list", "prompts/list", "tasks/list", "subscriptions/listen", "unknown"]) {
        await observe(`${prefix} ${method}`, rpcRequest(method, {}, modern));
      }
      for (const path of ["/mcp/nocode", "/mcp/reads"]) {
        for (const name of ["notes__read", "notes__write", "notes__hidden", "execute_code"]) {
          await observe(`${prefix} ${path} ${name}`, rpcRequest("tools/call", { name, arguments: {} }, modern, path));
        }
      }
    }
    for (const [label, req] of [
      ["method mismatch", rpcRequest("tools/list", {}, true, "/mcp", { "mcp-method": "tools/call" })],
      ["name mismatch", rpcRequest("tools/call", { name: "call_tool", arguments: { address: "notes.read" } }, true, "/mcp", { "mcp-name": "different" })],
      ["parameter mismatch", rpcRequest("tools/call", { name: "call_tool", arguments: { address: "notes.read" } }, true, "/mcp", { "mcp-param-address": "different" })],
      ["malformed authenticated", new Request(BASE + "/mcp", { method: "POST", headers: { authorization: "Bearer proof", "content-type": "application/json" }, body: "malformed" })],
    ] as const) await observe(label, req);
    await deployment.close();
    await observe("health after close", new Request(BASE + "/health"));
    await observe("mcp after close", rpcRequest("tools/list"));
    return observations;
  } finally { await deployment.close(); Date.now = realNow; }
}

/** Real Effect schemas/codec/transport, with captured current tool descriptors.
 * Handles are deliberately synthetic: this proves wire projection, not invocation.
 */
export function effectMcp(tools: ReadonlyArray<Record<string, unknown>>, mode: "request" | "session" | "invalid-legacy" = "request") {
  const registration = Layer.effectDiscard(Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const tool of tools) yield* server.addTool({
      tool: new McpSchema.Tool(tool as ConstructorParameters<typeof McpSchema.Tool>[0]),
      annotations: Context.empty(),
      handle: (payload: { fail?: boolean; input?: boolean }) => Effect.succeed(
        payload.input
          ? new McpSchema.InputRequired({ requestState: "opaque-proof-state", inputRequests: { auth: { method: "elicitation/create", params: { mode: "url", message: "Connect account", url: "https://proof.test/connect/notes", elicitationId: "proof" } } } })
          : new McpSchema.CallToolResult({ content: [{ type: "text", text: "proof" }], structuredContent: { value: "proof" }, ...(payload.fail ? { isError: true } : {}) }),
      ),
    });
    yield* server.addResource({
      resource: new McpSchema.Resource({ uri: "connecta://skills/proof", name: "proof", mimeType: "text/plain" }),
      annotations: Context.empty(),
      handle: Effect.succeed(McpSchema.ReadResourceResult.make({ contents: [{ uri: "connecta://skills/proof", mimeType: "text/plain", text: "proof skill" }] })),
    });
  }));
  const options = { name: "connecta", version: "proof", path: "/mcp" as const, instructions: "proof", extensions: { "io.modelcontextprotocol/skills": {} } };
  const layer = mode === "session"
    ? McpServer.layerHttp({ ...options, protocols: [McpProtocol.v2025_06_18, McpProtocol.v2026_07_28], allowSubscriptions: false })
    : McpServer.layerHttpRequestScoped({ ...options, protocols: mode === "invalid-legacy"
      // Deliberately simulate an untyped adapter; the public type correctly refuses it.
      ? [McpProtocol.v2025_06_18 as unknown as typeof McpProtocol.v2026_07_28]
      : [McpProtocol.v2026_07_28] });
  return registration.pipe(Layer.provideMerge(layer));
}

/** No toWebHandler/second scheduler. Consume response before closing request scope. */
async function effectExchange(tools: ReadonlyArray<Record<string, unknown>>, request: Request, mode: "request" | "session" | "invalid-legacy" = "request") {
  if (mode === "invalid-legacy") return runEdge(Effect.scoped(HttpRouter.toHttpEffect(effectMcp(tools, mode)))).then(() => { throw new Error("Unexpected successful construction"); });
  return runEdge(Effect.scoped(Effect.gen(function* () {
    let result: Awaited<ReturnType<typeof shape>> | undefined;
    const serve = Effect.gen(function* () {
      const handler = yield* HttpRouter.toHttpEffect(effectMcp(tools, mode));
      return yield* handler;
    });
    // Unlike a direct asHttpEffect conversion, this public seam runs protocol
    // pre-response hooks (including session headers) in the same edge fiber.
    yield* HttpEffect.toHandled(serve, (_request, response) => Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      result = yield* Effect.promise(() => shape(HttpServerResponse.toWeb(response, { context, signal: request.signal })));
    })).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)));
    if (!result) return yield* Effect.die(new Error("Effect exchange produced no response"));
    return result;
  })), { signal: request.signal });
}

export async function runMcp(tools: ReadonlyArray<Record<string, unknown>>) {
  const observations: Record<string, Awaited<ReturnType<typeof shape>>> = {};
  const observe = async (name: string, request: Request, mode: "request" | "session" = "request") => { observations[name] = await effectExchange(tools, request, mode); };
  await observe("modern list", rpcRequest("tools/list"));
  for (const tool of tools) {
    await observe(`modern call ${tool.name}`, rpcRequest("tools/call", { name: tool.name, arguments: {} }));
  }
  await observe("modern isError", rpcRequest("tools/call", { name: tools[0]!.name, arguments: { fail: true } }));
  await observe("modern input required", rpcRequest("tools/call", { name: tools[0]!.name, arguments: { input: true } }));
  await observe("modern input required supported", rpcRequest("tools/call", { name: tools[0]!.name, arguments: { input: true }, _meta: { "io.modelcontextprotocol/clientCapabilities": { elicitation: { url: {} } } } }));
  await observe("modern unverified continuation", rpcRequest("tools/call", { name: tools[0]!.name, arguments: {}, requestState: "forged-state", inputResponses: {} }));
  for (const method of ["server/discover", "ping", "resources/list", "resources/templates/list", "prompts/list", "tasks/list", "subscriptions/listen", "unknown"]) await observe(`modern ${method}`, rpcRequest(method));
  await observe("modern method mismatch", rpcRequest("tools/list", {}, true, "/mcp", { "mcp-method": "tools/call" }));
  await observe("modern name mismatch", rpcRequest("tools/call", { name: tools[0]!.name, arguments: {} }, true, "/mcp", { "mcp-name": "wrong" }));
  await observe("modern parameter mismatch", rpcRequest("tools/call", { name: tools[0]!.name, arguments: {} }, true, "/mcp", { "mcp-param-name": "wrong" }));
  await observe("modern resource read", rpcRequest("resources/read", { uri: "connecta://skills/proof" }));
  await observe("modern initialize", rpcRequest("initialize", { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "proof", version: "1" } }));
  const notification = rpcRequest("notifications/initialized");
  const notificationBody = JSON.parse(await notification.text());
  delete notificationBody.id;
  await observe("modern notification", new Request(notification, { method: "POST", body: JSON.stringify(notificationBody) }));
  await observe("legacy fresh list", rpcRequest("tools/list", {}, false), "session");
  await observe("legacy initialize", rpcRequest("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "proof", version: "1" } }, false), "session");
  const session = observations["legacy initialize"]!.headers["mcp-session-id"];
  if (session) await observe("legacy fresh handler after initialize", rpcRequest("tools/list", {}, false, "/mcp", { "mcp-session-id": session }), "session");
  let legacyConstruction = "unexpected success";
  try { await effectExchange(tools, rpcRequest("tools/list", {}, false), "invalid-legacy"); }
  catch (error) { legacyConstruction = error instanceof Error ? error.message : String(error); }
  // Do not retain generated identifiers in the reusable report.
  if (observations["legacy initialize"]!.headers["mcp-session-id"]) observations["legacy initialize"]!.headers["mcp-session-id"] = "issued";
  const client = new Client({ name: "proof", version: "1" }, { versionNegotiation: { mode: "auto" } });
  const transport = new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { fetch: async (input, init) => {
    const response = await effectExchange(tools, new Request(input, init));
    return new Response(response.body || null, { status: response.status, headers: response.headers });
  } });
  let sdkClient: { tools: string[]; era: string | undefined } | { error: string };
  try {
    await client.connect(transport);
    const result = await client.listTools();
    sdkClient = { tools: result.tools.map((tool) => tool.name), era: client.getProtocolEra() };
  } catch (error) { sdkClient = { error: error instanceof Error ? error.message : String(error) }; }
  finally { await client.close(); }
  return { observations, legacyConstruction, sdkClient };
}

/** Raw response identity and error/Scope behavior of the reusable router seam. */
export async function runRouterSeam() {
  const request = new Request(BASE + "/owned");
  const context = { request } as RouteContext;
  const response = new Response("owned", { status: 405, headers: { allow: "PUT", "content-type": "application/json", "set-cookie": "a=1; Path=/" } });
  const actual = await runEdge(matchModule(context, ["/owned"], Effect.succeed(response)));
  const missing = await runEdge(matchModule(context, ["/other"], Effect.die("must not run")));
  const unowned = await runEdge(matchModule(context, ["*"], Effect.succeed(null)));
  const reason = new Error("payload-shaped-private-error");
  let sameError = false;
  try { await runEdge(matchModule(context, ["/owned"], Effect.fail(reason))); } catch (error) { sameError = error === reason; }
  let finalized = 0;
  await runEdge(Effect.scoped(Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => { finalized++; }));
    yield* matchModule(context, ["/owned"], Effect.succeed(new Response(null, { status: 204 })));
    yield* Scope.Scope;
  })));
  return { identity: actual === response, missing, unowned, sameError, finalized, response: await shape(response) };
}

/** Exercise actual body-held request permits through the compiled dispatcher. */
export async function runLifetimes() {
  const rows = [];
  for (const mode of ["end", "failure", "cancel", "abort", "abandon"] as const) {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let cancels = 0;
    let localSignal: AbortSignal | undefined;
    const deployment = createConnecta({ readOnly: false, connectors: [], executor: executor(), logger: "silent", maintainers: [principal],
      admission: { requests: { concurrency: 1, maxQueueSize: 0, maxDurationMs: mode === "abandon" ? 50 : 2000 } },
      auth: { kind: "proof", authorize: (request) => {
        localSignal = request.signal;
        return { ok: false as const, response: new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; controller.enqueue(new TextEncoder().encode("slow")); }, cancel() { cancels++; } }), { status: 401 }) };
      } },
    });
    const active = async () => ((await (await deployment.fetch(new Request(BASE + "/health"))).json()) as { admission: { requests: { active: number } } }).admission.requests.active;
    const caller = new AbortController();
    try {
      const response = await deployment.fetch(new Request(BASE + "/mcp", { signal: caller.signal }));
      const held = await active();
      let bodyFailed = false;
      if (mode === "end") { source.close(); await response.text(); }
      if (mode === "failure") { source.error(new Error("private-stream-failure")); try { await response.text(); } catch { bodyFailed = true; } }
      if (mode === "cancel") await response.body?.cancel("cancelled");
      if (mode === "abort") caller.abort(new Error("caller-reason"));
      if (mode === "abandon") await new Promise((resolve) => setTimeout(resolve, 100));
      // Allow only finalizer microtasks, no retries that could conceal leaks.
      await Promise.resolve();
      const released = await active();
      const before = cancels;
      await response.body?.cancel().catch(() => {});
      rows.push({ mode, held, released, bodyFailed, cancels: before, afterSecondCancel: cancels, localAborted: localSignal?.aborted });
    } finally { await deployment.close(); }
  }
  const reason = new Error("original-caller-reason");
  let sameReason = false;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const abort = new AbortController();
  const deployment = createConnecta({ readOnly: false, connectors: [], executor: executor(), logger: "silent", maintainers: [principal],
    auth: { kind: "proof", authorize() { started(); return new Promise(() => {}); } },
  });
  const waiting = deployment.fetch(new Request(BASE + "/mcp", { signal: abort.signal })).catch((error) => { sameReason = error === reason; });
  await ready;
  abort.abort(reason);
  await waiting;
  await deployment.close();
  return { rows, sameReason };
}

// A single lazily constructed deployment shared by separate native Worker requests.
let queued: ReturnType<typeof createConnecta> | undefined;
let secondReads = 0;
let waiterArrived = false;
let releaseQueuedBody = false;
export function queueFetch(request: Request) {
  const path = new URL(request.url).pathname;
  if (path === "/queue-release") { releaseQueuedBody = true; return Promise.resolve(Response.json({ released: true })); }
  if (request.headers.get("x-proof-waiter") === "yes") waiterArrived = true;
  queued ??= createConnecta({ readOnly: false, connectors: [], executor: executor(), logger: "silent", publicUrl: BASE,
    admission: { requests: { concurrency: 1, maxQueueSize: 2, queueTimeoutMs: 2000 } }, maintainers: [principal],
    auth: { kind: "proof", authorize: async (req) => {
      if (req.headers.get("x-proof-waiter") === "yes") {
        secondReads++;
        const body = await req.text();
        const native = await fetch("https://context.proof.test/" + body);
        return { ok: false as const, response: new Response(await native.text(), { status: 401 }) };
      }
      return { ok: false as const, response: new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode("held"));
        const until = Date.now() + 5000;
        const finishInOwningRequest = () => {
          if (releaseQueuedBody) controller.close();
          else if (Date.now() >= until) controller.error(new Error("Queue proof control timed out"));
          else setTimeout(finishInOwningRequest, 5);
        };
        setTimeout(finishInOwningRequest, 5);
      } }), { status: 401 }) };
    } },
  });
  if (path === "/queue-state") return Promise.resolve(Response.json({ secondReads, waiterArrived }));
  return queued.fetch(request);
}

/** Fresh agent tokens prove both namespace presentations on actual SDK leaves. */
export async function runAgentNamespaces() {
  const storage = memoryStorage();
  const deployment = createConnecta({ readOnly: false, connectors: [api("notes", { tools: [{ name: "read", description: "Read", annotations: { readOnlyHint: true }, inputSchema: { type: "object" }, handler: async () => "ok" }] })],
    executor: executor(), storage, accessTokens: accessTokens(storage), agents: ["assistant"], logger: "silent", publicUrl: BASE,
    pools: { native: { tools: ["notes"], members: ["agent:assistant"], surface: "native", executeCode: false } },
  });
  try {
    const { token } = await new AccessTokenManager(storage, { agents: ["assistant"] }).rotate("assistant", "proof");
    const rows = [];
    for (const modern of [true, false]) for (const path of ["/mcp/native", "/agent/native"]) rows.push(await shape(await deployment.fetch(rpcRequest("tools/list", {}, modern, path, { authorization: `Bearer ${token}` }))));
    return rows;
  } finally { await deployment.close(); }
}
