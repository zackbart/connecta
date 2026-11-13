import { describe, expect, it, vi } from "vitest";
import { accessTokens } from "../src/access-tokens.js";
import { activityHistory, type ToolCallActivityEvent } from "../src/activity.js";
import { clerkAuth } from "../src/auth/clerk.js";
import { cloudflareAccessAuth } from "../src/auth/cloudflare-access.js";
import { api } from "../src/connectors/api.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, InboundAuth, KVStorage } from "../src/types.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { scriptedExecutor } from "./fixtures/misc.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { issueAgentToken } from "./helpers/agent-tokens.js";

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
      "team-people": { tools: ["wiki"], members: ["bob"] },
      team: { tools: ["wiki"], members: ["agent:bot"] },
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

describe("agent endpoint paths", () => {
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

  it("INV-4: hides a connector whose members omit the agent exactly as an unknown one, and serves a listed agent (#1377)", async () => {
    const storage = memoryStorage();
    const [notes, wiki, docs] = connectors();
    const c = deployment({
      storage,
      // Listed in the same agent pool: people-only members hide "wiki"; an
      // explicit agent reference keeps "docs" for that agent alone.
      connectors: [notes!, { ...wiki!, members: ["bob"] }, { ...docs!, members: ["bob", "agent:bot"] }],
      pools: {
        team: { tools: ["wiki", "docs", "notes.search"], members: ["agent:bot", "agent:other"] },
        humans: { tools: ["wiki"], members: ["bob"] },
      },
    });
    const bot = await issueAgentToken(storage, "bot");
    const other = await issueAgentToken(storage, "other");
    const timeless = (value: unknown) =>
      JSON.stringify(value).replace(/(\\?"durationMs\\?":)\d+/g, (_, key: string) => `${key}0`);
    const botText = await searchText(c, "/agent/team", bot);
    expect(botText).toContain("docs.read");
    expect(botText).toContain("notes.search");
    expect(botText).not.toContain("wiki");
    expect(await searchText(c, "/agent/team", other)).not.toMatch(/wiki|docs/);
    for (const [token, hidden] of [
      [bot, "wiki"],
      [other, "docs"],
    ] as const) {
      const call = (connector: string) =>
        rpc(c, "/agent/team", token, "call_tool", { address: `${connector}.read`, args: {} });
      expect(timeless(await call(hidden)).replaceAll(hidden, "ghost")).toBe(timeless(await call("ghost")));
    }
    expect(
      (await rpc(c, "/agent/team", bot, "call_tool", { address: "docs.read", args: {} })).result.isError,
    ).toBeFalsy();
    // The listed person still reaches "wiki" through their own pool.
    const person = await readJsonRpc(
      await c.fetch(
        post("/mcp/humans", "bob", {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "call_tool", arguments: { address: "wiki.read", args: {} } },
        }),
      ),
    );
    expect((person as any).result.isError).toBeFalsy();
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
    const human = await c.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp/team-people`));
    expect(await human.json()).toMatchObject({ resource: `${BASE}/mcp/team-people` });
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
      pools: {
        "team-people": { tools: ["wiki"], members: [{ namespace: "https://clerk.example.com", id: "u" }] },
        team: { tools: ["wiki"], members: ["agent:bot"] },
      },
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
    expect((await listTools(c, "/mcp/team-people", "eyJhbGciOiJSUzI1NiJ9.e30.sig")).status).toBe(401);
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
      pools: {
        "team-people": { tools: ["wiki"], members: [{ namespace: "cloudflare-access", id: "human" }] },
        team: { tools: ["wiki"], members: ["agent:bot"] },
      },
    });
    const bot = await issueAgentToken(storage, "bot");
    // The same context admits the person at the human pool.
    expect((await listTools(c, "/mcp/team-people", undefined, {}, ctx)).status).toBe(200);
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

  it("INV-2: an agent endpoint carries its pool's readOnly", async () => {
    const storage = memoryStorage();
    const deleted = { count: 0 };
    const c = deployment({
      storage,
      connectors: connectors(() => deleted.count++),
      pools: {
        readers: { tools: ["notes"], readOnly: true, members: ["agent:bot"] },
        writers: { tools: ["notes"], readOnly: false, members: ["agent:bot"] },
        granted: { tools: ["notes", "wiki"], readOnly: true, writes: ["notes.delete"], members: ["agent:bot"] },
        exact: { tools: ["notes.delete"], readOnly: true, members: ["agent:bot"] },
      },
    });
    const bot = await issueAgentToken(storage, "bot");
    const refused = await rpc(c, "/agent/readers", bot, "call_destructive_tool", { address: "notes.delete", args: {} });
    expect(JSON.stringify(refused)).toContain("read_only_endpoint");
    expect(JSON.stringify(refused)).toContain("No write route exists on this endpoint");
    expect(await searchText(c, "/agent/readers", bot)).not.toContain("notes.delete");
    expect(deleted.count).toBe(0);
    const written = await rpc(c, "/agent/writers", bot, "call_destructive_tool", { address: "notes.delete", args: {} });
    expect(written.result.isError).toBeFalsy();
    expect(deleted.count).toBe(1);
    expect(await searchText(c, "/agent/granted", bot)).toContain("notes.delete");
    const granted = await rpc(c, "/agent/granted", bot, "call_destructive_tool", { address: "notes.delete", args: {} });
    expect(granted.result.isError).toBeFalsy();
    expect(deleted.count).toBe(2);
    const exact = await rpc(c, "/agent/exact", bot, "call_destructive_tool", { address: "notes.delete", args: {} });
    expect(JSON.stringify(exact)).toContain("read_only_endpoint");
    expect(deleted.count).toBe(2);
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
        "team-people": { tools: ["docs"], members: ["bob"] },
        team: { tools: ["docs"], members: ["agent:bot"] },
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
    expect((await page("/mcp/team-people", "bob")).isError).toBe(true);
    await mint("/mcp/team-people", "bob");
    expect((await page("/mcp/team-people", "bob")).isError).toBeFalsy();
    expect((await page("/agent/team", bot)).isError).toBe(true);
    await c.close();
  });
});

describe("execute_read_code across endpoints", () => {
  it("is listed at /mcp/<pool> and a writable /agent/<pool>, never a read-only or native agent pool", async () => {
    const storage = memoryStorage();
    const pools = {
      "team-people": { tools: ["docs"], members: ["bob"] },
      team: { tools: ["docs"], members: ["agent:bot"] },
      readers: { tools: ["docs"], readOnly: true, members: ["agent:bot"] },
      lean: { tools: ["docs"], surface: "native" as const, members: ["agent:bot"] },
    };
    const c = deployment({ storage, pools });
    const off = deployment({ storage, pools, execute: { readRoute: false } });
    const bot = await issueAgentToken(storage, "bot");
    const send = async (app: Deployment, path: string, token: string, method: string, params: unknown) =>
      (await readJsonRpc(await app.fetch(new Request(`${BASE}${path}`, mcpRpc(method, params, { token }))))).result;
    const tools = async (path: string, token: string, app: Deployment = c) =>
      (await send(app, path, token, "tools/list", {})).tools as { name: string; annotations?: object }[];
    const facts = async (path: string, token: string, app: Deployment = c) =>
      (
        await send(app, path, token, "initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "facts", version: "1" },
        })
      ).capabilities.extensions["dev.connecta/endpoint"];
    const names = async (path: string, token: string, app: Deployment = c) =>
      (await tools(path, token, app)).map((tool) => tool.name);

    expect(await names("/mcp/team-people", "bob")).toContain("execute_read_code");
    const agent = await tools("/agent/team", bot);
    expect(agent).toHaveLength(7);
    expect(agent.find((tool) => tool.name === "execute_read_code")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(agent.find((tool) => tool.name === "execute_code")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(await facts("/agent/team", bot)).toMatchObject({ surface: "meta", executeReadCode: true, readOnly: false });

    const readers = await names("/agent/readers", bot);
    expect(readers).toHaveLength(6);
    expect(readers).not.toContain("execute_read_code");
    expect(await facts("/agent/readers", bot)).toMatchObject({ executeReadCode: false, readOnly: true });
    expect(await names("/agent/lean", bot)).not.toContain("execute_read_code");
    expect(await facts("/agent/lean", bot)).toMatchObject({ surface: "native", executeReadCode: false });

    const disabled = await names("/agent/team", bot, off);
    expect(disabled).toHaveLength(6);
    expect(disabled).not.toContain("execute_read_code");
    expect(await facts("/agent/team", bot, off)).toMatchObject({ executeReadCode: false });
    await c.close();
    await off.close();
  });

  it("INV-2 INV-3: refuses every write a read program on an agent pool attempts, its address built at runtime, sending none", async () => {
    let deletes = 0;
    const storage = memoryStorage();
    const events: ToolCallActivityEvent[] = [];
    const c = deployment({
      storage,
      connectors: connectors(() => deletes++),
      activity: activityHistory({ store: { record: (event) => void events.push(event) } }),
      executor: scriptedExecutor(async (fns) => {
        const read = await fns.call!("notes.search", {});
        const address = ["notes", ["de", "lete"].join("")].join(".");
        const attempts = await Promise.allSettled([fns.call!(address, {}), fns.call!("notes.delete", {})]);
        return {
          read,
          refusals: attempts.map((attempt) =>
            attempt.status === "rejected" ? (attempt.reason as { code?: string }).code : "sent",
          ),
        };
      }),
      pools: { team: { tools: ["notes"], members: ["agent:bot"] } },
    });
    const bot = await issueAgentToken(storage, "bot");
    const program = (await rpc(c, "/agent/team", bot, "execute_read_code", { code: "async () => program" })).result;
    expect(program.isError).toBeFalsy();
    expect(program.structuredContent.result.refusals).toEqual([
      "destructive_tool_requires_approval",
      "destructive_tool_requires_approval",
    ]);
    expect(deletes).toBe(0);
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    expect(new Set(events.map((event) => event.source))).toEqual(new Set(["execute_read_code"]));

    expect(
      (await rpc(c, "/agent/team", bot, "execute_code", { code: "async () => program" })).result.isError,
    ).toBeFalsy();
    expect(deletes).toBe(2);
    await c.close();
  });

  it("INV-3 INV-4: pages a direct read's handle and a read program's handle, under the existing bindings", async () => {
    let resultId = "";
    let oversized = false;
    const storage = memoryStorage();
    const c = deployment({
      storage,
      calls: { maxResultBytes: 100 },
      executor: scriptedExecutor(async (fns) =>
        oversized ? "x".repeat(30_000) : fns.result!(resultId, { maxBytes: 100 }),
      ),
      pools: {
        "team-people": { tools: ["docs"], members: ["bob"] },
        second: { tools: ["docs"], members: ["bob"] },
      },
    });
    const page = async (path: string) =>
      (await rpc(c, path, "bob", "execute_read_code", { code: "return await connecta.result(id)" })).result;
    const first = (await rpc(c, "/mcp/team-people", "bob", "call_tool", { address: "docs.read" })).result;
    resultId = JSON.parse(first.content[0].text.split("\n")[0]).resultId;
    expect((await page("/mcp/team-people")).isError).toBeFalsy();
    expect((await page("/mcp/second")).isError).toBe(true);

    oversized = true;
    const program = (await rpc(c, "/mcp/team-people", "bob", "execute_read_code", { code: "return big" })).result;
    expect(program.structuredContent.result.nextAction.tool).toBe("execute_read_code");
    resultId = program.structuredContent.result.resultId;
    oversized = false;
    expect((await page("/mcp/team-people")).isError).toBeFalsy();
    expect((await page("/mcp/second")).isError).toBe(true);
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
    for (const path of ["/mcp", "/mcp/team-people", "/mcp/x", "/mcp/missing"]) {
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
