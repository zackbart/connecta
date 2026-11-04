// Node-only: exercises Eve's Node 24 runtime and a real local HTTP agent endpoint.
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { always, type ApprovalContext } from "eve/tools/approval";
import { type McpClientConnectionDefinition, defineMcpClientConnection } from "eve/connections";
import {
  type DynamicContext,
  type DynamicInstructionsResult,
  type DynamicSentinel,
  type Memo,
  defineDynamic,
} from "eve/instructions";
// Eve keeps a defineDynamic() function behind a private symbol; read it as its runtime does.
import { dynamicEvaluate } from "../node_modules/eve/dist/src/dynamic/definition.js";
import { rankCandidates } from "../node_modules/eve/dist/src/execution/catalog/rank.js";
import { createConnecta, customExecutor } from "../../../src/index.js";
import { accessTokens, AccessTokenManager } from "../../../src/access-tokens.js";
import { api } from "../../../src/connectors/api.js";
import { memoryStorage } from "../../../src/storage/memory.js";
import { CONNECTA_VERSION } from "../src/version.js";
import {
  connectaConnection,
  connectaEndpoint,
  connectaInstructions,
  connectaSkill,
  gateConnectaWrites,
} from "../src/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// What the helper prepends when a server advertises no endpoint facts.
const EVE_GUIDE =
  'Connecta tools are deferred: call eve__tool({ name: "connecta__<tool>", input }). Names in this guidance and in nextAction omit the "connecta__" prefix.';
const guided = (text: string) => `Connecta guidance:\n${EVE_GUIDE}\n${text}`;

// Assignment checks use real Eve types, including the public return types.
type IsAny<T> = 0 extends 1 & T ? true : false;
const connectionIsAny: IsAny<ReturnType<typeof connectaConnection>> = false;
const instructionsAreAny: IsAny<ReturnType<typeof connectaInstructions>> = false;
void [connectionIsAny, instructionsAreAny];

// Models Eve's memo store for one session of one definition: an evaluation
// reads the kept JSON results, and only a successful evaluation replaces them
// with the keys it used. A throwing memo keeps nothing.
function session(instructions: DynamicSentinel<DynamicInstructionsResult>) {
  let kept = new Map<string, unknown>();
  return async (id: string | null, abortSignal = new AbortController().signal) => {
    const used = new Map<string, unknown>();
    const memo: Memo = async (key, fn) => {
      const memoKey = JSON.stringify(key);
      const value = kept.has(memoKey)
        ? kept.get(memoKey)
        : JSON.parse(JSON.stringify((await fn({ idempotencyKey: memoKey, abortSignal })) ?? null));
      used.set(memoKey, value);
      return structuredClone(value) as never;
    };
    // The resolver reads only the turn and memo; the rest of the frame is irrelevant.
    const frame = { memo, turn: id === null ? null : { id, status: "running", input: [] } };
    const result = await dynamicEvaluate(instructions)(frame as unknown as DynamicContext);
    kept = used;
    return result;
  };
}

// Each call evaluates a new turn of one session per definition unless it names one.
let turns = 0;
const sessions = new WeakMap<object, ReturnType<typeof session>>();
function turn(instructions: DynamicSentinel<DynamicInstructionsResult>, id = `turn_${++turns}`) {
  let current = sessions.get(instructions);
  if (!current) sessions.set(instructions, (current = session(instructions)));
  return current(id);
}

// Narrow the real Eve factory's public auth union without replacing Eve's
// types with ambient stand-ins.
function authOf(connection: McpClientConnectionDefinition) {
  const auth = connection.auth;
  if (!auth || typeof auth === "function" || !("getToken" in auth) || !auth.getToken) {
    throw new Error("Missing app token resolver");
  }
  return auth;
}

function approvalContext(toolAnnotations?: ApprovalContext["toolAnnotations"]): ApprovalContext {
  // The additional runtime context is irrelevant to an annotation-only policy.
  return { toolName: "crm__read", toolAnnotations } as ApprovalContext;
}

it("defines real Eve connections, endpoint defaults, rotating app auth and approval policies", async () => {
  const helperManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const coreManifest = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  expect(helperManifest.version).toBe(coreManifest.version);
  vi.stubEnv("CONNECTA_URL", "https://connecta.example.com/");
  vi.stubEnv("CONNECTA_ACCESS_TOKEN", "cta_first");
  expect(connectaEndpoint({ pool: "assistant" })).toBe("https://connecta.example.com/agent/assistant");
  expect(connectaEndpoint({ url: "https://connecta.example.com/agent/assistant" })).toBe(
    "https://connecta.example.com/agent/assistant",
  );
  expect(() => connectaEndpoint({ pool: "../mcp" })).toThrow("must match");
  const connection: ReturnType<typeof defineMcpClientConnection> = connectaConnection({
    description: "CRM and tickets",
  });
  expect(authOf(connection)).toMatchObject({ principalType: "app" });
  expect(
    await authOf(connection).getToken!({ principal: { type: "app" }, connection: { url: connection.url } }),
  ).toMatchObject({ token: "cta_first" });
  vi.stubEnv("CONNECTA_ACCESS_TOKEN", "cta_rotated");
  expect(
    await authOf(connection).getToken!({ principal: { type: "app" }, connection: { url: connection.url } }),
  ).toMatchObject({ token: "cta_rotated" });
  vi.stubEnv("CONNECTA_ACCESS_TOKEN", "");
  await expect(
    authOf(connection).getToken!({ principal: { type: "app" }, connection: { url: connection.url } }),
  ).rejects.toThrow("CONNECTA_ACCESS_TOKEN");
  const policy = connection.approval;
  if (typeof policy !== "function") throw new Error("Missing default approval policy");
  expect(await policy(approvalContext({ readOnlyHint: false }))).toBe("not-applicable");
  expect(gateConnectaWrites(approvalContext({ readOnlyHint: true }))).toBe("not-applicable");
  expect(gateConnectaWrites(approvalContext({ readOnlyHint: false, destructiveHint: true }))).toBe("user-approval");
  expect(gateConnectaWrites(approvalContext())).toBe("user-approval");
  expect(connectaConnection({ description: "CRM", gateWrites: true }).approval).toBe(gateConnectaWrites);
  const explicit = always();
  expect(connectaConnection({ description: "CRM", gateWrites: true, approval: explicit }).approval).toBe(explicit);
  let token = "oidc_first";
  const oidc = connectaConnection({ description: "CRM", getToken: async () => token });
  expect(await authOf(oidc).getToken!({ principal: { type: "app" }, connection: { url: oidc.url } })).toMatchObject({
    token,
  });
  token = "oidc_next";
  expect(await authOf(oidc).getToken!({ principal: { type: "app" }, connection: { url: oidc.url } })).toMatchObject({
    token,
  });
  vi.stubEnv("CONNECTA_URL", "");
  expect(() => connectaEndpoint()).toThrow("CONNECTA_URL");
});

it("discovers instructions, falls back to initialize/SSE, caches successes and fails open", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const requests: Array<{ method: string; authorization: string | null; headers: Headers }> = [];
  let state: "modern" | "legacy" | "failed" = "modern";
  let token = "cta_first";
  const fetcher: typeof fetch = async (_url, init) => {
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    const headers = new Headers(init?.headers);
    requests.push({ method, authorization: headers.get("Authorization"), headers });
    if (state === "failed") throw new Error("Unavailable");
    if (state === "legacy") {
      if (method === "server/discover") return Response.json({ error: { code: -32601 } });
      return new Response(
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"instructions":"Legacy guidance"}}\n\n',
      );
    }
    return Response.json({ jsonrpc: "2.0", id: 1, result: { instructions: "Modern guidance" } });
  };
  const instructions: ReturnType<typeof defineDynamic> = connectaInstructions({
    url: "https://connecta.example.com/agent/assistant",
    getToken: () => token,
    fetch: fetcher,
  });
  expect(await turn(instructions)).toMatchObject({ content: guided("Modern guidance") });
  expect(await turn(instructions)).toMatchObject({ content: guided("Modern guidance") });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe("server/discover");
  expect(requests[0]?.headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
  expect(requests[0]?.authorization).toBe("Bearer cta_first");
  vi.setSystemTime(Date.now() + 600_001);
  state = "legacy";
  token = "cta_rotated";
  const legacy = await turn(instructions);
  expect(legacy).toMatchObject({ content: guided("Legacy guidance") });
  expect(requests.slice(1).map((r) => [r.method, r.authorization])).toEqual([
    ["server/discover", "Bearer cta_rotated"],
    ["initialize", "Bearer cta_rotated"],
  ]);
  vi.setSystemTime(Date.now() + 600_001);
  state = "failed";
  expect(await turn(instructions)).toEqual(legacy);
  const failedRequests = requests.length;
  expect(await turn(instructions)).toEqual(legacy);
  expect(requests).toHaveLength(failedRequests);
  expect(
    await turn(connectaInstructions({ url: "https://connecta.example.com", getToken: () => token, fetch: fetcher })),
  ).toBeNull();
});

it("keeps one result per turn and session across Eve's repeated evaluations", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  let fetches = 0;
  let signal: AbortSignal | null | undefined;
  const fetcher: typeof fetch = async (_url, init) => {
    fetches++;
    signal = init?.signal;
    return Response.json({ result: { instructions: `Guidance ${fetches}` } });
  };
  const instructions = connectaInstructions({
    url: "https://connecta.example.com",
    getToken: () => "cta_agent",
    fetch: fetcher,
    ttlMs: 0,
  });
  const alice = session(instructions);
  expect(await alice("turn_1")).toMatchObject({ content: guided("Guidance 1") });
  expect(signal).toBeInstanceOf(AbortSignal);
  vi.setSystemTime(Date.now() + 1);
  // A later model call in the same turn reuses the memo despite the expired cache.
  expect(await alice("turn_1")).toMatchObject({ content: guided("Guidance 1") });
  expect(fetches).toBe(1);
  // Memos are per session: another session's same turn ID fetches its own.
  vi.setSystemTime(Date.now() + 1);
  expect(await session(instructions)("turn_1")).toMatchObject({ content: guided("Guidance 2") });
  vi.setSystemTime(Date.now() + 1);
  expect(await alice("turn_2")).toMatchObject({ content: guided("Guidance 3") });
  // Before the first turn the key is null, and it is reused like any other.
  const bob = session(instructions);
  vi.setSystemTime(Date.now() + 1);
  expect(await bob(null)).toMatchObject({ content: guided("Guidance 4") });
  expect(await bob(null)).toMatchObject({ content: guided("Guidance 4") });
  expect(fetches).toBe(4);
});

it("rethrows Eve's cancellation without keeping a result or delaying other sessions", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  let fetches = 0;
  let started: () => void = () => {};
  const fetcher: typeof fetch = async (_url, init) => {
    fetches++;
    if (fetches === 1) {
      started();
      // Like a real fetch, reject when the combined signal aborts.
      await new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
      );
    }
    return Response.json({ result: { instructions: "Healthy guidance" } });
  };
  const instructions = connectaInstructions({
    url: "https://connecta.example.com",
    getToken: () => "cta_agent",
    fetch: fetcher,
  });
  const alice = session(instructions);
  const controller = new AbortController();
  const inFlight = new Promise<void>((resolve) => (started = resolve));
  const aborted = alice("turn_1", controller.signal);
  await inFlight;
  controller.abort(new DOMException("Cancelled", "AbortError"));
  await expect(aborted).rejects.toThrow("Cancelled");
  const cancelled = new AbortController();
  cancelled.abort(new DOMException("Cancelled", "AbortError"));
  await expect(alice("turn_1", cancelled.signal)).rejects.toThrow("Cancelled");
  expect(fetches).toBe(1);
  // No backoff started: a healthy session fetches at once, and the cancelled
  // turn kept nothing, so its retry gets the guidance too.
  expect(await session(instructions)("turn_1")).toMatchObject({ content: guided("Healthy guidance") });
  expect(await alice("turn_1")).toMatchObject({ content: guided("Healthy guidance") });
  expect(fetches).toBe(2);
});

it.each(["network", "timeout"])(
  "does not initialize after a discovery %s failure and waits before retrying",
  async (kind) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const methods: string[] = [];
    let fail = true;
    const fetcher: typeof fetch = async (_url, init) => {
      methods.push((JSON.parse(String(init?.body)) as { method: string }).method);
      if (fail) {
        throw kind === "timeout" ? new DOMException("Timed out", "TimeoutError") : new TypeError("Network unavailable");
      }
      return Response.json({ result: { instructions: "Recovered guidance" } });
    };
    const instructions = connectaInstructions({
      url: "https://connecta.example.com",
      getToken: () => "cta_agent",
      fetch: fetcher,
    });
    expect(await turn(instructions)).toBeNull();
    expect(await turn(instructions)).toBeNull();
    expect(methods).toEqual(["server/discover"]);
    fail = false;
    vi.setSystemTime(Date.now() + 29_999);
    expect(await turn(instructions)).toBeNull();
    expect(methods).toHaveLength(1);
    vi.setSystemTime(Date.now() + 1);
    expect(await turn(instructions)).toMatchObject({ content: guided("Recovered guidance") });
    expect(methods).toEqual(["server/discover", "server/discover"]);
  },
);

it("loads scoped instructions from a real local Connecta agent endpoint", async () => {
  const storage = memoryStorage();
  const token = (await new AccessTokenManager(storage, { agents: ["assistant"] }).rotate("assistant", "test")).token;
  const app = createConnecta({
    readOnly: true,
    storage,
    accessTokens: accessTokens(storage),
    agents: ["assistant"],
    pools: { assistant: { description: "CRM for the assistant", members: ["agent:assistant"], tools: ["crm"] } },
    connectors: [
      api("crm", {
        usageGuide: "Use stable CRM ids.",
        tools: [
          { name: "read", description: "Read CRM", annotations: { readOnlyHint: true }, handler: () => ({ ok: true }) },
        ],
      }),
    ],
    executor: customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }),
  });
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await app.fetch(
        new Request(`http://127.0.0.1${req.url}`, {
          method: req.method ?? "POST",
          headers: req.headers as Record<string, string>,
          body: Buffer.concat(chunks),
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    const url = `http://127.0.0.1:${address.port}`;
    const instructions = connectaInstructions({ url, pool: "assistant", getToken: () => token });
    const result = await turn(instructions);
    expect(result?.content).toContain("CRM for the assistant");
    const skill = connectaSkill({
      url,
      pool: "assistant",
      getToken: () => token,
      name: "connector:crm",
      description: "CRM conventions",
    });
    const frame = {
      memo: async (_key: unknown, fn: (ctx: unknown) => unknown) => fn({ abortSignal: new AbortController().signal }),
      turn: { id: "real" },
    } as unknown as DynamicContext;
    expect(await dynamicEvaluate(skill)(frame)).toMatchObject({
      deferred: true,
      content: expect.stringContaining("Use stable CRM ids."),
    });
    expect(Object.getOwnPropertySymbols(instructions).some((s) => String(s).includes("eve."))).toBe(true);
    expect(await turn(connectaInstructions({ url, pool: "assistant", getToken: () => "cta_invalid" }))).toBeNull();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await app.close();
  }
});

it("projects opt-in deferred skills through real Eve with caller policy before any fetch", async () => {
  let allowed = false;
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ result: { content: [{ type: "text", text: "Use stable CRM ids." }] } }),
  );
  const skill = connectaSkill({
    url: "https://connecta.example.com",
    pool: "crm",
    name: "connector:crm",
    description: "CRM conventions",
    getToken: () => "cta_test",
    when: () => allowed,
    fetch: fetcher,
  });
  const resolve = dynamicEvaluate(skill);
  const frame = {
    memo: async (_key: unknown, fn: (ctx: unknown) => unknown) => fn({ abortSignal: new AbortController().signal }),
    turn: { id: "one" },
  } as unknown as DynamicContext;
  expect(await resolve(frame)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  allowed = true;
  const projected = await resolve(frame);
  expect(projected).toMatchObject({ deferred: true, description: "CRM conventions", content: "Use stable CRM ids." });
  expect(projected).not.toHaveProperty("tools");
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({
    method: "tools/call",
    params: { name: "skills", arguments: { name: "connector:crm" } },
  });
});

// A real local Connecta over HTTP, as the Eve app reaches a deployment.
async function localConnecta(
  pool: Partial<NonNullable<Parameters<typeof createConnecta>[0]["pools"]>[string]>,
  run: (url: string, token: string) => Promise<void>,
) {
  const storage = memoryStorage();
  const token = (await new AccessTokenManager(storage, { agents: ["assistant"] }).rotate("assistant", "test")).token;
  const read = { annotations: { readOnlyHint: true }, handler: () => ({ ok: true }) };
  const app = createConnecta({
    readOnly: false,
    storage,
    accessTokens: accessTokens(storage),
    agents: ["assistant"],
    pools: { assistant: { members: ["agent:assistant"], tools: ["crm", "billing", "tickets"], ...pool } },
    connectors: [
      api("crm", { tools: [{ name: "list_invoices", description: "List customer invoices", ...read }] }),
      api("billing", { tools: [{ name: "get_invoice", description: "Get one invoice", ...read }] }),
      api("tickets", { tools: [{ name: "send_email", description: "Send an email", ...read }] }),
    ],
    executor: customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }),
  });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await app.fetch(
      new Request(`http://127.0.0.1${req.url}`, {
        method: req.method ?? "POST",
        headers: req.headers as Record<string, string>,
        body: Buffer.concat(chunks),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    await run(`http://127.0.0.1:${address.port}`, token);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await app.close();
  }
}

// `facts` is what a server advertises in capabilities.extensions.
function discovering(
  facts: unknown,
  server: { name: string; version: string } = { name: "connecta", version: CONNECTA_VERSION },
) {
  return vi.fn<typeof fetch>(async () =>
    Response.json({
      result: {
        instructions: "Server text.",
        capabilities: { extensions: { "dev.connecta/endpoint": facts } },
        _meta: { "io.modelcontextprotocol/serverInfo": server },
      },
    }),
  );
}

const META_GUIDE = (name: string, reachable: string) =>
  `Connecta tools are deferred: call eve__tool({ name: "${name}__<tool>", input }). Names in this guidance and in nextAction omit the "${name}__" prefix. Go straight to ${name}__execute_code without eve__search, input { code: "async () => { const { tools } = await connecta.search({ query: 'list invoices', safety: 'readOnly' }); const r = await connecta.call(tools[0].address, {}); return r.data; }" }. eve__search sees only Connecta's routing tools, never downstream operations, so empty results do not mean a capability is missing; search inside the program. Reachable: ${reachable}.`;

it("prefixes the server's text with the guide for each surface, from a real endpoint's facts", async () => {
  const guide = async (pool: Parameters<typeof localConnecta>[0], connection?: string) => {
    let content = "";
    await localConnecta(pool, async (url, token) => {
      const result = await turn(
        connectaInstructions({ url, pool: "assistant", getToken: () => token, ...(connection ? { connection } : {}) }),
      );
      content = (result as { content: string }).content;
    });
    return content.replace(/^Connecta guidance:\n/, "").split("\n");
  };
  const [meta, metaServer] = await guide({});
  expect(meta).toBe(META_GUIDE("connecta", "crm, billing, tickets"));
  expect(metaServer).toContain("execute_code");
  expect(Buffer.byteLength(meta!)).toBeLessThanOrEqual(620);
  // A connection is named after its file, which the helper is told.
  const [renamed] = await guide({}, "workspace");
  expect(renamed).toBe(META_GUIDE("workspace", "crm, billing, tickets"));
  expect(renamed).not.toContain("connecta__");
  const [native] = await guide({ surface: "native" });
  expect(native).toBe(
    `Connecta tools are deferred: call eve__tool({ name: "connecta__<connector>__<tool>", input }). Find them with eve__search; scope one connector with "connecta__<connector>__", not "<connector>__". Names in this guidance and in nextAction omit "connecta__". For several, dependent or reduced calls, go straight to connecta__execute_code with { code: "async () => { ... }" }, using the program address ending each tool's description. Missing tools: connecta__authorize_connector. Tool lists refresh every step, so no reconnect is needed. Connectors: crm, billing, tickets.`,
  );
  const [lean] = await guide({ surface: "native", executeCode: false });
  expect(lean).toContain('"connecta__<connector>__"');
  expect(lean).not.toContain("execute_code");
});

it("reads the same facts through the legacy initialize fallback", async () => {
  await localConnecta({}, async (url, token) => {
    const legacyOnly: typeof fetch = async (input, init) =>
      JSON.parse(String(init?.body)).method === "server/discover"
        ? Response.json({ error: { code: -32601 } }, { status: 404 })
        : fetch(input, init);
    const result = await turn(
      connectaInstructions({ url, pool: "assistant", getToken: () => token, fetch: legacyOnly }),
    );
    expect((result as { content: string }).content).toContain("Reachable: crm, billing, tickets.");
  });
});

it("keeps Eve's search from widening: the default description matches no capability query", async () => {
  await localConnecta({}, async (url, token) => {
    const response = await fetch(`${url}/agent/assistant`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const { result } = (await response.json()) as {
      result: { tools: { name: string; description: string; inputSchema: object }[] };
    };
    const search = (query: string, description: string) =>
      rankCandidates(
        query,
        result.tools.map((tool) => ({
          ...tool,
          connection: { name: "connecta", description },
          result: () => tool,
          fullName: `connecta__${tool.name}`,
        })),
      ).map((candidate: { name: string }) => candidate.name);
    const description = connectaConnection({ url }).description;
    expect(result.tools).toHaveLength(6);
    for (const query of ["invoices", "get invoice", "send an email", "delete"]) {
      expect(search(query, description)).toEqual([]);
    }
    // Why the roster belongs in instructions: in the description, one word hits every tool.
    expect(search("invoices", "CRM, invoices and tickets")).toHaveLength(6);
  });
});

it("degrades the roster by bytes, sanitizes it, and treats malformed facts as absent", async () => {
  const content = async (facts: unknown) => {
    const result = await turn(
      connectaInstructions({ url: "https://connecta.example.com", getToken: () => "cta", fetch: discovering(facts) }),
    );
    return (result as { content: string }).content;
  };
  const meta = { surface: "meta", executeCode: true, readOnly: false };
  expect(
    await content({
      ...meta,
      connectors: [
        { id: "crm", title: " Customer\n records ", readFirst: "connector:crm" },
        { id: "wiki" },
        { id: 7 },
        null,
      ],
    }),
  ).toContain('Reachable: crm (Customer records; read first: connecta__skills { name: "connector:crm" }), wiki.');
  const native = await content({
    surface: "native",
    executeCode: true,
    connectors: [{ id: "crm", readFirst: "connector:crm" }],
  });
  // Native tool descriptions already carry their guide pointer.
  expect(native).toContain("Connectors: crm.");
  const titled = Array.from({ length: 12 }, (_, index) => ({ id: `c${index}`, title: "x".repeat(60) }));
  const untitled = await content({ ...meta, connectors: titled });
  expect(untitled).toContain("Reachable: c0, c1, c2,");
  expect(untitled).not.toContain("xxx");
  const many = Array.from({ length: 300 }, (_, index) => ({ id: `connector_${index}` }));
  const capped = await content({ ...meta, connectors: many });
  const roster = /Reachable: (.*)\.\n/.exec(capped)?.[1] ?? "";
  expect(Buffer.byteLength(roster)).toBeLessThanOrEqual(512);
  const omitted = Number(/; \+(\d+) more$/.exec(roster)?.[1]);
  expect(roster.split(", ").length + omitted).toBe(300);
  expect(await content({ ...meta, connectors: [] })).not.toContain("Reachable:");
  for (const malformed of [
    undefined,
    "native",
    { surface: "other", executeCode: true, connectors: [] },
    { surface: "meta" },
  ]) {
    expect(await content(malformed)).toBe(guided("Server text."));
  }
  expect(() => connectaInstructions({ connection: 'x" }), do(' })).toThrow("agent/connections");
});

it("defaults the connection description and warns when one gives the model no domain", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const url = "https://connecta.example.com";
  expect(connectaConnection({ url }).description).toBe("Connecta integration gateway.");
  connectaConnection({ url, description: "Shared CRM and tickets for the assistant." });
  connectaConnection({ url, description: "Member records, giving and event registration." });
  expect(warn).not.toHaveBeenCalled();
  for (const description of [
    "tools through Connecta",
    "Acme's company tools through Connecta.",
    "Connecta tools",
    "MCP gateway",
  ]) {
    warn.mockClear();
    connectaConnection({ url, description });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("no domain information");
  }
});

it("sends extra headers beside auth without letting them replace it", async () => {
  vi.stubEnv("CONNECTA_ACCESS_TOKEN", "cta_agent");
  let service = "first";
  const headers = () => ({ "CF-Access-Client-Id": service, Authorization: "Bearer forged", "Mcp-Method": "forged" });
  const fixed = connectaConnection({ url: "https://connecta.example.com", headers: { "X-Edge": "fixed" } });
  expect(fixed.headers).toEqual({ "X-Edge": "fixed" });
  const dynamic = connectaConnection({ url: "https://connecta.example.com", headers });
  if (typeof dynamic.headers !== "function") throw new Error("Missing header resolver");
  service = "second";
  expect(await dynamic.headers({} as never)).toMatchObject({ "CF-Access-Client-Id": "second" });
  const fetcher = discovering(undefined);
  await turn(connectaInstructions({ url: "https://connecta.example.com", headers, fetch: fetcher }));
  const sent = new Headers(fetcher.mock.calls[0]![1]!.headers);
  expect(sent.get("CF-Access-Client-Id")).toBe("second");
  expect(sent.get("Authorization")).toBe("Bearer cta_agent");
  expect(sent.get("Mcp-Method")).toBe("server/discover");
  // A plain object, so an app's wrapping fetch can still spread it.
  expect(fetcher.mock.calls[0]![1]!.headers).not.toBeInstanceOf(Headers);
  const skillFetch = vi.fn<typeof fetch>(async () =>
    Response.json({ result: { content: [{ type: "text", text: "G" }] } }),
  );
  const skill = connectaSkill({
    url: "https://connecta.example.com",
    name: "connector:crm",
    description: "CRM",
    headers,
    fetch: skillFetch,
  });
  await dynamicEvaluate(skill)({
    memo: async (_key: unknown, fn: (ctx: unknown) => unknown) => fn({ abortSignal: new AbortController().signal }),
    turn: { id: "one" },
  } as unknown as DynamicContext);
  const skillSent = new Headers(skillFetch.mock.calls[0]![1]!.headers);
  expect(skillSent.get("CF-Access-Client-Id")).toBe("second");
  expect(skillSent.get("Mcp-Name")).toBe("skills");
});

it("warns once per endpoint when the server is on another release line", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const [major, minor, patch] = CONNECTA_VERSION.split(".");
  const evaluate = (server: { name: string; version: string }, ttlMs?: number) =>
    connectaInstructions({
      url: "https://connecta.example.com",
      getToken: () => "cta",
      fetch: discovering(undefined, server),
      ...(ttlMs === undefined ? {} : { ttlMs }),
    });
  await turn(evaluate({ name: "connecta", version: `${major}.${minor}.${Number(patch) + 1}` }));
  await turn(evaluate({ name: "acme", version: "1" }));
  await turn(evaluate({ name: "connecta", version: "unknown" }));
  expect(warn).not.toHaveBeenCalled();
  const skewed = evaluate({ name: "connecta", version: `${major}.${Number(minor) + 1}.0` }, 0);
  await turn(skewed);
  vi.setSystemTime(Date.now() + 1);
  await turn(skewed);
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]![0]).toContain("different releases");
  // Legacy initialize carries serverInfo in the result instead.
  warn.mockClear();
  await turn(
    connectaInstructions({
      url: "https://connecta.example.com",
      getToken: () => "cta",
      fetch: async () =>
        Response.json({
          result: { instructions: "Text", serverInfo: { name: "connecta", version: `${Number(major) + 1}.0.0` } },
        }),
    }),
  );
  expect(warn).toHaveBeenCalledOnce();
});

it("generates the helper's version from its release", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  expect(CONNECTA_VERSION).toBe(manifest.version);
});
