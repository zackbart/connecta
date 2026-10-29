// Node-only: node:sqlite stands in for D1 so every round trip and statement is counted.
//
// The request read memo (src/runtime/request-reads.ts), then D1 query budgets for the request shapes that repeat most: a warm OAuth
// remoteMcp() call, a cold-isolate catalog load from D1, and an operator UI
// detail read. A round trip is one `all`, `run` or `batch` call; a statement is
// one SQL statement, so a batch of two is one round trip and two statements.
// Workers Free allows 50 D1 queries per invocation. The numbers are ceilings:
// lower is fine, higher is a regression to explain.
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WebStandardStreamableHTTPServerTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { d1Storage, type D1DatabaseBinding } from "../src/d1.js";
import { Effect } from "effect";
import { RequestReads, observeStorageWrites } from "../src/runtime/request-reads.js";
import { requestOwner, requestReads } from "../src/runtime/request-scope.js";
import { runEdge } from "../src/runtime/run.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { KVStorage } from "../src/types.js";
import { oauthGrantKeys, scopes } from "../src/storage/keys.js";
import { CLERK_OPTIONS, CREDENTIAL_KEY } from "./fixtures/ui.js";
import { fakeClerkAuth } from "./fixtures/http.js";
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
  const state = { token: "access-1", issued: 1, pageTwo: [] as (string | null)[] };
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
          expires_in: 3600,
          refresh_token: `refresh-${state.issued}`,
        });
      }
      if (request.headers.get("authorization") !== `Bearer ${state.token}`)
        return new Response("{}", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        });
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
async function callTool(app: { fetch(request: Request): Promise<Response> }, address: string) {
  const text = await callToolText(app, address);
  expect(text).toContain("hi");
  expect(text).not.toMatch(/"isError":true/);
}

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

describe("D1 query budgets", () => {
  it("a warm OAuth call and an expired-token refresh stay within their D1 budgets", async () => {
    installOwnedTransport();
    const origin = "https://oauth-budget.example";
    const remote = downstream(origin, { oauth: true });
    vi.stubGlobal("fetch", remote.fetch);
    const d1 = counted();
    const storage = d1.storage();
    await storage.set(
      `${scopes.connector("svc")}${oauthGrantKeys.grant}`,
      JSON.stringify({
        connectaOAuth: 3,
        epoch: "v3:seeded",
        body: {
          issuer: origin,
          client: { value: { client_id: "client-1", token_endpoint_auth_method: "none" }, registrationPath: "dcr" },
          tokens: { access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1", expires_in: 3600 },
        },
      }),
    );
    const app = createTestConnecta({
      connectors: [remoteMcp("svc", { url: `${origin}/mcp`, auth: { type: "oauth" } })],
      auth: machineAuth(TOKEN),
      storage,
      publicUrl: BASE,
    });
    await callTool(app, "svc.echo");
    d1.reset();
    await callTool(app, "svc.echo");
    const warm = { ...d1.count, log: [...d1.count.log] };
    report("warm OAuth call", warm, { grantReads: warm.log.filter((line) => line.includes(":oauth:grant")).length });
    // Fresh epoch gates (call start, disconnect admission, the post-connect
    // re-authorization check) and the catalog generation fence stay reads.
    expect(warm.roundTrips, warm.log.join("\n")).toBeLessThanOrEqual(WARM_OAUTH.roundTrips);
    expect(warm.statements, warm.log.join("\n")).toBeLessThanOrEqual(WARM_OAUTH.statements);

    remote.state.token = "rotated-elsewhere";
    d1.reset();
    await callTool(app, "svc.echo");
    const refresh = { ...d1.count, log: [...d1.count.log] };
    report("expired-token refresh", refresh);
    expect(remote.state.issued).toBe(2);
    expect(refresh.statements, refresh.log.join("\n")).toBeLessThanOrEqual(OAUTH_REFRESH.statements);
    expect(refresh.roundTrips, refresh.log.join("\n")).toBeLessThanOrEqual(OAUTH_REFRESH.roundTrips);
  });

  it("a cold isolate loads a stored catalog within its D1 budget", async () => {
    installOwnedTransport();
    const origin = "https://catalog-budget.example";
    vi.stubGlobal("fetch", downstream(origin).fetch);
    const d1 = counted();
    const storage = d1.storage();
    const build = () =>
      createTestConnecta({
        connectors: [
          remoteMcp("svc", { url: `${origin}/mcp`, auth: { type: "headers", headers: { Authorization: "Bearer k" } } }),
        ],
        auth: machineAuth(TOKEN),
        storage,
        publicUrl: BASE,
      });
    await callTool(build(), "svc.echo");
    d1.reset();
    await callTool(build(), "svc.echo");
    const cold = d1.count;
    report("cold catalog load", cold);
    expect(cold.roundTrips, cold.log.join("\n")).toBeLessThanOrEqual(COLD_CATALOG.roundTrips);
    expect(cold.statements, cold.log.join("\n")).toBeLessThanOrEqual(COLD_CATALOG.statements);
  });

  it("an operator UI detail read stays within its D1 budget", async () => {
    installOwnedTransport();
    const origin = "https://ui-budget.example";
    vi.stubGlobal("fetch", downstream(origin).fetch);
    const d1 = counted();
    const storage = d1.storage();
    const vault = encryptedCredentialVault(storage, CREDENTIAL_KEY);
    await vault.set("svc", "credential-secret-value", "operator");
    const app = createTestConnecta({
      connectors: [remoteMcp("svc", { url: `${origin}/mcp`, auth: { type: "credential" } })],
      auth: [machineAuth(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
      storage,
      vault,
      publicUrl: BASE,
    });
    const detail = () =>
      app.fetch(new Request(`${BASE}/ui/connectors/svc`, { headers: { Authorization: "Bearer clerk-token" } }));
    expect((await detail()).status).toBe(200);
    d1.reset();
    const response = await detail();
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("ok");
    const read = d1.count;
    const vaultReads = read.log.filter((line) => line.includes(":credential:")).length;
    report("UI detail read", read, { vaultReads });
    // Status, drift and the card share one memoized read; the probe's
    // credential read stays fresh.
    expect(vaultReads, read.log.join("\n")).toBeLessThanOrEqual(UI_DETAIL.vaultReads);
    expect(read.roundTrips, read.log.join("\n")).toBeLessThanOrEqual(UI_DETAIL.roundTrips);
    expect(read.statements, read.log.join("\n")).toBeLessThanOrEqual(UI_DETAIL.statements);
  });
});

// Measured ceilings; see the suite header. Before the request read memo
// (#1173 item 1.3) these were 21/21, 43/51, 8/8 and 12/12 with 5 vault reads.
const WARM_OAUTH = { roundTrips: 999, statements: 999 };
const OAUTH_REFRESH = { roundTrips: 999, statements: 999 };
const COLD_CATALOG = { roundTrips: 5, statements: 5 };
const UI_DETAIL = { vaultReads: 3, roundTrips: 8, statements: 8 };
