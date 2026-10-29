import { describe, expect, it } from "vitest";
import { accessTokens } from "../src/access-tokens.js";
import { api } from "../src/connectors/api.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { ConnectorCallError } from "../src/errors.js";
import { identityStorageKey } from "../src/identity.js";
import { createConnecta, customExecutor, type ConnectaConfig } from "../src/index.js";
import type { ToolCallActivityEvent } from "../src/activity.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, InboundAuth, ToolDef } from "../src/types.js";
import { readJsonRpc } from "./fixtures/http.js";
import { scriptedExecutor } from "./fixtures/misc.js";
import { createTestConnecta, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const NAMESPACE = "https://identity.test";
const ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

type User = "alice" | "bob" | "carol";

function users(): InboundAuth {
  return {
    kind: "test-users",
    interactiveOperator: true,
    uiAuth: { kind: "clerk", frontendApiUrl: NAMESPACE, publishableKey: "pk_test_fake" },
    activityActorNamespace: NAMESPACE,
    authorize(request) {
      const user = /^Bearer (alice|bob|carol)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
      return user
        ? { ok: true, userId: user, subjectId: user }
        : {
            ok: false,
            response: Response.json({ error: "unauthorized" }, { status: 401 }),
          };
    },
  };
}

function request(path: string, user: User | string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${user}`);
  return new Request(`${BASE}${path}`, { ...init, headers });
}

const rpc = async (
  c: { fetch: (request: Request) => Promise<Response> },
  path: string,
  user: string,
  name: string,
  args: unknown,
) =>
  readJsonRpc(
    await c.fetch(
      request(path, user, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
    ),
  ) as Promise<any>;

async function wire(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers].sort(),
    body: await response.text(),
  };
}

const READ = { annotations: { readOnlyHint: true }, handler: async () => ({ ok: true }) };

function teamConnectors(onDelete: () => void = () => {}): Connector[] {
  return [
    api("notes", {
      description: "Notes",
      tools: [
        { name: "search", description: "Search team data", ...READ },
        { name: "fetch", description: "Fetch team data", ...READ },
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
    api("billing", {
      description: "Billing",
      tools: [{ name: "invoices", description: "Invoices team data", ...READ }],
    }),
  ];
}

function deployment(options: Partial<Parameters<typeof createTestConnecta>[0]> = {}) {
  return createTestConnecta({
    connectors: teamConnectors(),
    auth: users(),
    maintainers: ["alice"],
    storage: memoryStorage(),
    publicUrl: BASE,
    logger: silentLogger,
    ...options,
  });
}

describe("maintainers and plain /mcp", () => {
  it("routes a person's single pool at /mcp, preserving maintainer precedence and private refusals", async () => {
    const warnings: unknown[][] = [];
    const events: ToolCallActivityEvent[] = [];
    const c = deployment({
      activity: (await import("../src/activity.js")).activityHistory({
        store: {
          record: async (event) => {
            events.push(event);
          },
        },
      }),
      pools: {
        team: {
          tools: ["notes.search"],
          members: [{ namespace: NAMESPACE, id: "bob" }, "alice"],
          readOnly: true,
          description: "Team tools",
        },
        other: { tools: ["wiki"], members: ["alice"] },
      },
      logger: {
        ...silentLogger,
        warn: (...args) => {
          warnings.push(args);
        },
      },
    });
    const send = async (path: string, user: string, method: string) =>
      readJsonRpc(
        await c.fetch(
          request(path, user, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method,
              params:
                method === "initialize"
                  ? { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } }
                  : {},
            }),
          }),
        ),
      );
    for (const method of ["tools/list", "initialize"])
      expect(await send("/mcp", "bob", method)).toEqual(await send("/mcp/team", "bob", method));
    expect(
      (await rpc(c, "/mcp", "bob", "call_destructive_tool", { address: "notes.delete", args: {} })).result.isError,
    ).toBe(true);
    // Activity records the routed pool exactly as the explicit path does.
    events.length = 0;
    for (const path of ["/mcp", "/mcp/team"])
      expect(
        (await rpc(c, path, "bob", "call_tool", { address: "notes.search", args: {} })).result.isError,
      ).toBeFalsy();
    expect(events.map((event) => event.pool)).toEqual(["team", "team"]);
    expect(
      (await rpc(c, "/mcp", "alice", "call_tool", { address: "billing.invoices", args: {} })).result.isError,
    ).toBeFalsy();
    expect(await wire(await c.fetch(request("/mcp", "carol")))).toEqual(
      await wire(await c.fetch(request("/mcp/missing", "carol"))),
    );
    expect(warnings.filter((args) => String(args[0]).includes("several pools"))).toEqual([]);
    const config = (await (await c.fetch(request("/ui/api/config", "bob"))).json()) as any;
    expect(config.pools[0]).toMatchObject({ name: "team", humanPath: "/mcp" });
    await c.close();
  });

  it("isolates equal person ids in different namespaces when resolving /mcp", async () => {
    const auth = ["east", "west"].map((namespace): InboundAuth => ({
      kind: namespace,
      recognizesCredential: (req) => req.headers.get("Authorization") === `Bearer ${namespace}`,
      interactiveOperator: true,
      activityActorNamespace: namespace,
      authorize: (req) =>
        req.headers.get("Authorization") === `Bearer ${namespace}`
          ? { ok: true, userId: "bob" }
          : { ok: false, response: new Response(null, { status: 401 }) },
    }));
    const c = deployment({
      auth,
      maintainers: [{ namespace: "east", id: "owner" }],
      pools: {
        east: { tools: ["wiki"], members: [{ namespace: "east", id: "bob" }] },
        west: { tools: ["billing"], members: [{ namespace: "west", id: "bob" }] },
      },
    });
    expect((await rpc(c, "/mcp", "east", "call_tool", { address: "wiki.read", args: {} })).result.isError).toBeFalsy();
    expect((await rpc(c, "/mcp", "east", "call_tool", { address: "billing.invoices", args: {} })).result.isError).toBe(
      true,
    );
    expect(
      (await rpc(c, "/mcp", "west", "call_tool", { address: "billing.invoices", args: {} })).result.isError,
    ).toBeFalsy();
    expect((await c.fetch(request("/mcp/east", "west"))).status).toBe(404);
    await c.close();
  });

  it("warns for ambiguous resolved people and refuses them identically to missing pools", async () => {
    const warnings: unknown[][] = [];
    const c = deployment({
      pools: {
        one: { tools: ["wiki"], members: ["bob"] },
        two: { tools: ["wiki"], members: [{ namespace: NAMESPACE, id: "bob" }] },
      },
      logger: {
        ...silentLogger,
        warn: (...args) => {
          warnings.push(args);
        },
      },
    });
    expect(warnings).toContainEqual([expect.any(String), { namespace: NAMESPACE, id: "bob", pools: ["one", "two"] }]);
    expect(c.describeConfig().peopleInSeveralPools).toEqual([
      { namespace: NAMESPACE, id: "bob", pools: ["one", "two"] },
    ]);
    expect(await wire(await c.fetch(request("/mcp", "bob")))).toEqual(
      await wire(await c.fetch(request("/mcp/missing", "bob"))),
    );
    // The same 404 a non-member gets; only the operator log tells them apart.
    expect(await wire(await c.fetch(request("/mcp", "carol")))).toEqual(
      await wire(await c.fetch(request("/mcp", "bob"))),
    );
    const reasons = warnings
      .flat()
      .flatMap((entry) => ((entry as { reason?: string })?.reason ? [(entry as { reason: string }).reason] : []));
    expect(reasons).toEqual(expect.arrayContaining(["ambiguous_pool", "not_maintainer"]));
    await c.close();
  });

  it("binds routed result handles to both pathname and pool across deployments", async () => {
    const storage = memoryStorage();
    let resultId = "";
    const build = (pool: string) =>
      deployment({
        storage,
        executor: scriptedExecutor(async (fns) => fns.result!(resultId, { maxBytes: 100 })),
        calls: { maxResultBytes: 100 },
        connectors: [
          api("docs", {
            tools: [{ name: "read", description: "Read docs", ...READ, handler: () => "x".repeat(1000) }],
          }),
        ],
        pools: { [pool]: { tools: ["docs"], members: ["bob"] } },
      });
    const c = build("team");
    const first = (await rpc(c, "/mcp", "bob", "call_tool", { address: "docs.read", args: {} })).result;
    const id = JSON.parse(first.content[0].text.split("\n")[0]).resultId;
    expect(id).toBeTypeOf("string");
    resultId = id;
    expect(
      (await rpc(c, "/mcp", "bob", "execute_code", { code: "return await connecta.result(id)" })).result.isError,
    ).toBeFalsy();
    expect(
      (await rpc(c, "/mcp/team", "bob", "execute_code", { code: "return await connecta.result(id)" })).result.isError,
    ).toBe(true);
    const named = (await rpc(c, "/mcp/team", "bob", "call_tool", { address: "docs.read", args: {} })).result;
    resultId = JSON.parse(named.content[0].text.split("\n")[0]).resultId;
    expect(
      (await rpc(c, "/mcp", "bob", "execute_code", { code: "return await connecta.result(id)" })).result.isError,
    ).toBe(true);
    resultId = id;
    await c.close();
    const moved = build("other");
    expect(
      (await rpc(moved, "/mcp", "bob", "execute_code", { code: "return await connecta.result(id)" })).result.isError,
    ).toBe(true);
    await moved.close();
  });

  it("INV-4: an open deployment keeps anonymous /mcp and answers every pool with the 404", async () => {
    const c = createTestConnecta({
      connectors: teamConnectors(),
      pools: { team: { tools: ["wiki"], members: [{ namespace: NAMESPACE, id: "alice" }] } },
      logger: silentLogger,
    });
    const anonymous = (path: string) =>
      c.fetch(
        new Request(`${BASE}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        }),
      );
    expect((await anonymous("/mcp")).status).toBe(200);
    const declared = await wire(await anonymous("/mcp/team"));
    expect(declared.status).toBe(404);
    expect(await wire(await anonymous("/mcp/missing"))).toEqual(declared);
    expect(c.describeConfig().maintainers).toEqual([]);
    await c.close();
  });

  it("INV-4: refuses non-maintainers on every maintainer route with the private 404, and serves a member only their own view", async () => {
    const storage = memoryStorage();
    const service: Connector = {
      id: "service",
      authScope: "personal",
      listTools: async () => [],
      callTool: async () => null,
      startAuth: async () => ({ state: "auth_required", authorizationUrl: "https://consent.example/authorize" }),
      finishAuth: async () => {},
      verifyState: async () => true,
      disconnectAuth: async () => {},
    };
    const vaulted = api("vaulted", { credential: { label: "Token" }, tools: [] });
    const c = createTestConnecta({
      connectors: [service, vaulted],
      auth: users(),
      maintainers: ["alice"],
      storage,
      agents: ["bot"],
      accessTokens: accessTokens(storage),
      vault: encryptedCredentialVault(storage, ENCRYPTION_KEY),
      publicUrl: BASE,
      logger: silentLogger,
      activity: (await import("../src/activity.js")).activityHistory({
        store: { record: async () => {}, list: async () => ({ events: [] }) },
      }),
      // Bob may open a pool holding both connectors; that is not an operator view.
      pools: { team: { tools: ["service", "vaulted"], members: ["bob"] } },
    });
    const routes: Array<[string, string, object?]> = [
      ["/ui/data", "GET"],
      ["/ui/connectors/service", "GET"],
      ["/ui/activity", "GET"],
      ["/ui/api/activity", "GET"],
      ["/ui/access-tokens", "GET"],
      ["/ui/access-tokens/bot", "POST"],
    ];
    const send = (user: User, [path, method, body]: [string, string, object?]) =>
      c.fetch(
        request(path, user, {
          method,
          headers: { Origin: BASE, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    for (const route of routes) {
      const refused = await send("bob", route);
      expect(refused.status, route.join(" ")).toBe(404);
      expect(await refused.json()).toEqual({ error: "not found" });
    }
    // The config contract is the one operator route a pool member reads: their own view (#837).
    const member = await send("bob", ["/ui/api/config", "GET"]);
    expect(member.status).toBe(200);
    expect(await member.json()).toMatchObject({ schemaVersion: 2, role: "member", config: null, agents: [] });
    const outsider = await send("carol", ["/ui/api/config", "GET"]);
    expect(outsider.status).toBe(404);
    expect(await outsider.json()).toEqual({ error: "not found" });
    for (const route of [
      ...routes.filter(([, method]) => method === "GET"),
      ["/ui/api/config", "GET"] as [string, string],
    ]) {
      const admitted = await send("alice", route);
      expect(admitted.status, route.join(" ")).toBe(200);
      await admitted.arrayBuffer();
    }
    // Bob's pool holds both connectors (#837): he manages his own account on
    // the personal one, and the shared credential stays a maintainer's.
    expect((await send("bob", ["/ui/oauth/service", "POST"])).status).toBe(200);
    expect((await send("bob", ["/ui/oauth/service", "DELETE"])).status).toBe(204);
    const shared = await send("bob", ["/ui/credentials/vaulted", "PUT", { value: "secret-value-1234" }]);
    expect(shared.status).toBe(403);
    expect(await shared.text()).not.toContain("secret-value-1234");
    expect((await storage.list("")).filter((key) => key.includes("credential:v1"))).toEqual([]);
    await c.close();
  });

  it("INV-4: paging rechecks admission, so a handle dies with the admission that minted it", async () => {
    let signedIn = true;
    let resultId = "";
    let revokeInProgram = false;
    const auth: InboundAuth = {
      ...users(),
      authorize(request) {
        const user = /^Bearer (alice|bob)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
        return user && (signedIn || user === "bob")
          ? { ok: true, userId: user, subjectId: user }
          : { ok: false, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
      },
    };
    const c = createTestConnecta({
      connectors: [
        api("docs", {
          tools: [
            {
              name: "read",
              description: "Read docs",
              annotations: { readOnlyHint: true },
              handler: () => "x".repeat(500),
            },
          ],
        }),
      ],
      auth,
      maintainers: ["alice"],
      pools: { team: { tools: ["docs"], members: ["alice"] } },
      storage: memoryStorage(),
      calls: { maxResultBytes: 100 },
      logger: silentLogger,
      executor: scriptedExecutor(async (fns) => {
        if (revokeInProgram) signedIn = false;
        return fns.result!(resultId, { maxBytes: 100 });
      }),
    });
    for (const path of ["/mcp", "/mcp/team"]) {
      signedIn = true;
      revokeInProgram = false;
      const first = (await rpc(c, path, "alice", "call_tool", { address: "docs.read" })).result;
      resultId = JSON.parse(first.content[0].text.split("\n")[0]).resultId;
      revokeInProgram = true;
      const paged = (await rpc(c, path, "alice", "execute_code", { code: "return await connecta.result(id)" })).result;
      expect(paged.isError, path).toBe(true);
    }
    await c.close();
  });
});

function personalOAuth(id = "oauth"): Connector {
  return {
    id,
    description: "Personal OAuth connection",
    authScope: "personal",
    async listTools() {
      return [];
    },
    async callTool() {},
    async status(ctx) {
      return (await ctx.storage.get("token")) ? { state: "ok" } : { state: "auth_required" };
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
      return state !== null && state === (await ctx.storage.get("pending"));
    },
    async finishAuth(_code, ctx) {
      await ctx.storage.set("token", "connected");
      await ctx.storage.delete("pending");
    },
  };
}

/** A shared OAuth connector whose one grant lives in deployment storage. */
function sharedOAuth(): Connector {
  return {
    ...personalOAuth("shared"),
    description: "Shared OAuth connection",
    authScope: "shared",
    async listTools() {
      return [{ name: "read", annotations: { readOnlyHint: true } }];
    },
    async callTool(_name, _args, ctx) {
      if (!(await ctx.storage.get("token"))) throw new ConnectorCallError("auth_required", "Sign in first.");
      return { ok: true };
    },
  };
}

describe("shared auth is maintainers' alone", () => {
  it("INV-4 INV-5: a member of a pool with a shared OAuth connector cannot issue, start, or complete its auth", async () => {
    const storage = memoryStorage();
    const starts = { count: 0 };
    const shared = sharedOAuth();
    const startAuth = shared.startAuth!.bind(shared);
    shared.startAuth = async (ctx, options) => {
      starts.count++;
      return startAuth(ctx, options);
    };
    const c = createTestConnecta({
      connectors: [shared, personalOAuth()],
      auth: users(),
      maintainers: ["alice"],
      // Membership alone must never reach shared auth; only maintainers administer it.
      pools: { team: { tools: ["shared.read", "oauth"], members: ["bob"] } },
      vault: encryptedCredentialVault(storage, ENCRYPTION_KEY),
      storage,
      publicUrl: BASE,
      logger: silentLogger,
    });
    const grant = async () =>
      (await c.registry.scoped({ connectorIds: ["shared"] }).statusFor("shared", BASE, {})).state;
    const text = (body: any) => JSON.stringify(body);

    // Issuance: an explicit authorize_connector, forced or not, and the
    // handoff a failed call carries both withhold a link from the member.
    for (const force of [false, true]) {
      const issued = await rpc(c, "/mcp/team", "bob", "authorize_connector", { connector: "shared", force });
      expect(text(issued)).not.toContain("/connect/");
      expect(JSON.parse(issued.result.content[0].text)).toMatchObject({ recovery: "unavailable" });
    }
    const failed = await rpc(c, "/mcp/team", "bob", "call_tool", { address: "shared.read", args: {} });
    expect(failed.result.isError).toBe(true);
    expect(text(failed)).not.toContain("/connect/");

    // A link a maintainer minted: the member can neither start nor complete it.
    const link = JSON.parse(
      (await rpc(c, "/mcp", "alice", "authorize_connector", { connector: "shared", force: true })).result.content[0]
        .text,
    ).authorizationUrl as string;
    const start = new URL(link);
    start.searchParams.set("start", "1");
    expect((await c.fetch(new Request(start, { headers: { Authorization: "Bearer bob" } }))).status).toBe(403);
    expect(starts.count).toBe(0);
    const consent = await c.fetch(new Request(start, { headers: { Authorization: "Bearer alice" } }));
    expect(consent.status).toBe(302);
    const state = new URL(consent.headers.get("Location")!).searchParams.get("state");
    const hijack = await c.fetch(request(`/oauth/callback/shared?code=code&state=${state}`, "bob"));
    expect(hijack.status).toBe(400);
    expect(await grant()).toBe("auth_required");

    // The maintainer still manages shared auth, and the member still connects their own personal connector.
    expect((await c.fetch(request(`/oauth/callback/shared?code=code&state=${state}`, "alice"))).status).toBe(200);
    expect(await grant()).toBe("ok");
    const own = JSON.parse(
      (await rpc(c, "/mcp/team", "bob", "authorize_connector", { connector: "oauth" })).result.content[0].text,
    );
    expect(own.authorizationUrl).toMatch(new RegExp(`^${BASE}/connect/oauth\\?h=`));
    const personal = await c.fetch(new Request(own.authorizationUrl, { headers: { Authorization: "Bearer bob" } }));
    expect(personal.status).toBe(302);
    expect(new URL(personal.headers.get("Location")!).origin).toBe("https://provider.test");
    await c.close();
  });
});

describe("pool members connect their own personal connectors", () => {
  it("INV-4 INV-5: a member connects a personal connector from their pool through /connect without the operator UI", async () => {
    const storage = memoryStorage();
    const c = createTestConnecta({
      connectors: [personalOAuth(), personalOAuth("elsewhere")],
      auth: users(),
      maintainers: ["alice"],
      pools: {
        mine: { tools: ["oauth"], members: ["bob"] },
        other: { tools: ["elsewhere"], members: ["carol"] },
      },
      vault: encryptedCredentialVault(storage, ENCRYPTION_KEY),
      storage,
      publicUrl: BASE,
      logger: silentLogger,
    });
    const handoff = async (user: User, pool: string, connector: string) =>
      JSON.parse((await rpc(c, `/mcp/${pool}`, user, "authorize_connector", { connector })).result.content[0].text);
    const link = await handoff("bob", "mine", "oauth");
    expect(link.authorizationUrl).toMatch(new RegExp(`^${BASE}/connect/oauth\\?h=`));
    // A connector outside the member's pools reads like one that never existed.
    const hidden = await rpc(c, "/mcp/mine", "bob", "authorize_connector", { connector: "elsewhere" });
    const absent = await rpc(c, "/mcp/mine", "bob", "authorize_connector", { connector: "absent" });
    expect(hidden.result.isError).toBe(true);
    expect(hidden.result.content[0].text).toBe(absent.result.content[0].text.replace("absent", "elsewhere"));
    // Another person cannot use bob's link.
    expect(
      (await c.fetch(request(new URL(link.authorizationUrl).pathname + new URL(link.authorizationUrl).search, "carol")))
        .status,
    ).toBe(403);
    // The operator UI serves maintainers only for now, so bob's link starts
    // the authorization directly.
    const consent = await c.fetch(new Request(link.authorizationUrl, { headers: { Authorization: "Bearer bob" } }));
    expect(consent.status).toBe(302);
    const location = new URL(consent.headers.get("Location")!);
    expect(location.origin).toBe("https://provider.test");
    const state = location.searchParams.get("state");
    const callback = await c.fetch(request(`/oauth/callback/oauth?code=code&state=${state}`, "bob"));
    expect(callback.status).toBe(200);
    // Connected in bob's own partition, and nobody else's.
    const status = async (id: string) =>
      (
        await c.registry
          .scoped({ connectorIds: ["oauth"], principalKey: await identityStorageKey({ namespace: NAMESPACE, id }) })
          .statusFor("oauth", BASE, {})
      ).state;
    expect(await status("bob")).toBe("ok");
    expect(await status("alice")).toBe("auth_required");
    await c.close();
  });
});

describe("pools serve exactly their tools", () => {
  it("keeps an exact pool grant across catalog drift, including a read-to-write change", async () => {
    let tools: ToolDef[] = [{ name: "read", annotations: { readOnlyHint: true } }];
    const calls: string[] = [];
    const notes: Connector = {
      id: "notes",
      kind: "api",
      description: "Notes — read and update records",
      async listTools() {
        return tools;
      },
      async callTool(name) {
        calls.push(name);
        return { ok: true };
      },
    };
    const c = deployment({ connectors: [notes], pools: { team: { tools: ["notes.read"], members: ["bob"] } } });
    const call = (name: string, address: string) => rpc(c, "/mcp/team", "bob", name, { address, args: {} });
    expect((await call("call_tool", "notes.read")).result.isError).toBeFalsy();
    tools = [
      { name: "read", annotations: { readOnlyHint: false, destructiveHint: true } },
      { name: "new_read", annotations: { readOnlyHint: true } },
    ];
    await c.registry.invalidateStored("notes");
    const discovered = JSON.stringify(
      await rpc(c, "/mcp/team", "bob", "search_tools", { connector: "notes", query: "", limit: 20 }),
    );
    expect(discovered).toContain("notes.read");
    expect(discovered).not.toContain("notes.new_read");
    expect((await call("call_tool", "notes.read")).result.isError).toBe(true);
    expect((await call("call_destructive_tool", "notes.read")).result.isError).toBeFalsy();
    expect(calls).toEqual(["read", "read"]);
    await c.close();
  });
});

describe("member references at construction", () => {
  const build = (config: Partial<ConnectaConfig>) => () =>
    createConnecta({
      connectors: teamConnectors(),
      readOnly: false,
      executor: customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }),
      logger: silentLogger,
      ...config,
    } as ConnectaConfig);

  it.each([
    [
      "identity.connectorAccess",
      { identity: { connectorAccess: () => "all" } },
      "Unknown Connecta configuration option:\n- ConnectaConfig.identity",
    ],
    ["the top-level grant", { grant: () => true }, "Unknown Connecta configuration option:\n- ConnectaConfig.grant"],
    [
      "a pool grant",
      { pools: { team: { tools: ["wiki"], members: ["bob"], grant: () => true } } },
      "Unknown Connecta configuration option:\n- ConnectaConfig.pools.team.grant",
    ],
  ])("INV-11: refuses the removed %s as an unknown option", (_name, config, message) => {
    const attempt = build({ auth: users(), maintainers: ["alice"], ...(config as Partial<ConnectaConfig>) });
    expect(attempt).toThrow(message);
  });
});
