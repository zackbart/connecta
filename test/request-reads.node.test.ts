// Node-only: node:sqlite stands in for D1 so every round trip and statement is counted, and QuickJS runs programs.
//
// The request read memo (src/runtime/request-reads.ts), then request budgets:
// downstream requests, D1 round trips and SQL statements for the request
// shapes that repeat most, on a production-shaped deployment. A round trip is
// one `all`, `run` or `batch` call; a statement is one SQL statement, so a
// batch of two is one round trip and two statements. Workers Free allows 50 D1
// queries per invocation. The numbers are ceilings: lower is fine, higher is a
// regression to explain. `D1_BUDGET_REPORT=1` prints each measurement.
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WebStandardStreamableHTTPServerTransport, McpServer } from "@modelcontextprotocol/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { api } from "../src/connectors/api.js";
import { CredentialVault, encryptedCredentialVault } from "../src/credentials.js";
import { d1ActivityStore, d1Storage, type D1DatabaseBinding } from "../src/d1.js";
import { accessTokens } from "../src/access-tokens.js";
import { activityHistory } from "../src/activity.js";
import { cloudflareAccessAuth } from "../src/auth/cloudflare-access.js";
import { quickJsExecutor } from "../src/executors/quickjs.js";
import { createConnecta, type Connecta } from "../src/index.js";
import { operatorUi } from "../src/ui.js";
import { Effect } from "effect";
import { RequestReads, observeStorageWrites } from "../src/runtime/request-reads.js";
import { requestOwner, requestReads } from "../src/runtime/request-scope.js";
import { runEdge } from "../src/runtime/run.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { KVStorage } from "../src/types.js";
import { oauthGrantKeys, scopes } from "../src/storage/keys.js";
import { CLERK_OPTIONS, CREDENTIAL_KEY } from "./fixtures/ui.js";
import { fakeClerkAuth } from "./fixtures/http.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { createTestConnecta } from "./helpers.js";
import { machineAuth } from "./helpers/machine-auth.js";

const BASE = "https://connecta.test";
const TOKEN = "budget-machine-token";

interface Count {
  roundTrips: number;
  statements: number;
  log: string[];
}

/** A structural D1 binding over one in-memory SQLite database, counting. */
function countingD1(db: DatabaseSync, count: Count): D1DatabaseBinding {
  type Bound = ReturnType<D1DatabaseBinding["prepare"]> & { sql: string; params: unknown[] };
  const statement = (sql: string, params: unknown[] = []): Bound => ({
    sql,
    params,
    bind: (...values: unknown[]) => statement(sql, values),
    all: async () => {
      count.roundTrips++;
      count.statements++;
      count.log.push(`all ${JSON.stringify(params)}`);
      return { results: db.prepare(sql).all(...(params as never[])) };
    },
    run: async () => {
      count.roundTrips++;
      count.statements++;
      count.log.push(`run ${JSON.stringify(params)}`);
      return { meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (list) => {
      count.roundTrips++;
      count.statements += list.length;
      const bound = list as Bound[];
      count.log.push(`batch(${list.length}) ${bound.map((s) => JSON.stringify(s.params)).join(" | ")}`);
      db.exec("BEGIN");
      try {
        const out = bound.map((s) => ({
          meta: { changes: Number(db.prepare(s.sql).run(...(s.params as never[])).changes) },
        }));
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** `D1_BUDGET_REPORT=1` prints each measurement, to set or explain a ceiling. */
function report(label: string, count: Count, extra: Record<string, number> = {}) {
  if (process.env.D1_BUDGET_REPORT)
    console.log(JSON.stringify({ label, roundTrips: count.roundTrips, statements: count.statements, ...extra }));
}

function counted() {
  const db = new DatabaseSync(":memory:");
  const count: Count = { roundTrips: 0, statements: 0, log: [] };
  return {
    count,
    storage: () => d1Storage(countingD1(db, count)),
    binding: () => countingD1(db, count),
    reset: () => {
      count.roundTrips = 0;
      count.statements = 0;
      count.log.length = 0;
    },
  };
}

/** A stateful downstream with one read tool, behind optional OAuth. */
function downstream(origin: string, options: { oauth?: boolean; beforePageTwo?: () => Promise<void> } = {}) {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const state = { token: "access-1", issued: 1, rejected: 0, expiresIn: 3600, pageTwo: [] as (string | null)[] };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== origin) return new Response("unknown host", { status: 404 });
    if (options.oauth) {
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
        return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      if (url.pathname === "/token") {
        state.token = `access-${++state.issued}`;
        return Response.json({
          access_token: state.token,
          token_type: "Bearer",
          expires_in: state.expiresIn,
          refresh_token: `refresh-${state.issued}`,
        });
      }
      if (request.headers.get("authorization") !== `Bearer ${state.token}`) {
        state.rejected++;
        return new Response("{}", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      }
    }
    const sid = request.headers.get("mcp-session-id");
    if (options.beforePageTwo && sid && request.method === "POST") {
      // A paginated catalog: page one names a cursor, page two the tool.
      const message = (await request.clone().json()) as { id?: unknown; method?: string; params?: { cursor?: string } };
      if (message.method === "tools/list") {
        const tool = (name: string) => ({
          name,
          description: `The ${name} tool`,
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
          annotations: { readOnlyHint: true },
        });
        if (message.params?.cursor !== "page-2") {
          await options.beforePageTwo();
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: { tools: [tool("first")], nextCursor: "page-2" },
          });
        }
        state.pageTwo.push(request.headers.get("authorization"));
        return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [tool("echo")] } });
      }
    }
    if (sid && sessions.has(sid)) return sessions.get(sid)!.handleRequest(request);
    const body = (
      request.method === "POST"
        ? await request
            .clone()
            .json()
            .catch(() => null)
        : null
    ) as { method?: string; id?: unknown } | null;
    if (body?.method !== "initialize")
      return Response.json(
        { jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32000, message: "not initialized" } },
        { status: 400 },
      );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id: string) => void sessions.set(id, transport),
    });
    const server = new McpServer({ name: "budget", version: "1.0.0" });
    server.registerTool(
      "echo",
      {
        description: "Echo text back",
        inputSchema: z.object({ text: z.string() }),
        annotations: { readOnlyHint: true },
      },
      async ({ text }) => ({ content: [{ type: "text", text }] }),
    );
    await server.connect(transport);
    return transport.handleRequest(request);
  };
  return { fetch, state };
}

let rpcId = 0;
async function callToolText(app: { fetch(request: Request): Promise<Response> }, address: string) {
  const response = await app.fetch(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name: "call_tool", arguments: { address, args: { text: "hi" } } },
      }),
    }),
  );
  const text = await response.text();
  // Let detached session cleanup settle before the next count.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return text;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A view storing `key` at `prefix + key`, as the registry's namespaces do. */
function view(storage: KVStorage, prefix: string): KVStorage {
  return observeStorageWrites(
    {
      capabilities: storage.capabilities,
      get: (key) => storage.get(prefix + key),
      set: (key, value, options) => storage.set(prefix + key, value, options),
      delete: (key) => storage.delete(prefix + key),
      list: async (keyPrefix) => (await storage.list(prefix + keyPrefix)).map((key) => key.slice(prefix.length)),
      compareAndSet: (key, expected, next, options) => storage.compareAndSet(prefix + key, expected, next, options),
    },
    { storage, prefix },
  );
}

describe("request read memo", () => {
  const counting = (storage: KVStorage) => {
    const loads: string[] = [];
    const read = (reads: RequestReads, from: KVStorage, key: string, fresh = false) =>
      runEdge(
        reads.read(
          from,
          key,
          Effect.promise(() => {
            loads.push(key);
            return from.get(key);
          }),
          fresh,
        ),
      );
    return { loads, read, storage };
  };

  it("INV-7: answers repeated reads in one request and nothing after it closes", async () => {
    const { loads, read, storage } = counting(memoryStorage());
    await storage.set("k", "v1");
    const identity = {};
    const reads = requestReads(identity);
    expect(await read(reads, storage, "k")).toBe("v1");
    expect(await read(reads, storage, "k")).toBe("v1");
    expect(loads).toEqual(["k"]);
    requestOwner(identity).close();
    expect(requestReads(identity)).toBe(reads);
    expect(await read(reads, storage, "k")).toBe("v1");
    expect(loads).toEqual(["k", "k"]);
    // Another request never sees this one's entries.
    expect(await read(new RequestReads(), storage, "k")).toBe("v1");
    expect(loads).toHaveLength(3);
  });

  it("drops exactly the key any request in the isolate writes, through any view", async () => {
    const { loads, read, storage } = counting(memoryStorage());
    const a = view(storage, "conn:a:");
    await a.set("k", "v1");
    await a.set("other", "o1");
    const reads = new RequestReads();
    await read(reads, a, "k");
    await read(reads, a, "other");
    // A second view of the same partition shares the entry...
    expect(await read(reads, view(storage, "conn:a:"), "k")).toBe("v1");
    expect(loads).toEqual(["k", "other"]);
    // ...and a write through the root, by anyone, is never hidden.
    await storage.set("conn:a:k", "v2");
    expect(await read(reads, a, "k")).toBe("v2");
    expect(await read(reads, a, "other")).toBe("o1");
    expect(loads).toEqual(["k", "other", "k"]);
    for (const write of [
      () => a.delete("k"),
      () => a.compareAndSet("k", null, "v3"),
      () => a.compareAndSet("k", "stale", "never"),
    ]) {
      await write();
      await read(reads, a, "k");
    }
    expect(loads).toEqual(["k", "other", "k", "k", "k", "k"]);
  });

  it("never records a read that a write overlapped", async () => {
    const storage = memoryStorage();
    await storage.set("k", "old");
    const reads = new RequestReads();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const pending = runEdge(
      reads.read(
        storage,
        "k",
        Effect.promise(async () => {
          const value = await storage.get("k");
          await gate;
          return value;
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await storage.set("k", "new");
    release();
    expect(await pending).toBe("old");
    let loaded = 0;
    const value = await runEdge(
      reads.read(
        storage,
        "k",
        Effect.promise(() => {
          loaded++;
          return storage.get("k");
        }),
      ),
    );
    expect([value, loaded]).toEqual(["new", 1]);
  });

  it("records fresh reads without answering them, and keeps partitions apart", async () => {
    const { loads, read, storage } = counting(memoryStorage());
    const alice = view(storage, "principal:alice:");
    const bob = view(storage, "principal:bob:");
    await alice.set("k", "alice");
    await bob.set("k", "bob");
    const reads = new RequestReads();
    expect(await read(reads, alice, "k", true)).toBe("alice");
    expect(await read(reads, alice, "k", true)).toBe("alice");
    expect(await read(reads, alice, "k")).toBe("alice");
    expect(await read(reads, bob, "k")).toBe("bob");
    expect(loads).toEqual(["k", "k", "k"]);
  });

  it.each(["effect", "promise"] as const)(
    "never lets an older read overwrite a newer fresh read (%s path)",
    async (path) => {
      // Review of #1184: another isolate's write lands between two reads of
      // this request; the earlier read settles last and must not record.
      const storage = memoryStorage();
      const reads = new RequestReads();
      const read = (value: () => Promise<string>, fresh: boolean) =>
        path === "effect"
          ? runEdge(reads.read(storage, "k", Effect.promise(value), fresh))
          : reads.readPromise(storage, "k", value, fresh);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const older = read(async () => {
        await gate;
        return "old";
      }, false);
      const fresh = await read(async () => "new", true);
      release();
      await older;
      let loaded = 0;
      const next = await read(async () => {
        loaded++;
        return "unexpected";
      }, false);
      expect({ fresh, next, loaded }).toEqual({ fresh: "new", next: "new", loaded: 0 });
    },
  );

  it("memoizes nothing in a runtime without weak references", async () => {
    // workerd before 2025-05-05 without enable_weak_ref has neither global.
    for (const missing of ["WeakRef", "FinalizationRegistry"]) {
      vi.stubGlobal(missing, undefined);
      try {
        const { loads, read, storage } = counting(memoryStorage());
        const reads = new RequestReads();
        expect(await read(reads, storage, "k")).toBeNull();
        expect(await reads.readPromise(storage, "k", async () => (loads.push("k"), null))).toBeNull();
        expect(await read(reads, storage, "k")).toBeNull();
        expect(loads).toEqual(["k", "k", "k"]);
        reads.close();
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it("never memoizes a store whose writes it cannot observe", async () => {
    const custom = memoryStorage();
    const { loads, read } = counting(custom);
    const plain: KVStorage = { ...custom };
    const replaced = memoryStorage();
    replaced.set = async () => {};
    const reads = new RequestReads();
    for (const storage of [plain, replaced, view(replaced, "p:")]) {
      await read(reads, storage, "k");
      await read(reads, storage, "k");
    }
    expect(loads).toHaveLength(6);
  });
});

const seededGrant = (origin: string, epoch = "v3:seeded") =>
  JSON.stringify({
    connectaOAuth: 3,
    epoch,
    body: {
      issuer: origin,
      client: { value: { client_id: "client-1", token_endpoint_auth_method: "none" }, registrationPath: "dcr" },
      tokens: { access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1", expires_in: 3600 },
    },
  });

describe("request read memo and OAuth", () => {
  it("never sends a bearer token after another isolate disconnects the grant mid-listing", async () => {
    // Review of #1184: a disconnect between paginated tools/list responses,
    // written by another isolate the memo cannot observe, must stop the
    // walk before page two. A disconnect need not revoke the vendor token.
    installOwnedTransport();
    const origin = "https://oauth-disconnect.example";
    const db = new DatabaseSync(":memory:");
    const count: Count = { roundTrips: 0, statements: 0, log: [] };
    const storage = d1Storage(countingD1(db, count));
    const otherIsolate = d1Storage(countingD1(db, { roundTrips: 0, statements: 0, log: [] }));
    const grantKey = `${scopes.connector("svc")}${oauthGrantKeys.grant}`;
    await storage.set(grantKey, seededGrant(origin));
    const remote = downstream(origin, {
      oauth: true,
      beforePageTwo: () => otherIsolate.set(grantKey, seededGrant(origin, "disconnected:elsewhere")),
    });
    vi.stubGlobal("fetch", remote.fetch);
    const app = createTestConnecta({
      connectors: [remoteMcp("svc", { url: `${origin}/mcp`, auth: { type: "oauth" } })],
      auth: machineAuth(TOKEN),
      storage,
      publicUrl: BASE,
    });
    const text = await callToolText(app, "svc.echo");
    expect(remote.state.pageTwo).toEqual([]);
    expect(text).not.toContain('"text":"hi"');
  });
});

describe("credential reads honor vault overrides", () => {
  // Review of #1184: the request memo must never substitute the built-in
  // vault reader for a subclass's own getAll or metadata, including the
  // fresh read behind a dispatch.
  const SAVED = /\\?"saved\\?":true/;
  class RefusingVault extends CredentialVault {
    override async getAll() {
      return null;
    }
    override async metadata() {
      return null;
    }
  }
  class ThrowingVault extends CredentialVault {
    override async getAll(): Promise<never> {
      throw new Error("vault refused");
    }
    override async metadata(): Promise<never> {
      throw new Error("vault refused");
    }
  }

  async function overridden(Vault: typeof RefusingVault | typeof ThrowingVault) {
    const storage = memoryStorage();
    // The stored credential is real; only the override refuses it.
    await new CredentialVault(storage, CREDENTIAL_KEY).set("crm", "stored-secret-123456", "operator");
    const writes: string[] = [];
    const app = createTestConnecta({
      connectors: [
        api("crm", {
          credential: { label: "Token" },
          tools: [
            {
              name: "save",
              description: "Save a record",
              annotations: { readOnlyHint: false },
              handler: async (_args, ctx) => {
                writes.push(String(await ctx.credential?.get()));
                return { saved: true };
              },
            },
          ],
        }),
      ],
      auth: [machineAuth(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
      storage,
      vault: new Vault(storage, CREDENTIAL_KEY),
      publicUrl: BASE,
      logger: "silent",
      executor: {
        execute: async (_code, providers) => {
          try {
            return { result: await providers.find((p) => p.name === "connecta")!.fns.call!("crm.save", {}) };
          } catch (error) {
            return { result: undefined, error: error instanceof Error ? error.message : String(error) };
          }
        },
      },
    });
    const rpc = async (name: string, args: Record<string, unknown>) =>
      (
        await app.fetch(
          new Request(`${BASE}/mcp`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${TOKEN}`,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-protocol-version": "2025-06-18",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: ++rpcId,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          }),
        )
      ).text();
    return { app, rpc, writes };
  }

  it.each([
    ["refuses", RefusingVault],
    ["throws", ThrowingVault],
  ] as const)(
    "a vault subclass that %s blocks direct and program writes and labels status and UI",
    async (_, Vault) => {
      const { app, rpc, writes } = await overridden(Vault);
      const direct = await rpc("call_destructive_tool", { address: "crm.save", args: {} });
      expect(direct).not.toMatch(SAVED);
      const program = await rpc("execute_code", { code: "async () => connecta.call('crm.save', {})" });
      expect(program).not.toMatch(SAVED);
      expect(writes).toEqual([]);
      const detail = await app.fetch(
        new Request(`${BASE}/ui/connectors/crm`, { headers: { Authorization: "Bearer clerk-token" } }),
      );
      const card = (await detail.json()) as { status: string; credential?: { configured?: boolean } };
      expect(card.status).not.toBe("ok");
      expect(card.credential?.configured).not.toBe(true);
    },
  );

  it("still memoizes the built-in vault and sends its stored credential", async () => {
    const { rpc, writes } = await overridden(CredentialVault as typeof RefusingVault);
    expect(await rpc("execute_code", { code: "async () => connecta.call('crm.save', {})" })).toMatch(SAVED);
    expect(await rpc("call_destructive_tool", { address: "crm.save", args: {} })).toMatch(SAVED);
    expect(writes).toEqual(["stored-secret-123456", "stored-secret-123456"]);
  });
});

describe("request budgets", () => {
  // The common request shapes against a production-shaped deployment: D1
  // storage, a sealed vault holding the API credential and the OAuth grant,
  // Cloudflare Access with the access-token module, a D1 activity sink settled
  // through waitUntil, the operator UI and the QuickJS executor. Dynamic
  // Worker startup needs workerd; QuickJS is its Node stand-in, and neither
  // sends a downstream request or touches D1 on its own.
  const executor = quickJsExecutor({ cpuTimeMs: 5_000 });
  afterAll(async () => {
    await executor.close?.();
  });

  async function production(options: { credentialRemote?: boolean } = {}) {
    installOwnedTransport();
    const origins = {
      legacy: "https://legacy-budget.example",
      modern: "https://modern-budget.example",
      oauth: "https://oauth-budget.example",
      rest: "https://rest-budget.example",
    };
    const legacy = downstream(origins.legacy);
    const oauth = downstream(origins.oauth, { oauth: true });
    const modern = httpDownstream(
      (server) =>
        server.registerTool(
          "echo",
          {
            description: "Echo text back",
            inputSchema: z.object({ text: z.string() }),
            annotations: { readOnlyHint: true },
          },
          async ({ text }) => ({ content: [{ type: "text", text }] }),
        ),
      { url: `${origins.modern}/mcp`, catalogTtlMs: 300_000 },
    );
    const requests: string[] = [];
    let inFlight = 0;
    const route = async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.clone().text() : "";
      const method = /"method":"([^"]+)"/.exec(body)?.[1] ?? "";
      requests.push(`${request.method} ${url.host}${url.pathname} ${method}`.trim());
      if (url.origin === origins.legacy) return legacy.fetch(request);
      if (url.origin === origins.oauth) return oauth.fetch(request);
      if (url.origin === origins.modern) return modern.fetch(request.url, request);
      if (url.origin === origins.rest) return Response.json({ text: "hi" });
      return new Response("unknown host", { status: 404 });
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      inFlight++;
      try {
        return await route(new Request(input, init));
      } finally {
        inFlight--;
      }
    });

    const d1 = counted();
    const storage = d1.storage();
    const vault = encryptedCredentialVault(storage, CREDENTIAL_KEY);
    await vault.set("rest", "rest-credential-value", "operator");
    await vault.set("keyed", "keyed-credential-value", "operator");
    const grantKey = `${scopes.connector("oauth")}${oauthGrantKeys.grant}`;
    await storage.set(grantKey, seededGrant(origins.oauth));
    const headers = { type: "headers" as const, headers: { Authorization: "Bearer downstream-key" } };
    // Each build is a fresh isolate over the same database, with its own
    // storage, vault and activity store as a Worker isolate constructs them.
    const build = () => {
      const storage = d1.storage();
      return createConnecta({
        publicUrl: BASE,
        storage,
        vault: encryptedCredentialVault(storage, CREDENTIAL_KEY),
        readOnly: false,
        executor,
        auth: [cloudflareAccessAuth()],
        maintainers: ["operator-1"],
        accessTokens: accessTokens(storage),
        activity: activityHistory({
          store: d1ActivityStore(d1.binding(), { retentionDays: 90 }),
          deploymentId: "budget",
        }),
        ui: operatorUi(),
        logger: "silent",
        connectors: [
          remoteMcp("legacy", { url: `${origins.legacy}/mcp`, auth: headers }),
          remoteMcp("modern", { url: `${origins.modern}/mcp`, auth: headers }),
          remoteMcp("oauth", { url: `${origins.oauth}/mcp`, auth: { type: "oauth" } }),
          ...(options.credentialRemote
            ? [remoteMcp("keyed", { url: `${origins.legacy}/mcp`, auth: { type: "credential" } })]
            : []),
          api("rest", {
            credential: { label: "API key" },
            tools: [
              {
                name: "echo",
                description: "Echo text back",
                annotations: { readOnlyHint: true },
                handler: async (_args, ctx) => {
                  const key = await ctx.credential!.get();
                  return (
                    await ctx.fetch(`${origins.rest}/echo`, { headers: { authorization: `Bearer ${key}` } })
                  ).json();
                },
              },
            ],
          }),
        ],
      });
    };

    // Cloudflare Access hands the Worker a verified identity on ctx.access.
    const waits: Promise<unknown>[] = [];
    const runtime = {
      access: { aud: "connecta-budget", getIdentity: async () => ({ user_uuid: "operator-1" }) },
      waitUntil: (promise: Promise<unknown>) => void waits.push(promise),
    };
    const settle = async () => {
      // Deferred activity writes and detached session cleanup count too.
      do {
        await Promise.allSettled(waits.splice(0));
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (waits.length > 0 || inFlight > 0);
    };
    const tool = async (app: Connecta, name: string, args: Record<string, unknown>) => {
      const response = await app.fetch(
        new Request(`${BASE}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++rpcId,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
        undefined,
        runtime,
      );
      const text = await response.text();
      expect(text, text).not.toMatch(/"isError":true/);
      return text;
    };
    const call = async (app: Connecta, address: string) =>
      expect(await tool(app, "call_tool", { address, args: { text: "hi" } })).toContain("hi");
    const detail = async (app: Connecta, id: string, query = "") => {
      const response = await app.fetch(new Request(`${BASE}/ui/connectors/${id}${query}`), undefined, runtime);
      expect(response.status).toBe(200);
      return (await response.json()) as { status: string; observedAgeMs?: number };
    };
    const measure = async (label: keyof typeof BUDGETS, run: () => Promise<unknown>) => {
      await settle();
      d1.reset();
      requests.length = 0;
      await run();
      await settle();
      const measured = {
        downstream: requests.length,
        roundTrips: d1.count.roundTrips,
        statements: d1.count.statements,
      };
      report(label, { ...d1.count }, { downstream: measured.downstream });
      const log = [...requests, ...d1.count.log].join("\n");
      const budget = BUDGETS[label];
      expect(measured.downstream, `${label}: downstream\n${log}`).toBeLessThanOrEqual(budget.downstream);
      expect(measured.roundTrips, `${label}: D1 round trips\n${log}`).toBeLessThanOrEqual(budget.roundTrips);
      expect(measured.statements, `${label}: SQL statements\n${log}`).toBeLessThanOrEqual(budget.statements);
      return { ...measured, log: [...d1.count.log] };
    };
    return { build, call, tool, detail, measure, oauth: oauth.state, storage, grantKey };
  }

  it.each(["legacy", "modern"] as const)(
    "a header-auth call to a %s remote MCP server, warm and cold",
    async (kind) => {
      const d = await production();
      const app = d.build();
      await d.call(app, `${kind}.echo`);
      await d.measure(`${kind} call, warm`, () => d.call(app, `${kind}.echo`));
      await d.measure(`${kind} call, cold isolate`, () => d.call(d.build(), `${kind}.echo`));
    },
  );

  it("OAuth calls over a sealed grant, warm, cold, after a 401 and renewed early", async () => {
    const d = await production();
    const app = d.build();
    await d.call(app, "oauth.echo");
    // The first connect sealed the seeded plaintext grant.
    expect(JSON.parse((await d.storage.get(d.grantKey))!).sealed).toEqual(expect.any(String));
    await d.measure("OAuth call, warm", () => d.call(app, "oauth.echo"));
    await d.measure("OAuth call, cold isolate", () => d.call(d.build(), "oauth.echo"));

    // The rotation stores a token 75 seconds from expiry, outside the
    // one-minute renewal window. One call lists the catalog on it, keyed by
    // token; 20 seconds later the next call renews first, and the downstream
    // never sees the old token answer 401.
    d.oauth.token = "rotated-elsewhere";
    d.oauth.expiresIn = 75;
    await d.measure("OAuth call, 401 refresh", () => d.call(app, "oauth.echo"));
    expect(d.oauth.issued).toBe(2);
    await d.call(app, "oauth.echo");
    expect(d.oauth.issued).toBe(2);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 20_000 });
    try {
      const rejected = d.oauth.rejected;
      await d.measure("OAuth call, proactive refresh", () => d.call(app, "oauth.echo"));
      expect(d.oauth.issued).toBe(3);
      expect(d.oauth.rejected).toBe(rejected);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an api() call with a sealed credential, warm and cold", async () => {
    const d = await production();
    const app = d.build();
    await d.call(app, "rest.echo");
    await d.measure("api credential call, warm", () => d.call(app, "rest.echo"));
    await d.measure("api credential call, cold isolate", () => d.call(d.build(), "rest.echo"));
  });

  it("an unscoped warm search over three remote MCP connectors and one api()", async () => {
    const d = await production();
    const app = d.build();
    const search = async () => {
      const text = await d.tool(app, "search_tools", { query: "echo text" });
      for (const address of ["legacy.echo", "modern.echo", "oauth.echo", "rest.echo"]) expect(text).toContain(address);
    };
    await search();
    await d.measure("unscoped search, warm", search);
  });

  it("a program making five calls to one connector", async () => {
    const d = await production();
    const app = d.build();
    await d.call(app, "legacy.echo");
    const program = `async () => {
      const out = [];
      for (let i = 0; i < 5; i++) out.push(await connecta.call("legacy.echo", { text: "hi" + i }));
      return out.length;
    }`;
    await d.measure("execute_code, 5 calls", async () =>
      expect(await d.tool(app, "execute_code", { code: program })).toContain('\\"succeeded\\":5'),
    );
  });

  it("an operator UI connector detail read", async () => {
    const d = await production({ credentialRemote: true });
    const app = d.build();
    for (const id of ["rest", "keyed", "oauth"] as const) {
      await d.detail(app, id);
      const read = await d.measure(`UI detail, ${id}`, async () => expect((await d.detail(app, id)).status).toBe("ok"));
      if (id === "keyed") {
        // Status, drift and the card share one memoized credential read; the
        // probe's read stays fresh.
        expect(read.log.filter((line) => line.includes(":credential:")).length).toBeLessThanOrEqual(3);
      }
    }
    // A stored read answers from the observation the live reads recorded,
    // without the probe or the catalog listing.
    for (const id of ["rest", "keyed", "oauth"] as const)
      await d.measure(`UI stored detail, ${id}`, async () =>
        expect((await d.detail(app, id, "?observation=stored")).observedAgeMs).toBeGreaterThanOrEqual(0),
      );
  });
});

// Measured ceilings for the request budgets above, on the fixture they
// describe. A downstream request is one HTTP request to a vendor: an MCP
// message, OAuth discovery or token call, or session cleanup. A D1 round trip
// is one `all`, `run` or `batch`; a SQL statement is one statement, so a batch
// of two is one round trip and two statements. D1 ceilings carry about 10%
// headroom (at least one); downstream ceilings are exact, since each request
// is a protocol message. Lower is fine; tighten a ceiling when a change lowers
// it, and explain any raise. Before the request read memo (#1184) a warm OAuth
// call took 21 round trips and a refresh 51 statements without the vault or
// activity sink.
const BUDGETS = {
  "legacy call, warm": { downstream: 5, roundTrips: 7, statements: 8 },
  "legacy call, cold isolate": { downstream: 5, roundTrips: 10, statements: 13 },
  "modern call, warm": { downstream: 1, roundTrips: 8, statements: 9 },
  "modern call, cold isolate": { downstream: 1, roundTrips: 11, statements: 14 },
  "OAuth call, warm": { downstream: 5, roundTrips: 21, statements: 22 },
  "OAuth call, cold isolate": { downstream: 5, roundTrips: 24, statements: 27 },
  "OAuth call, 401 refresh": { downstream: 9, roundTrips: 42, statements: 52 },
  "OAuth call, proactive refresh": { downstream: 6, roundTrips: 38, statements: 47 },
  "api credential call, warm": { downstream: 1, roundTrips: 4, statements: 5 },
  "api credential call, cold isolate": { downstream: 1, roundTrips: 7, statements: 10 },
  "unscoped search, warm": { downstream: 0, roundTrips: 22, statements: 22 },
  "execute_code, 5 calls": { downstream: 9, roundTrips: 11, statements: 16 },
  // A live detail records its stored status observation (#1173 item 2.3):
  // one write, batched with the expiry sweep, and, for a static api()
  // catalog whose listing reads no generation, the generation read.
  "UI detail, rest": { downstream: 0, roundTrips: 6, statements: 7 },
  "UI detail, keyed": { downstream: 4, roundTrips: 12, statements: 13 },
  "UI detail, oauth": { downstream: 4, roundTrips: 21, statements: 22 },
  "UI stored detail, rest": { downstream: 0, roundTrips: 5, statements: 5 },
  "UI stored detail, keyed": { downstream: 0, roundTrips: 5, statements: 5 },
  "UI stored detail, oauth": { downstream: 0, roundTrips: 3, statements: 3 },
};
