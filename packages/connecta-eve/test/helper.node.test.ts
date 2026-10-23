// Node-only: exercises Eve's Node 24 runtime and a real local HTTP agent endpoint.
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { always, type ApprovalContext } from "eve/tools/approval";
import { type McpClientConnectionDefinition, defineMcpClientConnection } from "eve/connections";
import { type DynamicInstructionsResult, type DynamicSentinel, defineDynamic } from "eve/instructions";
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

function turn(instructions: DynamicSentinel<DynamicInstructionsResult>) {
  const handler = instructions.events["turn.started"];
  if (!handler) throw new Error("Missing turn.started resolver");
  return handler(
    {},
    { model: null, session: { id: "test", auth: { current: null, initiator: null } }, channel: {}, messages: [] },
  );
}

// The real Eve factory normalizes credentialOwner to principalType. Narrow
// its public auth union without replacing Eve's types with ambient stand-ins.
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
  expect(
    await turn(connectaInstructions({ url: "https://connecta.example.com", getToken: () => token, fetch: fetcher })),
  ).toBeNull();
});

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
