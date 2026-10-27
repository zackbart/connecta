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
import { createConnecta, customExecutor } from "../../../src/index.js";
import { accessTokens, AccessTokenManager } from "../../../src/access-tokens.js";
import { api } from "../../../src/connectors/api.js";
import { memoryStorage } from "../../../src/storage/memory.js";
import { connectaConnection, connectaEndpoint, connectaInstructions, gateConnectaWrites } from "../src/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

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
    const result = await instructions.evaluate(frame as unknown as DynamicContext);
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
  expect(await turn(instructions)).toMatchObject({ content: "Connecta guidance:\nModern guidance" });
  expect(await turn(instructions)).toMatchObject({ content: "Connecta guidance:\nModern guidance" });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe("server/discover");
  expect(requests[0]?.headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
  expect(requests[0]?.authorization).toBe("Bearer cta_first");
  vi.setSystemTime(Date.now() + 600_001);
  state = "legacy";
  token = "cta_rotated";
  const legacy = await turn(instructions);
  expect(legacy).toMatchObject({ content: "Connecta guidance:\nLegacy guidance" });
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
  expect(await alice("turn_1")).toMatchObject({ content: "Connecta guidance:\nGuidance 1" });
  expect(signal).toBeInstanceOf(AbortSignal);
  vi.setSystemTime(Date.now() + 1);
  // A later model call in the same turn reuses the memo despite the expired cache.
  expect(await alice("turn_1")).toMatchObject({ content: "Connecta guidance:\nGuidance 1" });
  expect(fetches).toBe(1);
  // Memos are per session: another session's same turn ID fetches its own.
  vi.setSystemTime(Date.now() + 1);
  expect(await session(instructions)("turn_1")).toMatchObject({ content: "Connecta guidance:\nGuidance 2" });
  vi.setSystemTime(Date.now() + 1);
  expect(await alice("turn_2")).toMatchObject({ content: "Connecta guidance:\nGuidance 3" });
  // Before the first turn the key is null, and it is reused like any other.
  const bob = session(instructions);
  vi.setSystemTime(Date.now() + 1);
  expect(await bob(null)).toMatchObject({ content: "Connecta guidance:\nGuidance 4" });
  expect(await bob(null)).toMatchObject({ content: "Connecta guidance:\nGuidance 4" });
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
  expect(await session(instructions)("turn_1")).toMatchObject({ content: "Connecta guidance:\nHealthy guidance" });
  expect(await alice("turn_1")).toMatchObject({ content: "Connecta guidance:\nHealthy guidance" });
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
    expect(await turn(instructions)).toMatchObject({ content: "Connecta guidance:\nRecovered guidance" });
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
    expect(Object.getOwnPropertySymbols(instructions).some((s) => String(s).includes("eve."))).toBe(true);
    expect(await turn(connectaInstructions({ url, pool: "assistant", getToken: () => "cta_invalid" }))).toBeNull();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await app.close();
  }
});
