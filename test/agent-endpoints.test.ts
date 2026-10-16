import { describe, expect, it, vi } from "vitest";
import { accessTokens } from "../src/access-tokens.js";
import { clerkAuth } from "../src/auth/clerk.js";
import { cloudflareAccessAuth } from "../src/auth/cloudflare-access.js";
import { api } from "../src/connectors/api.js";
import { callerOf } from "../src/connector-caller.js";
import { agentEndpointPool, isAgentPath } from "../src/routes/agent-path.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, InboundAuth, KVStorage } from "../src/types.js";
import { issueAgentToken } from "./helpers/agent-tokens.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { readJsonRpc } from "./fixtures/http.js";
import { scriptedExecutor } from "./fixtures/misc.js";

// Clerk never admits here; these tests only prove it is never asked.
vi.mock("../src/auth/clerk-transport.js", () => ({
  createByteReadingClerkClient: () => ({
    authenticateRequest: async () => ({ toAuth: () => ({ isAuthenticated: false }) }),
  }),
}));

const BASE = "https://connecta.test";
const NAMESPACE = "https://identity.test";
const CLERK_PK = `pk_test_${btoa("clerk.example.com$")}`;

type Deployment = { fetch(request: Request, env?: unknown, ctx?: unknown): Promise<Response>; close(): Promise<void> };

/** A person provider: `Bearer alice|bob`, or an ambient `session=<user>` cookie. */
function people(): InboundAuth & { authorize: ReturnType<typeof vi.fn> } {
  return {
    kind: "test-users",
    interactiveOperator: true,
    uiAuth: { kind: "clerk", frontendApiUrl: NAMESPACE, publishableKey: "pk_test_fake" },
    activityActorNamespace: NAMESPACE,
    authorize: vi.fn((request: Request) => {
      const header = /^Bearer (alice|bob)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
      const cookie = /(?:^|; )session=(alice|bob)(?:;|$)/u.exec(request.headers.get("cookie") ?? "")?.[1];
      const user = header ?? cookie;
      return user
        ? { ok: true as const, userId: user, subjectId: user }
        : { ok: false as const, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
    }),
  };
}

const READ = { annotations: { readOnlyHint: true }, handler: async () => ({ ok: true }) };

function connectors(onDelete: () => void = () => {}): Connector[] {
  return [
    api("notes", {
      description: "Notes",
      tools: [
        { name: "search", description: "Search team data", ...READ },
        {
          name: "delete",
          description: "Delete team data",
          annotations: { readOnlyHint: false, destructiveHint: true },
          handler: async () => {
            onDelete();
            return { deleted: true };
          },
        },
      ],
    }),
    api("wiki", { description: "Wiki", tools: [{ name: "read", description: "Read team data", ...READ }] }),
    api("docs", {
      description: "Docs",
      tools: [{ name: "read", description: "Read long team data", ...READ, handler: () => "x".repeat(500) }],
    }),
  ];
}

/** Memory storage that counts reads of agent token state. */
function countingStorage(): KVStorage & { tokenReads: () => number } {
  const storage = memoryStorage();
  const get = storage.get.bind(storage);
  let reads = 0;
  return Object.assign(storage, {
    get: (key: string) => {
      if (key.startsWith("access-token:")) reads++;
      return get(key);
    },
    tokenReads: () => reads,
  });
}

function deployment(options: Partial<Parameters<typeof createTestConnecta>[0]> = {}) {
  const storage = (options.storage as KVStorage | undefined) ?? memoryStorage();
  return createTestConnecta({
    connectors: connectors(),
    auth: people(),
    maintainers: ["alice"],
    agents: ["bot", "other"],
    pools: {
      team: { tools: ["wiki"], members: ["bob", "agent:bot"] },
      x: { tools: ["wiki"], members: ["agent:bot"] },
      "assistant-alice": { tools: ["wiki"], members: ["agent:bot"] },
      humans: { tools: ["wiki"], members: ["bob"] },
    },
    publicUrl: BASE,
    logger: silentLogger,
    ...options,
    storage,
    accessTokens: accessTokens(storage),
  });
}

function post(path: string, token: string | undefined, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const listTools = (c: Deployment, path: string, token?: string, headers?: Record<string, string>, ctx?: unknown) =>
  c.fetch(post(path, token, LIST, headers), undefined, ctx);

const rpc = async (c: Deployment, path: string, token: string, name: string, args: unknown) =>
  (await readJsonRpc(
    await c.fetch(
      post(path, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    ),
  )) as any;

const searchText = async (c: Deployment, path: string, token: string) =>
  JSON.stringify(await rpc(c, path, token, "search_tools", { query: "team data", limit: 50 }));

async function wire(response: Response) {
  return { status: response.status, headers: [...response.headers].sort(), body: await response.text() };
}

// P0 normalization table (documentation/architecture.md). "bypassed" rows
// reached the Worker behind the `/agent/*` Bypass application; "protected"
// rows got Access's refusal and never reached it.
const BYPASSED_REFUSED = [
  "/agent/",
  "/agent/x/",
  "/AGENT/x",
  "/%61gent/x",
  "//agent/x",
  "/agent/%2f/mcp",
  "/agent/x%2f..%2f..%2fmcp",
];
const BYPASSED_ADMITTED = ["/agent/x", "/agent/assistant-alice", "/agent/x?y", "/mcp/../agent/x"];
const PROTECTED = [
  "/mcp",
  "/agent",
  "/agentx",
  "/mcp/agent/x",
  "/agent/../mcp",
  "/agent/x/../../mcp",
  "/agent/%2e%2e/mcp",
  "/agent/%2E%2E/mcp",
  "/agent%2f..%2fmcp",
];

describe("agent endpoint paths", () => {
  it("INV-4: matches only the exact raw /agent/<pool> spelling and claims the whole agent namespace", () => {
    expect(agentEndpointPool("/agent/assistant-alice")).toBe("assistant-alice");
    for (const path of [
      "/agent/",
      "/agent",
      "/agent/x/",
      "/agent/x/y",
      "/AGENT/x",
      "/agent/X",
      "/%61gent/x",
      "//agent/x",
      "/agent/%78",
      "/agent/x%2f..",
      "/agentx",
    ]) {
      expect(agentEndpointPool(path), path).toBeUndefined();
    }
    for (const path of [
      "/agent",
      "/agentx",
      "/Agent/x",
      "//agent/x",
      "/%2fagent/x",
      "/%2561gent/x",
      "/%61%67%65%6e%74/x",
      "/\\agent/x",
    ]) {
      expect(isAgentPath(path), path).toBe(true);
    }
    for (const path of ["/mcp", "/mcp/agent", "/", "/ui/api/config", "/.well-known/oauth-protected-resource/agent/x"]) {
      expect(isAgentPath(path), path).toBe(false);
    }
  });

  it("INV-4: answers every refused row of the P0 normalization table with the pool 404 before auth", async () => {
    const storage = countingStorage();
    const human = people();
    const c = deployment({ storage, auth: human });
    const bot = await issueAgentToken(storage, "bot");
    const reference = await wire(await listTools(c, "/agent/missing", bot));
    expect(reference.status).toBe(404);
    const before = storage.tokenReads();
    for (const path of BYPASSED_REFUSED) {
      for (const token of [bot, undefined, "alice"]) {
        expect(await wire(await listTools(c, path, token)), `${path} ${token}`).toEqual(reference);
      }
      // Every method, preflight included, is the same refusal.
      for (const method of ["GET", "DELETE", "OPTIONS"]) {
        const response = await c.fetch(new Request(`${BASE}${path}`, { method }));
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    }
    expect(storage.tokenReads()).toBe(before);
    expect(human.authorize).not.toHaveBeenCalled();
    await c.close();
  });

  it("INV-4: admits a member agent at every bypassed row that arrives as exactly /agent/<pool>", async () => {
    const storage = memoryStorage();
    const c = deployment({ storage });
    const bot = await issueAgentToken(storage, "bot");
    for (const path of BYPASSED_ADMITTED) {
      expect((await listTools(c, path, bot)).status, path).toBe(200);
    }
    await c.close();
  });

  it("INV-4: no protected row admits an agent token, so none reaches a pool as an agent", async () => {
    const storage = memoryStorage();
    const c = deployment({ storage });
    const bot = await issueAgentToken(storage, "bot");
    for (const path of PROTECTED) {
      const response = await listTools(c, path, bot);
      expect([401, 404], path).toContain(response.status);
      expect(await response.text(), path).not.toContain('"result"');
    }
    await c.close();
  });
});

describe("agent endpoint admission", () => {
  it("INV-4: serves a member agent exactly its pool's tools at /agent/<pool>", async () => {
    const storage = memoryStorage();
    const c = deployment({ storage });
    const bot = await issueAgentToken(storage, "bot");
    const text = await searchText(c, "/agent/team", bot);
    expect(text).toContain("wiki.read");
    expect(text).not.toContain("notes.search");
    expect(text).not.toContain("docs.read");
    await c.close();
  });

  it("INV-4: answers a non-member agent, an undeclared pool, and a human-only pool with one identical 404 after auth", async () => {
    const storage = memoryStorage();
    const warn = vi.fn();
    const c = deployment({ storage, logger: { ...silentLogger, warn } });
    const bot = await issueAgentToken(storage, "bot");
    const other = await issueAgentToken(storage, "other");
    const reference = await wire(await listTools(c, "/agent/missing", bot));
    expect(reference.status).toBe(404);
    expect(await wire(await listTools(c, "/agent/team", other))).toEqual(reference);
    expect(await wire(await listTools(c, "/agent/humans", bot))).toEqual(reference);
    // The pre-auth refusal of a malformed spelling is the same response.
    expect(await wire(await listTools(c, "/agent/team/", bot))).toEqual(reference);
    const reasons = warn.mock.calls.flat().flatMap((entry) => (entry?.reason ? [entry.reason] : []));
    expect(reasons).toEqual(expect.arrayContaining(["pool_not_declared", "not_pool_member"]));
    // Unauthenticated callers cannot tell a declared pool from an undeclared one.
    const declared = await wire(await listTools(c, "/agent/team"));
    expect(declared.status).toBe(401);
    expect(await wire(await listTools(c, "/agent/missing"))).toEqual(declared);
    await c.close();
  });

  it("INV-4: challenges a missing or unknown agent credential with machine-only Bearer and no metadata", async () => {
    const storage = memoryStorage();
    const clerk = clerkAuth({ publishableKey: CLERK_PK, secretKey: "sk_test_fake", publicUrl: BASE });
    const c = deployment({
      storage,
      auth: clerk,
      maintainers: [{ namespace: "https://clerk.example.com", id: "user_1" }],
      pools: { team: { tools: ["wiki"], members: ["agent:bot"] } },
    });
    for (const token of [undefined, "cta_unknown", "not-a-cta-token"]) {
      const response = await listTools(c, "/agent/team", token);
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect(response.headers.get("Connecta-Error-Code")).toBe("host_auth_required");
    }
    // Agent endpoints publish no protected-resource metadata, declared or not.
    const metadata = await wire(await c.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource/agent/team`)));
    expect(metadata.status).toBe(404);
    expect(
      await wire(await c.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource/agent/missing`))),
    ).toEqual(metadata);
    // Human pools keep Clerk's discovery.
    const human = await c.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp/team`));
    expect(await human.json()).toMatchObject({ resource: `${BASE}/mcp/team` });
    await c.close();
  });

  it("INV-4: refuses a person's token and an ambient cookie at /agent without asking the person provider", async () => {
    const storage = memoryStorage();
    const human = people();
    const c = deployment({ storage, auth: human });
    // Bob is admitted at his human pool, so these credentials are good ones.
    expect((await listTools(c, "/mcp/team", "bob")).status).toBe(200);
    expect((await listTools(c, "/mcp/team", undefined, { Cookie: "session=bob" })).status).toBe(200);
    human.authorize.mockClear();
    for (const [token, headers] of [
      ["bob", {}],
      [undefined, { Cookie: "session=bob" }],
    ] as const) {
      const response = await listTools(c, "/agent/team", token, headers);
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    }
    expect(human.authorize).not.toHaveBeenCalled();
    await c.close();
  });

  it("INV-4: never consults Clerk at /agent, for a Clerk token, a session cookie, or a handshake parameter", async () => {
    const storage = memoryStorage();
    const clerk = clerkAuth({ publishableKey: CLERK_PK, secretKey: "sk_test_fake", publicUrl: BASE });
    const authorize = vi.spyOn(clerk, "authorize");
    const recognize = vi.spyOn(clerk, "recognizesCredential" as never);
    const metadata = vi.spyOn(clerk, "handleMetadata" as never);
    const c = deployment({
      storage,
      auth: clerk,
      maintainers: [{ namespace: "https://clerk.example.com", id: "user_1" }],
      pools: { team: { tools: ["wiki"], members: ["agent:bot", { namespace: "https://clerk.example.com", id: "u" }] } },
    });
    const bot = await issueAgentToken(storage, "bot");
    for (const [path, token, headers] of [
      ["/agent/team", "eyJhbGciOiJSUzI1NiJ9.e30.sig", {}],
      ["/agent/team", "oat_clerk_oauth_token", {}],
      ["/agent/team", undefined, { Cookie: "__session=eyJhbGciOiJSUzI1NiJ9.e30.sig; __client_uat=1" }],
      ["/agent/team?__clerk_db_jwt=dvb_x", undefined, {}],
    ] as const) {
      const response = await listTools(c, path, token, headers);
      expect(response.status, path).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    }
    expect(authorize).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
    // A member agent's cookie or Clerk parameter changes nothing about its admission.
    expect((await listTools(c, "/agent/team?__clerk_db_jwt=dvb_x", bot, { Cookie: "__session=x" })).status).toBe(200);
    expect(authorize).not.toHaveBeenCalled();
    // The same Clerk token at a human pool is Clerk's to judge.
    expect((await listTools(c, "/mcp/team", "eyJhbGciOiJSUzI1NiJ9.e30.sig")).status).toBe(401);
    expect(authorize).toHaveBeenCalled();
    await c.close();
  });

  it("INV-4: ignores Access context and Access JWT headers at /agent and admits only the cta_ token", async () => {
    const storage = memoryStorage();
    const getIdentity = vi.fn(async () => ({ user_uuid: "human" }));
    const ctx = { waitUntil() {}, access: { aud: "agent-path-aud", getIdentity } };
    const c = deployment({
      storage,
      auth: cloudflareAccessAuth(),
      maintainers: [{ namespace: "cloudflare-access", id: "human" }],
      pools: { team: { tools: ["wiki"], members: ["agent:bot", { namespace: "cloudflare-access", id: "human" }] } },
    });
    const bot = await issueAgentToken(storage, "bot");
    // The same context admits the person at the human pool.
    expect((await listTools(c, "/mcp/team", undefined, {}, ctx)).status).toBe(200);
    getIdentity.mockClear();
    for (const headers of [
      {},
      { "Cf-Access-Jwt-Assertion": "eyJhbGciOiJSUzI1NiJ9.e30.sig" },
      { Cookie: "CF_Authorization=eyJhbGciOiJSUzI1NiJ9.e30.sig" },
      { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "secret" },
    ]) {
      const response = await listTools(c, "/agent/team", undefined, headers, ctx);
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    }
    expect(await searchTextWithContext(c, "/agent/team", bot, ctx)).toContain("wiki.read");
    expect(getIdentity).not.toHaveBeenCalled();
    await c.close();
  });

  it("INV-4: attaches the admitted pool to the connector caller at /agent/<pool> as at /mcp/<pool>", async () => {
    const storage = memoryStorage();
    const c = deployment({
      storage,
      connectors: [
        api("who", {
          tools: [
            {
              name: "am_i",
              description: "Report the caller",
              annotations: { readOnlyHint: true },
              handler: (_args, ctx) => {
                const caller = callerOf(ctx);
                return { pool: caller?.pool ?? null, agent: caller?.identity.agent ?? null };
              },
            },
          ],
        }),
      ],
      pools: { team: { tools: ["who"], members: ["bob", "agent:bot"] } },
    });
    const bot = await issueAgentToken(storage, "bot");
    const ask = async (path: string, token: string) =>
      JSON.parse(
        (await rpc(c, path, token, "call_tool", { address: "who.am_i", args: {} })).result.content[0].text.split(
          "\n",
        )[0],
      );
    expect(await ask("/agent/team", bot)).toEqual({ pool: "team", agent: "bot" });
    expect(await ask("/mcp/team", "bob")).toEqual({ pool: "team", agent: null });
    await c.close();
  });

  it("INV-2: an agent endpoint carries its pool's readOnly", async () => {
    const storage = memoryStorage();
    const deleted = { count: 0 };
    const c = deployment({
      storage,
      connectors: connectors(() => deleted.count++),
      pools: {
        readers: { tools: ["notes"], readOnly: true, members: ["agent:bot"] },
        writers: { tools: ["notes"], readOnly: false, members: ["agent:bot"] },
      },
    });
    const bot = await issueAgentToken(storage, "bot");
    const refused = await rpc(c, "/agent/readers", bot, "call_destructive_tool", { address: "notes.delete", args: {} });
    expect(JSON.stringify(refused)).toContain("read_only_endpoint");
    expect(await searchText(c, "/agent/readers", bot)).not.toContain("notes.delete");
    expect(deleted.count).toBe(0);
    const written = await rpc(c, "/agent/writers", bot, "call_destructive_tool", { address: "notes.delete", args: {} });
    expect(written.result.isError).toBeFalsy();
    expect(deleted.count).toBe(1);
    await c.close();
  });

  it("INV-4: binds result handles to /agent/<pool>, never portable to another pool or to /mcp/<pool>", async () => {
    let resultId = "";
    const storage = memoryStorage();
    const c = deployment({
      storage,
      calls: { maxResultBytes: 100 },
      executor: scriptedExecutor(async (fns) => fns.result!(resultId, { maxBytes: 100 })),
      pools: {
        team: { tools: ["docs"], members: ["bob", "agent:bot"] },
        second: { tools: ["docs"], members: ["agent:bot"] },
      },
    });
    const bot = await issueAgentToken(storage, "bot");
    const page = async (path: string, token: string) =>
      (await rpc(c, path, token, "execute_code", { code: "return await connecta.result(id)" })).result;
    const mint = async (path: string, token: string) => {
      const first = (await rpc(c, path, token, "call_tool", { address: "docs.read" })).result;
      resultId = JSON.parse(first.content[0].text.split("\n")[0]).resultId;
      expect(resultId).toBeTypeOf("string");
    };
    await mint("/agent/team", bot);
    expect((await page("/agent/team", bot)).isError).toBeFalsy();
    expect((await page("/agent/second", bot)).isError).toBe(true);
    expect((await page("/mcp/team", "bob")).isError).toBe(true);
    await mint("/mcp/team", "bob");
    expect((await page("/mcp/team", "bob")).isError).toBeFalsy();
    expect((await page("/agent/team", bot)).isError).toBe(true);
    await c.close();
  });
});

describe("human endpoints refuse agent tokens", () => {
  it("INV-4: refuses cta_ at /mcp, /mcp/<pool>, and operator routes without reading token storage", async () => {
    const storage = countingStorage();
    const human = people();
    const c = deployment({ storage, auth: human });
    const bot = await issueAgentToken(storage, "bot");
    const before = storage.tokenReads();
    for (const path of ["/mcp", "/mcp/team", "/mcp/x", "/mcp/missing"]) {
      const response = await listTools(c, path, bot);
      expect(response.status, path).toBe(401);
      expect(await response.text()).not.toContain('"result"');
    }
    expect(
      (await c.fetch(new Request(`${BASE}/ui/api/config`, { headers: { Authorization: `Bearer ${bot}` } }))).status,
    ).toBe(401);
    expect(
      (
        await c.fetch(
          new Request(`${BASE}/connect/wiki`, { method: "POST", headers: { Authorization: `Bearer ${bot}` } }),
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(storage.tokenReads()).toBe(before);
    expect(human.authorize).not.toHaveBeenCalled();
    // The same token is admitted where agents belong.
    expect((await listTools(c, "/agent/team", bot)).status).toBe(200);
    await c.close();
  });

  it("INV-4: a refused cta_ cannot fall back to an ambient cookie or Access identity", async () => {
    const storage = memoryStorage();
    const human = people();
    const c = deployment({ storage, auth: human });
    const bot = await issueAgentToken(storage, "bot");
    const response = await listTools(c, "/mcp/team", bot, { Cookie: "session=bob" });
    expect(response.status).toBe(401);
    expect(human.authorize).not.toHaveBeenCalled();
    await c.close();

    const accessStorage = memoryStorage();
    const getIdentity = vi.fn(async () => ({ user_uuid: "human" }));
    const access = deployment({
      storage: accessStorage,
      auth: cloudflareAccessAuth(),
      maintainers: [{ namespace: "cloudflare-access", id: "human" }],
      pools: { team: { tools: ["wiki"], members: ["agent:bot", { namespace: "cloudflare-access", id: "human" }] } },
    });
    const accessBot = await issueAgentToken(accessStorage, "bot");
    for (const path of ["/mcp", "/mcp/team"]) {
      const refused = await listTools(
        access,
        path,
        accessBot,
        {},
        {
          waitUntil() {},
          access: { aud: "worker-aud", getIdentity },
        },
      );
      expect(refused.status, path).toBe(401);
    }
    expect(getIdentity).not.toHaveBeenCalled();
    await access.close();
  });

  it("INV-4: an agents-only deployment admits agents only at /agent/<pool>", async () => {
    const storage = memoryStorage();
    const c = createTestConnecta({
      connectors: connectors(),
      storage,
      agents: ["bot"],
      accessTokens: accessTokens(storage),
      pools: { bots: { tools: ["wiki"], members: ["agent:bot"] } },
      logger: silentLogger,
    });
    const bot = await issueAgentToken(storage, "bot");
    expect((await listTools(c, "/mcp", bot)).status).toBe(401);
    expect((await listTools(c, "/mcp/bots", bot)).status).toBe(401);
    expect((await listTools(c, "/mcp")).status).toBe(401);
    expect((await listTools(c, "/agent/bots", bot)).status).toBe(200);
    await c.close();
  });
});

async function searchTextWithContext(c: Deployment, path: string, token: string, ctx: unknown): Promise<string> {
  const response = await c.fetch(
    post(path, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_tools", arguments: { query: "team data", limit: 50 } },
    }),
    undefined,
    ctx,
  );
  return JSON.stringify(await readJsonRpc(response));
}
