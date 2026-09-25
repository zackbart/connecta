import { bearerToken } from "../src/auth/bearer.js";
import { fetchTestUiDetails } from "./helpers.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { describe, expect, it } from "vitest";
import { api } from "../src/connectors/api.js";
import { callerOf } from "../src/connector-caller.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, InboundAuth } from "../src/types.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";

const BASE = "https://connecta.test";
const ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

function users(): InboundAuth {
  return {
    kind: "test-users",
    interactiveOperator: true,
    activityActorNamespace: "https://identity.test",
    authorize(request) {
      const user = /^Bearer (alice|bob)$/u.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      return user
        ? { ok: true, userId: user, subjectId: user }
        : {
            ok: false,
            response: Response.json({ error: "unauthorized" }, { status: 401 }),
          };
    },
  };
}

function request(
  path: string,
  user: "alice" | "bob",
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${user}`);
  return new Request(`${BASE}${path}`, { ...init, headers });
}

function visible(id: string): Connector {
  return api(id, { description: id, tools: [] });
}

describe("identity-scoped connectors", () => {
  it.each(["subject", "principal"] as const)("isolates result pages for bearer %s identities without an activity namespace", async (identityKind) => {
    const auth: InboundAuth | InboundAuth[] = identityKind === "subject"
      ? [bearerToken("alice", { subjectId: "alice" }), bearerToken("bob", { subjectId: "bob" })]
      : {
          kind: "bearer",
          authorize(request) {
            const id = /^Bearer (alice|bob)$/.exec(request.headers.get("authorization") ?? "")?.[1];
            return id ? { ok: true, principal: { namespace: "directory", id } }
              : { ok: false, response: new Response(null, { status: 401 }) };
          },
        };
    const connecta = createTestConnecta({
      connectors: [api("docs", { tools: [{ name: "read", description: "Read docs", annotations: { readOnlyHint: true }, handler: () => "x".repeat(500) }] })],
      auth,
      calls: { maxResultBytes: 100 },
      logger: silentLogger,
    });
    const call = async (token: string, name: string, args: object) =>
      (await readJsonRpc(await mcpRpc(connecta, "tools/call", { name, arguments: args }, { token }))).result;
    const result = await call("alice", "call_tool", { address: "docs.read" });
    const { resultId } = JSON.parse(result.content[0].text.split("\n")[0]);
    expect(resultId).toBeTypeOf("string");
    expect((await call("alice", "get_result", { id: resultId })).isError).toBeFalsy();
    expect((await call("bob", "get_result", { id: resultId })).isError).toBe(true);
    await connecta.close();
  });

  it("allows a tool grantee's OAuth handoff but hides wholly ungranted connectors", async () => {
    let starts = 0;
    const docs = api("docs", { tools: [{ name: "read", description: "Read docs", annotations: { readOnlyHint: true }, handler: () => null }] });
    docs.startAuth = async () => { starts++; return { state: "auth_required", authorizationUrl: "https://oauth.test/authorize" }; };
    const connecta = createTestConnecta({
      connectors: [docs], auth: users(),
      identity: {
        connectorAccess: ({ subject }) => subject?.id === "alice" ? ["docs.read"] : [],
        credentialAdministration: () => "all",
      },
    });
    const call = async (token: string, connector: string) =>
      (await readJsonRpc(await mcpRpc(connecta, "tools/call", { name: "authorize_connector", arguments: { connector } }, { token }))).result;
    expect(JSON.parse((await call("alice", "docs")).content[0].text)).toMatchObject({ recovery: "oauth" });
    const hidden = await call("bob", "docs");
    const absent = await call("bob", "absent");
    expect(hidden.isError).toBe(true);
    expect(hidden.content[0].text).toBe(absent.content[0].text.replace("absent", "docs"));
    expect(starts).toBe(1);
    await connecta.close();
  });

  it("refuses static headers disguised as personal auth", () => {
    expect(() =>
      remoteMcp("bad", {
        url: "https://mcp.test",
        authScope: "personal",
        auth: { type: "headers", headers: { Authorization: "secret" } },
      })
    ).toThrow("cannot combine authScope \"personal\" with static headers");
  });

  it("derives connector visibility from the authenticated principal", async () => {
    const connecta = createTestConnecta({
      connectors: [visible("common"), visible("alice_only"), visible("bob_only")],
      auth: users(),
      identity: {
        connectorAccess(identity) {
          return identity.principal?.id === "alice"
            ? ["common", "alice_only"]
            : ["common", "bob_only"];
        },
      },
      storage: memoryStorage(),
      publicUrl: BASE,
    });

    const alice = await fetchTestUiDetails(connecta, request("/ui/data", "alice"));
    const bob = await fetchTestUiDetails(connecta, request("/ui/data", "bob"));
    expect(((await alice.json()) as any).connectors.map((item: Connector) => item.id))
      .toEqual(["common", "alice_only"]);
    expect(((await bob.json()) as any).connectors.map((item: Connector) => item.id))
      .toEqual(["common", "bob_only"]);

    const aliceResults = connecta.registry.scoped({
      connectorIds: "all",
      subjectKey: "alice-subject",
    }).resultsStorage();
    const bobResults = connecta.registry.scoped({
      connectorIds: "all",
      subjectKey: "bob-subject",
    }).resultsStorage();
    await aliceResults.set("result:id", "alice result");
    expect(await bobResults.get("result:id")).toBeNull();
  });

  it("isolates personal vault entries while visible shared auth stays editable", async () => {
    const personal = api("personal", {
      description: "Personal connection",
      authScope: "personal",
      credential: { label: "Personal token" },
      tools: [],
    });
    personal.status = async (ctx) => {
      const value = await ctx.credential?.get();
      return value
        ? { state: "ok", message: value.slice(-4) }
        : { state: "auth_required" };
    };
    const shared = api("shared", {
      description: "Shared connection",
      credential: { label: "Shared token" },
      tools: [],
    });
    const connecta = createTestConnecta({
      connectors: [personal, shared],
      auth: users(),
      identity: {
        activityAccess: (principal) => principal.id === "alice",
      },
      vault: encryptedCredentialVault(memoryStorage(), ENCRYPTION_KEY),
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const put = (connector: string, user: "alice" | "bob", value: string) =>
      connecta.fetch(
        request(`/ui/credentials/${connector}`, user, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Origin: BASE },
          body: JSON.stringify({ value }),
        }),
      );

    expect((await put("personal", "alice", "alice-secret-1111")).status).toBe(200);
    expect((await put("personal", "bob", "bob-secret-2222")).status).toBe(200);
    expect((await put("shared", "bob", "shared-secret-3333")).status).toBe(200);
    expect((await put("shared", "alice", "shared-secret-4444")).status).toBe(200);

    const alice = await fetchTestUiDetails(connecta, request("/ui/data", "alice"));
    const bob = await fetchTestUiDetails(connecta, request("/ui/data", "bob"));
    const aliceData = await alice.json() as any;
    const bobData = await bob.json() as any;
    expect(aliceData.connectors.find((item: any) => item.id === "personal")
      .credential.lastFour).toBe("1111");
    expect(bobData.connectors.find((item: any) => item.id === "personal")
      .credential.lastFour).toBe("2222");
    expect(bobData.connectors.find((item: any) => item.id === "shared")
      .credential.lastFour).toBe("4444");

    const retired = await connecta.fetch(request("/ui/access-tokens", "alice"));
    expect(retired.status).toBe(404);

  });

  it("returns a personal OAuth callback to the principal that started it", async () => {
    const oauth: Connector = {
      id: "oauth",
      description: "Personal OAuth connection",
      authScope: "personal",
      async listTools() {
        return [];
      },
      async callTool() {},
      async status(ctx) {
        return await ctx.storage.get("token")
          ? { state: "ok" }
          : { state: "auth_required" };
      },
      async startAuth(ctx) {
        const state = crypto.randomUUID();
        await ctx.storage.set("pending", state);
        return {
          state: "auth_required",
          authorizationUrl: `https://provider.test/authorize?state=${state}`,
        };
      },
      async disconnectAuth(ctx) {
        await ctx.storage.delete("token");
        await ctx.storage.delete("pending");
      },
      async verifyState(state, ctx) {
        return state !== null && state === await ctx.storage.get("pending");
      },
      async finishAuth(_code, ctx) {
        await ctx.storage.set("token", "connected");
        await ctx.storage.delete("pending");
      },
    };
    const connecta = createTestConnecta({
      connectors: [oauth],
      auth: users(),
      identity: { activityAccess: () => false },
      storage: memoryStorage(),
      publicUrl: BASE,
    });

    const started = await connecta.fetch(
      request("/ui/oauth/oauth", "alice", {
        method: "POST",
        headers: { Origin: BASE },
      }),
    );
    expect(started.status).toBe(200);
    const authorizationUrl = new URL((await started.json() as any).authorizationUrl);
    const state = authorizationUrl.searchParams.get("state");
    const fixedByAnotherUser = await connecta.fetch(
      request(`/oauth/callback/oauth?code=code&state=${state}`, "bob"),
    );
    expect(fixedByAnotherUser.status).toBe(400);
    const callback = await connecta.fetch(
      new Request(`${BASE}/oauth/callback/oauth?code=code&state=${state}`),
    );
    expect(callback.status).toBe(200);
    const replay = await connecta.fetch(
      new Request(`${BASE}/oauth/callback/oauth?code=code&state=${state}`),
    );
    expect(replay.status).toBe(400);

    const alice = await fetchTestUiDetails(connecta, request("/ui/data", "alice"));
    const bob = await fetchTestUiDetails(connecta, request("/ui/data", "bob"));
    expect(((await alice.json()) as any).connectors[0].status).toBe("ok");
    expect(((await bob.json()) as any).connectors[0].status).toBe("auth_required");
  });
});

describe("identity-scoped tools", () => {
  const BASE_TOOL = { annotations: { readOnlyHint: true }, handler: async () => ({ ok: true }) };
  function notes(onDelete: () => void): Connector {
    return api("notes", {
      description: "Notes",
      tools: [
        { name: "search", description: "Search notes", ...BASE_TOOL },
        { name: "fetch", description: "Fetch one note", ...BASE_TOOL },
        {
          name: "delete",
          description: "Delete a note",
          annotations: { readOnlyHint: false, destructiveHint: true },
          handler: async () => { onDelete(); return { deleted: true }; },
        },
      ],
    });
  }
  const wiki = () => api("wiki", {
    description: "Wiki",
    tools: [{ name: "read", description: "Read a page", ...BASE_TOOL }],
  });
  function deployment(
    access: (principalId: string | undefined) => "all" | readonly string[],
    executor?: Parameters<typeof createTestConnecta>[0]["executor"],
    logger?: Parameters<typeof createTestConnecta>[0]["logger"],
  ) {
    const deleted = { count: 0 };
    const connecta = createTestConnecta({
      connectors: [notes(() => { deleted.count += 1; }), wiki()],
      auth: users(),
      identity: { connectorAccess: ({ principal }) => access(principal?.id) },
      storage: memoryStorage(),
      publicUrl: BASE,
      ...(executor ? { executor } : {}),
      ...(logger ? { logger } : {}),
    });
    return { connecta, deleted };
  }
  const alice = (id: string | undefined) =>
    id === "alice" ? ["notes.search", "notes.fetch", "wiki"] : ["notes"];
  const rpc = (
    c: ReturnType<typeof createTestConnecta>,
    user: "alice" | "bob",
    name: string,
    args: unknown,
  ) => mcpRpc(c, "tools/call", { name, arguments: args }, { token: user })
    .then((response) => readJsonRpc(response) as Promise<any>);

  it("hides ungranted tools from discovery and shows granted ones", async () => {
    const { connecta } = deployment(alice);
    const seen = JSON.stringify(await rpc(connecta, "alice", "search_tools", { query: "notes", limit: 20 }));
    expect(seen).toContain("notes.search");
    expect(seen).toContain("notes.fetch");
    expect(seen).not.toContain("notes.delete");
    const bob = JSON.stringify(await rpc(connecta, "bob", "search_tools", { query: "delete", limit: 20 }));
    expect(bob).toContain("notes.delete");
    expect(bob).not.toContain("wiki.read");
  });

  it("refuses an ungranted tool exactly like a tool that never existed", async () => {
    const { connecta, deleted } = deployment(alice);
    const ungranted = await rpc(connecta, "alice", "call_destructive_tool", { address: "notes.delete", args: {} });
    const absent = await rpc(connecta, "alice", "call_destructive_tool", { address: "notes.purge", args: {} });
    const code = (body: any) => body.result.structuredContent?.error?.code
      ?? JSON.parse(body.result.content[0].text).error.code;
    expect(ungranted.result.isError).toBe(true);
    expect(code(ungranted)).toBe("unknown_tool");
    expect(code(absent)).toBe("unknown_tool");
    expect(deleted.count).toBe(0);
    const granted = await rpc(connecta, "bob", "call_destructive_tool", { address: "notes.delete", args: {} });
    expect(granted.result.isError).toBeFalsy();
    expect(deleted.count).toBe(1);
  });

  it("scopes a program's search and call through the same view", async () => {
    const outcomes: Record<string, unknown> = {};
    const executor = {
      async execute(_code: string, providers: Array<{ name: string; fns: Record<string, (...args: any[]) => Promise<unknown>> }>) {
        const fns = providers.find((provider) => provider.name === "connecta")!.fns;
        outcomes.search = await fns.search!({ query: "notes", limit: 20 });
        try {
          outcomes.call = await fns.call!("notes.delete", {});
        } catch (error) {
          outcomes.call = String(error);
        }
        return { result: null };
      },
    };
    const { connecta, deleted } = deployment(alice, executor);
    await rpc(connecta, "alice", "execute_code", { code: "return 1" });
    const searched = JSON.stringify(outcomes.search);
    expect(searched).toContain("notes.search");
    expect(searched).not.toContain("notes.delete");
    expect(JSON.stringify(outcomes.call)).toContain("unknown_tool");
    expect(deleted.count).toBe(0);
  });

  it("lists only granted tools on the connection UI", async () => {
    const { connecta } = deployment(alice);
    const data = (await (await fetchTestUiDetails(connecta, request("/ui/data", "alice"))).json()) as any;
    const names = data.connectors.find((item: { id: string }) => item.id === "notes").tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(["search", "fetch"]);
  });

  it("treats a whole-connector grant beside addresses as the whole connector", async () => {
    const { connecta } = deployment(() => ["notes.search", "notes"]);
    const seen = JSON.stringify(await rpc(connecta, "alice", "search_tools", { query: "delete", limit: 20 }));
    expect(seen).toContain("notes.delete");
  });

  it("fails closed on an unparseable grant", async () => {
    for (const bad of [["notes."], [".delete"], ["notes.delete", 7], ["Notes.delete"]]) {
      const { connecta } = deployment(() => bad as readonly string[]);
      const response = await mcpRpc(connecta, "tools/list", {}, { token: "alice" });
      expect(response.status).toBe(403);
    }
  });

  it("warns once for a granted address the catalog lacks and keeps it unreachable", async () => {
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (message: string) => { warnings.push(message); } };
    const { connecta } = deployment(() => ["notes.ghost", "notes.search"], undefined, logger);
    await rpc(connecta, "alice", "search_tools", { query: "notes", limit: 20 });
    await rpc(connecta, "alice", "search_tools", { query: "notes", limit: 20 });
    const ghost = await rpc(connecta, "alice", "call_tool", { address: "notes.ghost", args: {} });
    expect(ghost.result.isError).toBe(true);
    expect(warnings.filter((line) => line.includes("notes.ghost"))).toHaveLength(1);
  });
});

describe("named tool pools", () => {
  const readOnly = { annotations: { readOnlyHint: true }, handler: async () => ({ ok: true }) };
  const connectors = () => [
    api("notes", { description: "Notes", tools: [
      { name: "search", description: "Search team data", ...readOnly },
      { name: "fetch", description: "Fetch team data", ...readOnly },
      { name: "delete", description: "Delete team data", annotations: { readOnlyHint: false, destructiveHint: true }, handler: async () => ({}) },
    ] }),
    api("wiki", { description: "Wiki", tools: [{ name: "read", description: "Read team data", ...readOnly }] }),
    api("billing", { description: "Billing", tools: [{ name: "invoices", description: "Invoices team data", ...readOnly }] }),
  ];
  function deployment(pools: NonNullable<Parameters<typeof createTestConnecta>[0]["pools"]>, ceiling?: (id: string | undefined) => "all" | readonly string[]) {
    return createTestConnecta({
      connectors: connectors(),
      auth: users(),
      identity: { connectorAccess: ({ principal }) => ceiling?.(principal?.id) ?? "all" },
      pools,
      storage: memoryStorage(),
      publicUrl: BASE,
    });
  }
  const search = async (c: ReturnType<typeof createTestConnecta>, path: string, user: "alice" | "bob") => {
    const response = await c.fetch(new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${user}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_tools", arguments: { query: "team data", limit: 50 } } }),
    }));
    return { status: response.status, text: JSON.stringify(await readJsonRpc(response)) };
  };

  it("serves the pool's slice to a granted identity and leaves /mcp untouched", async () => {
    const c = deployment({
      support: { tools: ["notes.search", "notes.fetch", "wiki"], grant: ({ principal }) => principal?.id === "alice" },
    });
    const pooled = await search(c, "/mcp/support", "alice");
    expect(pooled.status).toBe(200);
    expect(pooled.text).toContain("notes.search");
    expect(pooled.text).toContain("wiki.read");
    expect(pooled.text).not.toContain("notes.delete");
    expect(pooled.text).not.toContain("billing.invoices");
    const full = await search(c, "/mcp", "alice");
    expect(full.text).toContain("notes.delete");
    expect(full.text).toContain("billing.invoices");
  });

  it("never widens the identity's own view", async () => {
    const c = deployment(
      { support: { tools: ["notes", "wiki", "billing"], grant: () => true } },
      (id) => (id === "alice" ? ["notes.search", "wiki"] : ["billing"]),
    );
    const alice = await search(c, "/mcp/support", "alice");
    expect(alice.text).toContain("notes.search");
    expect(alice.text).toContain("wiki.read");
    expect(alice.text).not.toContain("notes.fetch");
    expect(alice.text).not.toContain("billing.invoices");
    const bob = await search(c, "/mcp/support", "bob");
    expect(bob.text).toContain("billing.invoices");
    expect(bob.text).not.toContain("notes.search");
  });

  it("answers an undeclared pool, a refused grant, and a throwing grant identically", async () => {
    const c = deployment({
      closed: { tools: ["wiki"], grant: () => false },
      broken: { tools: ["wiki"], grant: () => { throw new Error("boom"); } },
      silent: { tools: ["wiki"] },
    });
    const bodies = new Set<string>();
    for (const name of ["missing", "closed", "broken", "silent"]) {
      const response = await c.fetch(new Request(`${BASE}/mcp/${name}`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer alice" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }));
      expect(response.status).toBe(404);
      bodies.add(`${response.status}:${[...response.headers].sort().map(([k, v]) => `${k}=${v}`).join("|")}:${await response.text()}`);
    }
    expect(bodies.size).toBe(1);
    const unauthenticated = await c.fetch(new Request(`${BASE}/mcp/closed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    expect(unauthenticated.status).toBe(401);
  });

  it("refuses a misdeclared pool at construction", () => {
    const attempt = (pools: Record<string, unknown>) => () => deployment(pools as any);
    expect(attempt({ "Bad Name": { tools: ["wiki"] } })).toThrow("must match");
    expect(attempt({ ghost: { tools: ["nope"] } })).toThrow('unknown connector "nope"');
    expect(attempt({ typo: { tools: ["notes.serach"] } })).toThrow('no tool "serach"');
    expect(attempt({ empty: { tools: [] } })).toThrow("at least one");
    expect(attempt({ shape: { tools: "wiki" } })).toThrow("must be an array");
    expect(attempt({ typo: { tools: ["wiki"], grants: () => true } })).toThrow('unknown option "grants"');
  });
});

describe("named tool pools: calls", () => {
  it("refuses a direct call outside the pool before any handler runs", async () => {
    const calls = { read: 0, purge: 0 };
    const c = createTestConnecta({
      connectors: [api("docs", { description: "Docs", tools: [
        { name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: async () => { calls.read += 1; return { ok: true }; } },
        { name: "purge", description: "Purge", annotations: { readOnlyHint: false, destructiveHint: true }, handler: async () => { calls.purge += 1; return { ok: true }; } },
      ] })],
      auth: users(),
      pools: { readers: { tools: ["docs.read"], grant: () => true } },
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const call = async (path: string, name: string, address: string) => {
      const response = await c.fetch(new Request(`${BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer alice" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { address, args: {} } } }),
      }));
      return readJsonRpc(response) as Promise<any>;
    };
    const purge = await call("/mcp/readers", "call_destructive_tool", "docs.purge");
    expect(purge.result.isError).toBe(true);
    expect(JSON.stringify(purge)).toContain("unknown_tool");
    const read = await call("/mcp/readers", "call_tool", "docs.read");
    expect(read.result.isError).toBeFalsy();
    const unpooled = await call("/mcp", "call_destructive_tool", "docs.purge");
    expect(unpooled.result.isError).toBeFalsy();
    expect(calls).toEqual({ read: 1, purge: 1 });
  });

  it("accepts a grant for a tool whose name has spaces or non-ASCII characters", async () => {
    const c = createTestConnecta({
      connectors: [api("intl", { description: "Intl", tools: [
        { name: "Liste des pages", description: "Lister", annotations: { readOnlyHint: true }, handler: async () => ({ ok: true }) },
        { name: "supprimer", description: "Supprimer", annotations: { readOnlyHint: true }, handler: async () => ({ ok: true }) },
      ] })],
      auth: users(),
      identity: { connectorAccess: () => ["intl.Liste des pages"] },
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const response = await c.fetch(new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer alice" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_tools", arguments: { query: "lister supprimer", limit: 20 } } }),
    }));
    expect(response.status).toBe(200);
    const text = JSON.stringify(await readJsonRpc(response));
    expect(text).toContain("Liste des pages");
    expect(text).not.toContain("intl.supprimer");
  });
});

describe("the caller a built-in connector sees", () => {
  // Core attaches the admitted identity beside the connector context, where
  // only in-repo code reads it; nothing a request sends can set it.
  function whoami(): Connector {
    return api("who", {
      description: "Reports the attached caller",
      tools: [
        {
          name: "me",
          description: "Return the caller core attached",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", additionalProperties: true },
          handler: (_args, ctx) => callerOf(ctx) ?? null,
        },
      ],
    });
  }

  it("comes from the authorization, on /mcp and on a pool, never from arguments", async () => {
    const connecta = createTestConnecta({
      connectors: [whoami()],
      auth: users(),
      pools: { team: { tools: ["who"], grant: () => true } },
      logger: silentLogger,
    });
    const me = async (path: string, user: "alice" | "bob") => {
      const response = await connecta.fetch(
        request(path, user, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "call_tool",
              arguments: {
                address: "who.me",
                args: { identity: { actor: { kind: "forged", id: "mallory" } }, caller: "mallory" },
              },
            },
          }),
        }),
      );
      const body = await readJsonRpc(response);
      return JSON.parse(body.result.content[0].text);
    };
    const direct = await me("/mcp", "alice");
    expect(direct).toEqual({
      identity: {
        actor: { kind: "test-users", id: "alice", namespace: "https://identity.test" },
        subject: { namespace: "https://identity.test", id: "alice" },
        principal: { namespace: "https://identity.test", id: "alice" },
        interactive: true,
      },
    });
    const pooled = await me("/mcp/team", "bob");
    expect(pooled).toMatchObject({ identity: { actor: { id: "bob" } }, pool: "team" });
    expect(JSON.stringify([direct, pooled])).not.toContain("mallory");
  });

  it("is absent from a context no request admitted", () => {
    const connecta = createTestConnecta({ connectors: [whoami()], logger: silentLogger });
    expect(callerOf(connecta.registry.contextFor("who", BASE))).toBeUndefined();
  });
});
