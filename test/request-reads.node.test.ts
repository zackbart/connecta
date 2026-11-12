// Node-only: uses node:sqlite to verify physical D1 counters.
import { hasTimingTraces, startTimingTrace, traceFor, type TimingFamily } from "../src/timing-trace.js";
import { RequestScope } from "../src/runtime/request-scope.js";
import { getNativeStorage } from "../src/runtime/native-storage.js";
// Node-only: node:sqlite stands in for D1 so every round trip and statement is counted, and QuickJS runs programs.
//
// The request read memo (src/runtime/request-reads.ts), then request budgets:
// downstream requests, D1 round trips and SQL statements for the request
// shapes that repeat most, on a production-shaped deployment. A round trip is
// one `all`, `run` or `batch` call; a statement is one SQL statement, so a
// batch of two is one round trip and two statements. Workers Free allows 50 D1
// queries per invocation. The numbers are ceilings: lower is fine, higher is a
// regression to explain. `D1_BUDGET_REPORT=1` prints each measurement.
import { withD1Latency } from "../eval/deploy/d1-latency.js";
import { Registry } from "../src/registry.js";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WebStandardStreamableHTTPServerTransport, McpServer } from "@modelcontextprotocol/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { KvOAuthProvider } from "../src/auth/downstream-oauth.js";
import { vaultOAuthSealer } from "../src/oauth-sealing.js";
import { silentLogger } from "./helpers.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { api } from "../src/connectors/api.js";
import { CredentialVault, encryptedCredentialVault } from "../src/credentials.js";
import { d1ActivityStore, d1Storage, type D1DatabaseBinding } from "../src/d1.js";
import { agentAdmissionFixture, issueAgentToken } from "./helpers/agent-tokens.js";
import { AccessTokenManager, accessTokens } from "../src/access-tokens.js";
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
import { oauthGrantKeys, responseCacheKeys, resultKeys, scopes } from "../src/storage/keys.js";
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
  afterRead?: ((params: unknown[]) => Promise<void>) | undefined;
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
      const results = db.prepare(sql).all(...(params as never[]));
      await count.afterRead?.(params);
      return { results };
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

function counted(latencyMs = 0) {
  const db = new DatabaseSync(":memory:");
  const count: Count = { roundTrips: 0, statements: 0, log: [] };
  const binding = () =>
    latencyMs ? withD1Latency(countingD1(db, count) as unknown as D1Database, latencyMs) : countingD1(db, count);
  return {
    count,
    db,
    storage: () => d1Storage(binding()),
    binding,
    reset: () => {
      count.roundTrips = 0;
      count.statements = 0;
      count.log.length = 0;
    },
  };
}

describe("SQL stash batch budgets and faults", () => {
  it("publishes 32 chunks in six trips with one trailing-chunk sweep", async () => {
    const d1 = counted();
    const storage = d1.storage();
    await storage.get("warm");
    d1.reset();
    const registry = new Registry([], { storage, logger: silentLogger });
    expect(
      await registry.stashResult(
        "budget",
        Array.from({ length: 32 }, () => "x"),
        900,
      ),
    ).toBe(true);
    report("32 chunk stash", d1.count);
    expect(d1.count.roundTrips).toBe(6);
    expect(d1.count.statements).toBe(40);
    expect(d1.count.log.filter((line) => line.startsWith("batch(32)"))).toHaveLength(1);
    d1.db.close();
  });

  it("retains a delayed batch's charge at capacity until its reservation expires", async () => {
    const d1 = counted();
    const binding = d1.binding();
    const batch = binding.batch.bind(binding);
    let commit: (() => Promise<unknown>) | undefined;
    binding.batch = async (statements) => {
      if (statements.length === 3 && !commit) {
        commit = () => batch(statements);
        throw new Error("lost batch response");
      }
      return batch(statements);
    };
    const storage = d1Storage(binding);
    const registry = new Registry([], {
      storage,
      logger: silentLogger,
      results: { maxStashEntries: 1, maxStashBytes: 12 },
    });
    try {
      await expect(registry.stashResult("delayed", ["header", "one", "two"], 900)).rejects.toThrow(
        "lost batch response",
      );
      expect(commit).toBeDefined();
      expect(await registry.stashResult("replacement", ["x"], 900)).toBe(false);
      await commit!();
      expect(await storage.get(scopes.results + resultKeys.chunk("delayed", 1))).toBe("one");
      expect(await registry.stashResult("still-full", ["x"], 900)).toBe(false);
      // Age storage's authoritative deadlines as well as the caller's clock.
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 931_000);
      d1.db.prepare("UPDATE connecta_kv SET expires_at_ms = 1 WHERE expires_at_ms IS NOT NULL").run();
      expect(await registry.stashResult("recovered", ["x"], 900)).toBe(true);
    } finally {
      vi.restoreAllMocks();
      d1.db.close();
    }
  });

  it.each(["partial", "ambiguous", "ambiguous header"])(
    "refuses %s trailing publication and recovers",
    async (mode) => {
      const d1 = counted();
      const binding = d1.binding();
      const batch = binding.batch.bind(binding);
      let fail = true;
      binding.batch = async (statements) => {
        const header = statements.some((statement) =>
          (statement as unknown as { params: unknown[] }).params.includes("header"),
        );
        if (fail && (mode === "ambiguous header" ? header : statements.length === 3)) {
          fail = false;
          if (mode === "partial") await batch(statements.slice(0, 2));
          else await batch(statements);
          throw new Error("lost batch response");
        }
        return batch(statements);
      };
      const storage = d1Storage(binding);
      await storage.get("warm");
      const registry = new Registry([], { storage, logger: silentLogger });
      await expect(registry.stashResult("failed", ["header", "one", "two"], 900)).rejects.toThrow(
        "lost batch response",
      );
      expect(await storage.get(scopes.results + resultKeys.chunk("failed", 0))).toBeNull();
      expect(d1.count.log.some((line) => line.includes('"header"'))).toBe(mode === "ambiguous header");
      expect(await registry.stashResult("recovered", ["header", "one", "two"], 900)).toBe(true);
      d1.db.close();
    },
  );
});

/** A stateful downstream with one read tool, behind optional OAuth. */
function downstream(
  origin: string,
  options: { oauth?: boolean; beforePageTwo?: () => Promise<void>; writeProbe?: boolean } = {},
) {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const state = {
    token: "access-1",
    issued: 1,
    rejected: 0,
    expiresIn: 3600,
    pageTwo: [] as (string | null)[],
    mutations: [] as string[],
  };
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
      if (
        request.headers.get("authorization") !== `Bearer ${state.token}` &&
        !(options.writeProbe && !request.headers.has("authorization"))
      ) {
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
        annotations: { readOnlyHint: !options.writeProbe },
      },
      async ({ text }) => {
        if (options.writeProbe) state.mutations.push(text);
        return { content: [{ type: "text", text }] };
      },
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

  it("batches physical keys across views and preserves fresh and overlapping-write observations", async () => {
    const d1 = counted();
    const storage = d1.storage();
    const scoped = view(storage, "owner:");
    await storage.set("owner:a", "old");
    await storage.set("b", "old");
    const reads = new RequestReads();
    const { authStorageMany } = await import("../src/auth/native.js");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = runEdge(
      reads.prefetch(
        [
          { storage: scoped, key: "a" },
          { storage, key: "b" },
        ],
        (root, keys) =>
          Effect.flatMap(authStorageMany(root, keys), (values) =>
            Effect.promise(async () => {
              started();
              await gate;
              return values;
            }),
          ),
      ),
    );
    await entered;
    await scoped.set("a", "new");
    await storage.set("b", "fresh");
    // The fresh read started after prefetch wins even if prefetch settles last.
    expect(
      await runEdge(
        reads.read(
          storage,
          "b",
          Effect.promise(() => storage.get("b")),
          true,
        ),
      ),
    ).toBe("fresh");
    release();
    await pending;
    expect(await reads.readPromise(scoped, "a", () => scoped.get("a"))).toBe("new");
    expect(await reads.readPromise(storage, "b", () => storage.get("b"))).toBe("fresh");
    reads.close();
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

  it("takes a memoized value once, never loads, and yields nothing a write or a partition hides", async () => {
    const { loads, read, storage } = counting(memoryStorage());
    const alice = view(storage, "principal:alice:");
    const bob = view(storage, "principal:bob:");
    await alice.set("chunk", "alice");
    await bob.set("chunk", "bob");
    const reads = new RequestReads();
    // Nothing read yet: a take answers nothing and reads no storage.
    expect(reads.take(alice, "chunk")).toBeUndefined();
    await read(reads, alice, "chunk");
    // Bob's partition never answers from Alice's entry.
    expect(reads.take(bob, "chunk")).toBeUndefined();
    // Another view of the same partition takes it once, then the memo holds nothing.
    expect(reads.take(view(storage, "principal:alice:"), "chunk")).toBe("alice");
    expect(reads.take(alice, "chunk")).toBeUndefined();
    await read(reads, alice, "chunk");
    await alice.set("chunk", "rewritten");
    expect(reads.take(alice, "chunk")).toBeUndefined();
    await read(reads, alice, "chunk");
    reads.close();
    expect(reads.take(alice, "chunk")).toBeUndefined();
    expect(loads).toEqual(["chunk", "chunk", "chunk"]);
    // A store whose writes are unobserved is never answered.
    const plain: KVStorage = { ...memoryStorage() };
    const other = new RequestReads();
    await read(other, plain, "chunk");
    expect(other.take(plain, "chunk")).toBeUndefined();
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
  it("warm API OAuth calls add no grant writes once accepted", async () => {
    installOwnedTransport();
    const d1 = counted();
    const storage = d1.storage();
    const origin = "https://api-budget.example";
    await storage.set(`${scopes.connector("api")}${oauthGrantKeys.grant}`, seededGrant(`${origin}/token`));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true })),
    );
    const connector = api("api", {
      oauth: {
        authorizationEndpoint: `${origin}/authorize`,
        tokenEndpoint: `${origin}/token`,
        clientId: "client-1",
        apiOrigins: [origin],
      },
      tools: [
        {
          name: "read",
          description: "Read",
          annotations: { readOnlyHint: true },
          handler: async (_args, ctx) => (await ctx.oauth!.fetch(`${origin}/data`)).json(),
        },
      ],
    });
    const app = createTestConnecta({
      connectors: [connector],
      storage,
      vault: new CredentialVault(storage, CREDENTIAL_KEY),
      logger: "silent",
    });
    try {
      const call = async () => {
        const ctx = app.registry.contextFor("api", BASE);
        expect(await connector.callTool("read", {}, ctx)).toEqual({ ok: true });
      };
      await call();
      d1.reset();
      await call();
      report("API OAuth call, warm", d1.count);
      expect(d1.count.log.filter((line) => !line.startsWith("all "))).toEqual([]);
      expect(d1.count.roundTrips).toBeLessThanOrEqual(4);
      expect(d1.count.statements).toBeLessThanOrEqual(4);
    } finally {
      await app.close();
      d1.db.close();
    }
  });

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
  // A warm locating read carries the hinted chunks. The connection's binding
  // grant reads follow it, then acceptance's identity read and generation
  // fence. A fault injected after the binding reads lands where the separate
  // chunk read used to, between the catalog data and its acceptance.
  const bindingGrantReads = (oauthModern: boolean) => (oauthModern ? 3 : 1);

  async function production(
    options: {
      credentialRemote?: boolean;
      oauthModern?: boolean;
      beforeOAuthDelete?: () => Promise<void>;
      oauthWriteProbe?: boolean;
      trace?: boolean;
      agent?: boolean;
      d1LatencyMs?: number;
    } = {},
  ) {
    installOwnedTransport();
    const traceLogs: unknown[] = [];
    const origins = {
      legacy: "https://legacy-budget.example",
      modern: "https://modern-budget.example",
      oauth: "https://oauth-budget.example",
      rest: "https://rest-budget.example",
    };
    const legacy = downstream(origins.legacy);
    const oauth = downstream(origins.oauth, { oauth: true, writeProbe: options.oauthWriteProbe ?? false });
    const modern = httpDownstream(
      (server) =>
        server.registerTool(
          "echo",
          {
            description: "Echo text back",
            inputSchema: z.object({ text: z.string() }),
            annotations: { readOnlyHint: !options.oauthWriteProbe },
          },
          async ({ text }) => {
            if (options.oauthWriteProbe) oauth.state.mutations.push(text);
            return { content: [{ type: "text", text }] };
          },
        ),
      { url: `${origins.modern}/mcp`, catalogTtlMs: 300_000 },
    );
    const requests: string[] = [];
    const oauthRequests: { method: string; token: string | null }[] = [];
    const oauthSessions = new Set<string>();
    let cleanupFinished!: () => void;
    const oauthCleanup = new Promise<void>((resolve) => {
      cleanupFinished = resolve;
    });
    let inFlight = 0;
    const route = async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.clone().text() : "";
      const method = /"method":"([^"]+)"/.exec(body)?.[1] ?? "";
      requests.push(`${request.method} ${url.host}${url.pathname} ${method}`.trim());
      if (url.origin === origins.legacy) return legacy.fetch(request);
      if (url.origin === origins.oauth) {
        oauthRequests.push({ method: method || request.method, token: request.headers.get("authorization") });
        if (options.oauthModern && url.pathname === "/mcp") {
          if (
            request.headers.get("authorization") !== `Bearer ${oauth.state.token}` &&
            !(options.oauthWriteProbe && !request.headers.has("authorization"))
          )
            return new Response(null, { status: 401 });
          return modern.fetch(request.url, request);
        }
        const response = await oauth.fetch(request);
        if (response.headers.has("mcp-session-id")) oauthSessions.add(response.headers.get("mcp-session-id")!);
        return response;
      }
      if (url.origin === origins.modern) return modern.fetch(request.url, request);
      if (url.origin === origins.rest) return Response.json({ text: "hi" });
      return new Response("unknown host", { status: 404 });
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const oauthDelete =
        new URL(request.url).origin === origins.oauth &&
        request.method === "DELETE" &&
        oauthSessions.has(request.headers.get("mcp-session-id") ?? "");
      if (oauthDelete) await options.beforeOAuthDelete?.();
      inFlight++;
      try {
        try {
          return await route(request);
        } finally {
          if (oauthDelete) cleanupFinished();
        }
      } finally {
        inFlight--;
      }
    });

    const d1 = counted(options.d1LatencyMs);
    const storage = d1.storage();
    const agentToken = options.agent ? await issueAgentToken(storage, "assistant") : undefined;
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
        ...(options.agent
          ? { agents: ["assistant"], pools: { machine: { tools: ["modern"], members: ["agent:assistant"] } } }
          : {
              activity: activityHistory({
                store: d1ActivityStore(d1.binding(), { retentionDays: 90 }),
                deploymentId: "budget",
              }),
            }),
        ui: operatorUi(),
        logger: options.trace
          ? {
              ...silentLogger,
              info: (...args: unknown[]) => {
                if (args[0] === "connecta.timing") traceLogs.push(args[1]);
              },
            }
          : "silent",
        timingTraceSampleRate: options.trace ? 1 : 0,
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
    const tool = async (
      app: Connecta,
      name: string,
      args: Record<string, unknown>,
      expectError: boolean | null = false,
    ) => {
      const response = await app.fetch(
        new Request(options.agent ? `${BASE}/agent/machine` : `${BASE}/mcp`, {
          method: "POST",
          headers: {
            ...(agentToken ? { authorization: `Bearer ${agentToken}` } : {}),
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
      if (expectError !== null) expect(/"isError":true/.test(text), text).toBe(expectError);
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
      if (["legacy call, warm", "modern call, warm", "OAuth call, warm"].includes(label)) {
        const catalog = d1.count.log.filter((line) => line.includes("response-cache:"));
        expect(catalog, catalog.join("\n")).toHaveLength(2);
        expect(catalog[0]).toContain("negotiation:");
        expect(catalog[0]).toContain(":generation");
        // The isolate's revision hint puts the chunks in the locating read.
        expect(catalog[0]).toContain(":chunk:");
        // This SELECT must follow the chunks, separate from the locating batch.
        expect(catalog[1]).toMatch(/^all \["response-cache:.*:generation"\]$/);
      }
      const budget = BUDGETS[label];
      expect(measured.downstream, `${label}: downstream\n${log}`).toBeLessThanOrEqual(budget.downstream);
      expect(measured.roundTrips, `${label}: D1 round trips\n${log}`).toBeLessThanOrEqual(budget.roundTrips);
      expect(measured.statements, `${label}: SQL statements\n${log}`).toBeLessThanOrEqual(budget.statements);
      return { ...measured, log: [...d1.count.log] };
    };
    const otherStorage = d1.storage();
    const otherProvider = () =>
      new KvOAuthProvider(
        "oauth",
        view(otherStorage, scopes.connector("oauth")),
        `${BASE}/oauth/callback/oauth`,
        undefined,
        false,
        vaultOAuthSealer(encryptedCredentialVault(otherStorage, CREDENTIAL_KEY), "oauth", undefined, silentLogger),
      );
    return {
      traceLogs,
      build,
      call,
      tool,
      detail,
      measure,
      oauth: oauth.state,
      storage,
      grantKey,
      oauthRequests,
      oauthCleanup,
      otherProvider,
      otherStorage,
      d1,
      requests,
      settle,
      afterRead: (hook: Count["afterRead"]) => {
        d1.count.afterRead = hook;
      },
    };
  }

  it("emits complete warm-request timing records through the configured logger", async () => {
    const d = await production({ trace: true });
    const app = d.build();
    await d.call(app, "modern.echo");
    await d.call(app, "modern.echo");
    await d.settle();
    expect(d.traceLogs).toHaveLength(2);
    const record = d.traceLogs[1] as { operations: Record<string, { count: number; items: number }> };
    expect(record.operations["catalog.cache.hit"]?.count).toBeGreaterThan(0);
    expect(record.operations["catalog.accepted"]?.items).toBeGreaterThan(0);
    expect(record.operations["d1.read"]?.count).toBeGreaterThan(0);
    expect(record.operations["catalog"]?.count).toBe(1);
    const text = JSON.stringify(d.traceLogs);
    for (const secret of ["modern", "echo", TOKEN, "access-1", "operator-1"]) expect(text).not.toContain(secret);
  });

  it("finalizes timing when an owned downstream response throws during disposal", async () => {
    const d = await production({ trace: true });
    const app = d.build();
    const send = globalThis.fetch;
    const failure = new Error("disposal fault");
    const disposed = vi.fn(() => {
      throw failure;
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await send(input, init);
      Object.defineProperty(response, Symbol.dispose, { value: disposed });
      return response;
    });
    expect(hasTimingTraces()).toBe(false);
    await d.call(app, "modern.echo");
    await d.settle();
    expect(disposed).toHaveBeenCalled();
    expect(d.traceLogs).toHaveLength(1);
    expect(hasTimingTraces()).toBe(false);
    // The next unsampled request must not inherit the failed trace's active state.
    const unsampled = await production();
    await unsampled.call(unsampled.build(), "modern.echo");
    await unsampled.settle();
    expect(hasTimingTraces()).toBe(false);
    expect(d.traceLogs).toHaveLength(1);
  });

  it("pins warm agent call, program and search reads with injected D1 latency", async () => {
    const d = await production({ agent: true, d1LatencyMs: 25 });
    const app = d.build();
    await d.call(app, "modern.echo");
    for (const [name, args, expected] of [
      ["call_tool", { address: "modern.echo", args: { text: "hi" } }, 3],
      ["execute_code", { code: 'async () => connecta.call("modern.echo", {text: "hi"})' }, 3],
      ["search_tools", { query: "echo" }, 4],
    ] as const) {
      await d.settle();
      d.d1.reset();
      const start = performance.now();
      await d.tool(app, name, args);
      const elapsedMs = Math.round(performance.now() - start);
      const reads = d.d1.count.log.filter((line) => line.startsWith("all "));
      const observationReads = reads.filter((line) => line.includes("agent-observation:")).length;
      expect(reads, reads.join("\n")).toHaveLength(expected);
      expect(observationReads).toBe(0);
      console.log(
        JSON.stringify({ route: name, injectedD1LatencyMs: 25, reads: reads.length, observationReads, elapsedMs }),
      );
    }
  }, 60_000);

  it.each([
    ["legacy", "invalidation"],
    ["modern", "invalidation"],
    ["legacy", "lost response"],
    ["modern", "lost response"],
  ] as const)("refuses stale locating candidates after %s %s and recovers", async (kind, fault) => {
    const d = await production();
    const app = d.build();
    await d.call(app, `${kind}.echo`);
    await d.settle();
    d.requests.length = 0;
    let changed = false;
    d.afterRead(async (params) => {
      if (
        !params.includes(responseCacheKeys.generation(kind)) ||
        !params.some((key) => typeof key === "string" && key.includes("negotiation:"))
      )
        return;
      d.afterRead(undefined);
      changed = true;
      if (fault === "lost response") throw new Error("lost locating response");
      await d.otherStorage.set(responseCacheKeys.generation(kind), crypto.randomUUID());
    });
    await d.call(app, `${kind}.echo`);
    expect(changed).toBe(true);
    if (fault === "invalidation") expect(d.requests.some((request) => request.endsWith("tools/list"))).toBe(true);
    await d.call(app, `${kind}.echo`);
  });

  it.each(["legacy", "modern"] as const)(
    "a header-auth call to a %s remote MCP server, warm and cold",
    async (kind) => {
      const d = await production();
      const app = d.build();
      await d.call(app, `${kind}.echo`);
      const warm = await d.measure(`${kind} call, warm`, () => d.call(app, `${kind}.echo`));
      expect([warm.roundTrips, warm.statements]).toEqual([3, 4]);
      const program = await d.measure(`${kind} call, warm`, () =>
        d.tool(app, "execute_code", {
          code: `async () => connecta.call("${kind}.echo", { text: "hi" })`,
        }),
      );
      expect([program.roundTrips, program.statements]).toEqual([3, 4]);
      await d.measure(`${kind} call, cold isolate`, () => d.call(d.build(), `${kind}.echo`));
    },
  );

  it("OAuth calls over a sealed grant, warm, cold, after a 401 and renewed early", async () => {
    const d = await production();
    const app = d.build();
    await d.call(app, "oauth.echo");
    // The first connect sealed the seeded plaintext grant.
    expect(JSON.parse((await d.storage.get(d.grantKey))!).sealed).toEqual(expect.any(String));
    const warm = await d.measure("OAuth call, warm", () => d.call(app, "oauth.echo"));
    expect([warm.roundTrips, warm.statements]).toEqual([15, 16]);
    const program = await d.measure("OAuth call, warm", () =>
      d.tool(app, "execute_code", {
        code: 'async () => connecta.call("oauth.echo", { text: "hi" })',
      }),
    );
    expect([program.roundTrips, program.statements]).toEqual([15, 16]);
    expect(warm.log.filter((line) => line.startsWith("all ") && line.includes(d.grantKey))).toHaveLength(12);
    expect(program.log.filter((line) => line.startsWith("all ") && line.includes(d.grantKey))).toHaveLength(12);
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

  it("a warm modern OAuth catalog avoids re-listing on both routes", async () => {
    const d = await production({ oauthModern: true });
    const app = d.build();
    await d.call(app, "oauth.echo");
    for (const route of ["direct", "program"]) {
      const measured = await d.measure("OAuth call, warm", () =>
        route === "direct"
          ? d.call(app, "oauth.echo")
          : d.tool(app, "execute_code", { code: 'async () => connecta.call("oauth.echo", { text: "hi" })' }),
      );
      expect(measured.log.filter((line) => line.startsWith("all ") && line.includes(d.grantKey))).toHaveLength(9);
      expect(measured.downstream).toBe(1);
      expect([measured.roundTrips, measured.statements]).toEqual([12, 13]);
    }
  });

  it.each([
    [false, "chunks", false],
    [true, "chunks", false],
    [false, "invocation", false],
    [true, "invocation", false],
    [false, "chunks", true],
    [false, "invocation", true],
  ] as const)(
    "OAuth modern=%s preserves rotation, disconnect and refresh across %s gated=%s",
    async (oauthModern, boundary, gated) => {
      for (const change of ["rotation", "disconnect", "refresh"] as const) {
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const deleting = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const d = await production({
          oauthModern,
          ...(gated
            ? {
                beforeOAuthDelete: async () => {
                  entered();
                  await gate;
                },
              }
            : {}),
        });
        const app = d.build();
        await d.call(app, "oauth.echo");
        if (gated) {
          await deleting;
          let finished = false;
          void d.oauthCleanup.then(() => {
            finished = true;
          });
          await Promise.resolve();
          expect(finished).toBe(false);
          release();
        }
        // Legacy session DELETE has an explicit completion signal; idle samples
        // cannot prove that teardown has even entered the counted fetch shim.
        if (!oauthModern) await d.oauthCleanup;
        await d.settle();
        d.oauthRequests.length = 0;
        let pastChunks = false;
        let grantReads = 0;
        let changed = false;
        d.afterRead(async (params) => {
          const chunk = params.some((key) => typeof key === "string" && key.includes(":chunk:"));
          if (chunk) pastChunks = true;
          if (pastChunks && params.includes(d.grantKey)) grantReads++;
          // The second grant read after the binding reads checks disconnect; the
          // separate invocation tokens() read follows it, even when the epoch is unchanged.
          // Publish after its SELECT captured the old value; dispatch must read again.
          const binding = bindingGrantReads(oauthModern);
          if (!pastChunks || (boundary === "chunks" ? grantReads !== binding : grantReads !== binding + 2)) return;
          d.afterRead(undefined);
          changed = true;
          // A separate provider and SQL storage instance publishes between reads,
          // without notifying this request's storage memo.
          const other = d.otherProvider();
          if (change === "disconnect") await other.resetAuthorization(true);
          else {
            const tokens = {
              access_token: "access-2",
              token_type: "Bearer",
              refresh_token: "refresh-2",
              expires_in: 3600,
            };
            if (change === "rotation") {
              await other.resetAuthorization();
              await other.saveTokens(tokens, { issuer: "https://oauth-budget.example" });
            } else {
              expect(
                await other.storeRefresh("v3:seeded", "refresh-1", tokens, "https://oauth-budget.example"),
              ).toMatchObject(tokens);
            }
            d.oauth.token = tokens.access_token;
          }
          for (const request of d.oauthRequests) expect(request.method).toBe("DELETE");
          d.oauthRequests.length = 0;
        });
        const refused = change === "disconnect" || (oauthModern && boundary === "chunks" && change === "rotation");
        const text = await d.tool(app, "call_tool", { address: "oauth.echo", args: { text: "hi" } }, refused);
        await d.settle();
        expect(changed, change).toBe(true);
        if (change === "disconnect") {
          const error = JSON.parse(text).result.structuredContent.error;
          if (oauthModern && boundary === "chunks") {
            expect(error).toMatchObject({ code: "unavailable", retryable: true });
            expect(error.message).toContain("authorization changed");
          } else {
            expect(error).toMatchObject({
              code: "downstream_oauth_required",
              status: "auth_required",
              retryable: false,
            });
          }
          expect(d.oauthRequests).toEqual([]);
          expect(await d.otherProvider().tokens()).toBeUndefined();
        } else {
          if (refused) {
            expect(text).toContain("authorization changed");
            expect(d.oauthRequests).toEqual([]);
          } else {
            expect(text).toContain("hi");
            if (boundary === "chunks")
              expect(
                d.oauthRequests.some(({ method }) => method === "tools/list"),
                change,
              ).toBe(true);
          }
          for (const request of d.oauthRequests)
            expect(request.token, JSON.stringify({ change, boundary, oauthModern, requests: d.oauthRequests })).toBe(
              "Bearer access-2",
            );
          expect(await d.otherProvider().tokens()).toMatchObject({
            access_token: "access-2",
            refresh_token: "refresh-2",
          });
          // A later call retains the committed refresh and never redeems it again.
          await d.call(app, "oauth.echo");
          await d.settle();
          expect(d.oauth.issued).toBe(1);
        }
      }
    },
  );

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("OAuth write refuses same-epoch token invalidation modern=%s program=%s", async (oauthModern, program) => {
    // Adapted from the independent #1227 write probe: this downstream accepts
    // anonymous writes, so its physical ledger catches a missing bearer header.
    const d = await production({ oauthModern, oauthWriteProbe: true });
    const app = d.build();
    await d.tool(app, "call_destructive_tool", { address: "oauth.echo", args: { text: "warmup" } });
    if (!oauthModern) await d.oauthCleanup;
    await d.settle();
    expect(JSON.parse((await d.storage.get(d.grantKey))!).sealed).toEqual(expect.any(String));
    d.oauthRequests.length = 0;
    d.oauth.mutations.length = 0;
    let pastChunks = false;
    let grantReads = 0;
    let changed = false;
    d.afterRead(async (params) => {
      if (params.some((key) => typeof key === "string" && key.includes(":chunk:"))) pastChunks = true;
      // Invalidate after the disconnect SELECT captured valid tokens, where
      // the combined invocation snapshot used to admit this call.
      if (!pastChunks || !params.includes(d.grantKey) || ++grantReads !== bindingGrantReads(oauthModern) + 2) return;
      d.afterRead(undefined);
      changed = true;
      const other = d.otherProvider();
      expect(await other.tokens()).toBeDefined();
      await other.invalidateCredentials("tokens");
      expect(await other.liveEpoch()).toBe("v3:seeded");
    });
    const text = program
      ? await d.tool(
          app,
          "execute_code",
          { code: 'async () => connecta.call("oauth.echo", { text: "mutation" })' },
          null,
        )
      : await d.tool(app, "call_destructive_tool", { address: "oauth.echo", args: { text: "mutation" } }, null);
    await d.settle();
    expect(changed).toBe(true);
    expect(d.oauth.mutations).toEqual([]);
    // No handshake, tool call, anonymous leg, refresh or replay is sent.
    expect(d.oauthRequests).toEqual([]);
    expect(await d.otherProvider().tokens()).toBeUndefined();
    const result = JSON.parse(text).result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      code: "downstream_oauth_required",
      recovery: "oauth",
      status: "auth_required",
      retryable: false,
      nextAction: { url: expect.stringContaining("/connect/oauth"), purpose: expect.any(String) },
    });
    if (program) {
      expect(result.structuredContent.error.writes).toEqual({ succeeded: 0, failed: 1, unknown: 0 });
      expect(result.structuredContent.hostCalls).toMatchObject({ attempted: 1, failed: 1 });
    } else expect(result.structuredContent.attempts).toBe(1);
  });

  it.each([
    [false, "expiry"],
    [true, "expiry"],
    [false, "scope"],
    [true, "scope"],
    [false, "replacement"],
    [true, "replacement"],
  ] as const)("OAuth modern=%s observes same-epoch %s before invocation", async (oauthModern, change) => {
    const d = await production({ oauthModern });
    const app = d.build();
    await d.call(app, "oauth.echo");
    if (!oauthModern) await d.oauthCleanup;
    await d.settle();
    const old = (await d.otherProvider().tokens())!;
    d.oauthRequests.length = 0;
    let pastChunks = false;
    let grantReads = 0;
    let changed = false;
    d.afterRead(async (params) => {
      if (params.some((key) => typeof key === "string" && key.includes(":chunk:"))) pastChunks = true;
      if (!pastChunks || !params.includes(d.grantKey) || ++grantReads !== bindingGrantReads(oauthModern) + 2) return;
      d.afterRead(undefined);
      changed = true;
      const tokens = {
        ...old,
        ...(change === "expiry" ? { expires_in: 1 } : {}),
        ...(change === "scope" ? { scope: "notes:write" } : {}),
        ...(change === "replacement" ? { access_token: "replaced-access", refresh_token: "replaced-refresh" } : {}),
      };
      const other = d.otherProvider();
      expect(
        await other.storeRefresh("v3:seeded", old.refresh_token!, tokens, "https://oauth-budget.example"),
      ).toMatchObject(tokens);
      expect(await other.liveEpoch()).toBe("v3:seeded");
      d.oauth.token = tokens.access_token;
    });
    await d.call(app, "oauth.echo");
    await d.settle();
    expect(changed).toBe(true);
    const calls = d.oauthRequests.filter(({ method }) => method === "tools/call");
    const expectedToken =
      change === "expiry" ? "access-2" : change === "replacement" ? "replaced-access" : old.access_token;
    expect(calls).toEqual([{ method: "tools/call", token: `Bearer ${expectedToken}` }]);
    // The fresh admission read, rather than a later SDK read, must observe a
    // shortened expiry in time to renew without sending the stale access token.
    expect(d.oauth.issued).toBe(change === "expiry" ? 2 : 1);
    expect(d.oauth.rejected, JSON.stringify(d.oauthRequests)).toBe(0);
    const stored = await d.otherProvider().tokens();
    expect(stored?.access_token).toBe(expectedToken);
    if (change === "scope") expect(stored?.scope).toBe("notes:write");
    if (change === "replacement") expect(stored?.refresh_token).toBe("replaced-refresh");
    await d.call(app, "oauth.echo");
    await d.settle();
    expect(d.oauth.issued).toBe(change === "expiry" ? 2 : 1);
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
// it, and explain any raise. Warm calls additionally pin exact counts and
// the separate post-chunk fence, for both direct and one-call programs.
// Before the request read memo (#1184) a warm OAuth
// call took 21 round trips and a refresh 51 statements without the vault or
// activity sink.
const BUDGETS = {
  "legacy call, warm": { downstream: 5, roundTrips: 3, statements: 4 },
  "legacy call, cold isolate": { downstream: 5, roundTrips: 10, statements: 13 },
  "modern call, warm": { downstream: 1, roundTrips: 3, statements: 4 },
  "modern call, cold isolate": { downstream: 1, roundTrips: 11, statements: 14 },
  "OAuth call, warm": { downstream: 5, roundTrips: 15, statements: 16 },
  "OAuth call, cold isolate": { downstream: 5, roundTrips: 24, statements: 27 },
  "OAuth call, 401 refresh": { downstream: 9, roundTrips: 41, statements: 51 },
  "OAuth call, proactive refresh": { downstream: 6, roundTrips: 37, statements: 46 },
  "api credential call, warm": { downstream: 1, roundTrips: 4, statements: 5 },
  "api credential call, cold isolate": { downstream: 1, roundTrips: 7, statements: 10 },
  "unscoped search, warm": { downstream: 0, roundTrips: 19, statements: 19 },
  "execute_code, 5 calls": { downstream: 9, roundTrips: 10, statements: 15 },
  // A live detail records its stored status observation (#1173 item 2.3):
  // one write, batched with the expiry sweep, and, for a static api()
  // catalog whose listing reads no generation, the generation read.
  "UI detail, rest": { downstream: 0, roundTrips: 6, statements: 7 },
  "UI detail, keyed": { downstream: 4, roundTrips: 11, statements: 12 },
  "UI detail, oauth": { downstream: 4, roundTrips: 20, statements: 21 },
  "UI stored detail, rest": { downstream: 0, roundTrips: 5, statements: 5 },
  "UI stored detail, keyed": { downstream: 0, roundTrips: 5, statements: 5 },
  "UI stored detail, oauth": { downstream: 0, roundTrips: 3, statements: 3 },
};

it("pins warm agent admission and observation to one D1 read, without a catalog", async () => {
  const d1 = counted();
  const storage = d1.storage();
  const token = await issueAgentToken(storage, "assistant");
  const { app, ping } = agentAdmissionFixture(storage);
  try {
    expect((await ping(token)).status).toBe(200);
    d1.reset();
    expect((await ping(token)).status).toBe(200);
    expect(d1.count.roundTrips).toBe(1);
    expect(d1.count.statements).toBe(1);
    await new AccessTokenManager(storage, { agents: ["assistant"] }).revoke("assistant");
    expect((await ping(token)).status).toBe(401);
  } finally {
    await app.close();
  }
});

describe("payload-free timing trace", () => {
  it("counts physical D1 trips/statements and memo outcomes without retaining keys or payloads", async () => {
    const identity = {};
    const info = vi.fn();
    const logger = { ...silentLogger, info };
    const finish = startTimingTrace(identity, 1, logger)!;
    const db = new DatabaseSync(":memory:");
    const count: Count = { roundTrips: 0, statements: 0, log: [] };
    const storage = d1Storage(countingD1(db, count));
    const native = getNativeStorage(storage)!;
    const owner = requestOwner(identity);
    const reads = requestReads(identity);
    const run = <A>(operation: Effect.Effect<A, unknown>) =>
      runEdge(operation.pipe(Effect.provideService(RequestScope, owner)));
    await run(native.set("private-owner-secret-key", "secret-payload"));
    const read = () => run(reads.read(storage, "private-owner-secret-key", native.get("private-owner-secret-key")));
    expect(await read()).toBe("secret-payload");
    expect(await read()).toBe("secret-payload");
    await run(reads.read(storage, "missing-secret-key", native.get("missing-secret-key"), true));
    const trace = traceFor(identity)!;
    trace.record("attacker-payload" as TimingFamily, 1);
    trace.record("catalog", Number.NaN, Number.POSITIVE_INFINITY);
    owner.close();
    finish();
    finish();
    expect(info).toHaveBeenCalledTimes(1);
    const record = info.mock.calls[0]![1] as {
      operations: Record<string, { count: number; statements: number; bytes: number; absent: number }>;
    };
    const ops = record.operations;
    expect(ops["memo.hit"]?.count).toBe(1);
    expect(ops["memo.miss"]?.count).toBe(1);
    expect(ops["memo.fresh"]?.absent).toBe(1);
    expect(ops["memo.miss"]?.bytes).toBe(14);
    const d1 = Object.entries(ops).filter(([family]) => family.startsWith("d1."));
    expect(d1.reduce((n, [, op]) => n + op.count, 0)).toBe(count.roundTrips);
    expect(d1.reduce((n, [, op]) => n + op.statements, 0)).toBe(count.statements);
    const text = JSON.stringify(info.mock.calls);
    for (const secret of ["private-owner", "secret-key", "secret-payload", "missing-secret", "attacker-payload"])
      expect(text).not.toContain(secret);
    expect(traceFor(identity)).toBeUndefined();
    db.close();
  });
  it("does no logging when disabled or not sampled", () => {
    const info = vi.fn();
    const logger = { ...silentLogger, info };
    expect(startTimingTrace({}, 0, logger)).toBeUndefined();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.75);
    expect(startTimingTrace({}, 0.5, logger)).toBeUndefined();
    random.mockRestore();
    expect(info).not.toHaveBeenCalled();
  });
});
