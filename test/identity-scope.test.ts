import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../src/config-schema.js";
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
    let deletes = 0;
    const c = deployment({
      connectors: teamConnectors(() => deletes++),
      activity: (await import("../src/activity.js")).activityHistory({
        store: {
          record: async (event) => {
            events.push(event);
          },
        },
      }),
      pools: {
        team: {
          tools: ["notes.search", "notes.delete"],
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
    // The pool grants the write; its readOnly refuses it before dispatch.
    const refused = (await rpc(c, "/mcp", "bob", "call_destructive_tool", { address: "notes.delete", args: {} }))
      .result;
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("read_only_endpoint");
    expect(deletes).toBe(0);
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

  it("INV-4: endpoint facts name only the admitted caller's connectors, on both handshakes and without side effects", async () => {
    const listed = vi.fn(async () => [{ name: "read", description: "Read", inputSchema: { type: "object" } }]);
    const remote = {
      ...api("crm", {
        title: "Customer records",
        usageGuide: { content: "Read this.", required: true },
        tools: [{ name: "read", description: "Read", ...READ }],
      }),
      listTools: listed,
    };
    const events: unknown[] = [];
    const c = deployment({
      connectors: [...teamConnectors(), remote],
      activity: (await import("../src/activity.js")).activityHistory({
        store: { record: async (event) => void events.push(event) },
      }),
      pools: {
        team: { tools: ["notes.search", "crm"], members: [{ namespace: NAMESPACE, id: "bob" }, "alice"] },
        other: { tools: ["billing"], members: ["alice"], surface: "native", executeCode: false, readOnly: true },
        solo: { tools: ["wiki"], members: [{ namespace: NAMESPACE, id: "carol" }], surface: "native" },
      },
    });
    const facts = async (path: string, user: string, method: "server/discover" | "initialize") => {
      const response = await c.fetch(
        request(path, user, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(method === "server/discover" ? { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params:
              method === "initialize"
                ? { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "billing", version: "1" } }
                : {
                    // Nothing the request says about itself can widen its view.
                    connectors: ["billing"],
                    _meta: {
                      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                      "io.modelcontextprotocol/clientCapabilities": {},
                      "dev.connecta/endpoint": { connectors: [{ id: "billing" }] },
                    },
                  },
          }),
        }),
      );
      if (response.status !== 200) return response.status;
      const { result } = (await readJsonRpc(response)) as any;
      return result.capabilities.extensions["dev.connecta/endpoint"];
    };
    const crm = { id: "crm", title: "Customer records", readFirst: "connector:crm" };
    const team = { surface: "meta", executeCode: true, readOnly: false, connectors: [{ id: "notes" }, crm] };
    for (const method of ["server/discover", "initialize"] as const) {
      // A person's plain /mcp is their one pool, never the deployment's roster.
      expect(await facts("/mcp", "bob", method)).toEqual(team);
      expect(await facts("/mcp/team", "bob", method)).toEqual(team);
      // Non-members learn nothing: the same refusal as a missing pool.
      expect(await facts("/mcp/other", "bob", method)).toBe(404);
      expect(await facts("/mcp/team", "carol", method)).toBe(404);
      // A person's plain /mcp serves their pool's surface, and the facts say so.
      expect(await facts("/mcp", "carol", method)).toEqual({
        surface: "native",
        executeCode: true,
        readOnly: false,
        connectors: [{ id: "wiki" }],
      });
      // A maintainer's plain /mcp is the whole catalog, in registry order.
      expect(await facts("/mcp", "alice", method)).toEqual({
        ...team,
        connectors: [{ id: "notes" }, { id: "wiki" }, { id: "billing" }, crm],
      });
      expect(await facts("/mcp/other", "alice", method)).toEqual({
        surface: "native",
        executeCode: false,
        readOnly: true,
        connectors: [{ id: "billing" }],
      });
    }
    // No new disclosure: the same caller's execute_code description names the same roster.
    const listing = (await readJsonRpc(
      await c.fetch(
        request("/mcp", "bob", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        }),
      ),
    )) as any;
    const description = listing.result.tools.find((tool: { name: string }) => tool.name === "execute_code").description;
    expect(description).toContain(
      'Connectors: notes, crm* (Customer records). *Read connecta.skill("connector:<id>") before its first call.',
    );
    expect(description).not.toContain("billing");
    expect(listed).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    await c.close();
  });

  it("INV-4: names in instructions only the connectors this caller was admitted to, from configuration alone", async () => {
    const c = deployment({
      pools: {
        team: { tools: ["notes.search", "wiki"], members: ["bob", "carol"] },
        finance: { tools: ["billing"], members: ["dave"] },
      },
      auth: {
        ...users(),
        authorize(request) {
          const user = /^Bearer (alice|bob|carol|dave)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
          return user
            ? { ok: true, userId: user, subjectId: user }
            : { ok: false, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
        },
      },
    });
    const send = async (path: string, user: string, method = "initialize", headers: HeadersInit = {}) => {
      const modern = method === "server/discover";
      const reply = (await readJsonRpc(
        await c.fetch(
          request(path, user, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...(modern ? { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method } : {}),
              ...headers,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method,
              params: modern
                ? {
                    _meta: {
                      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                      "io.modelcontextprotocol/clientCapabilities": {},
                    },
                  }
                : { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            }),
          }),
        ),
      )) as any;
      expect(reply.error, `${method} ${path} ${user}`).toBeUndefined();
      return reply.result.instructions as string;
    };
    const roster = (text: string) => /^Gateway to connected services: (.*?)\. /.exec(text)?.[1];
    // A maintainer sees the catalog; a person at plain /mcp sees only their pool.
    expect(roster(await send("/mcp", "alice"))).toBe("notes, wiki, billing");
    const bob = await send("/mcp", "bob");
    expect(roster(bob)).toBe("notes, wiki");
    expect(bob).not.toContain("billing");
    expect(roster(await send("/mcp", "dave"))).toBe("billing");
    // Same roster for every member, on either route, whatever the request carries.
    expect(await send("/mcp", "carol")).toBe(bob);
    expect(await send("/mcp/team", "bob")).toBe(bob);
    expect(await send("/mcp/team", "bob", "server/discover")).toBe(bob);
    expect(await send("/mcp", "bob", "initialize", { "X-Connector": "billing", "Mcp-Name": "billing" })).toBe(bob);
    // Instructions disclose nothing the execute_code inventory does not.
    const app = deployment({
      executor: scriptedExecutor(async () => null),
      pools: { team: { tools: ["notes.search", "wiki"], members: ["bob"] } },
    });
    const listed = (await readJsonRpc(
      await app.fetch(
        request("/mcp", "bob", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        }),
      ),
    )) as any;
    expect(listed.result.tools.find((tool: { name: string }) => tool.name === "execute_code").description).toMatch(
      /^Connectors: notes, wiki\.$/m,
    );
    await app.close();
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

describe("connector members narrow visibility (#1377)", () => {
  async function membersDeployment() {
    const storage = memoryStorage();
    const events: ToolCallActivityEvent[] = [];
    let reads = 0;
    let target = "journal";
    const journal = api("journal", {
      description: "Personal journal",
      members: ["bob"],
      usageGuide: { content: "Journal guide.", summary: "Load before reading the journal." },
      tools: [
        {
          name: "read",
          description: "Read journal entries",
          annotations: { readOnlyHint: true },
          handler: async () => {
            reads++;
            return { entries: 1 };
          },
        },
      ],
    });
    const c = createTestConnecta({
      connectors: [...teamConnectors(), journal, { ...personalOAuth("mailbox"), members: ["bob"] }],
      auth: users(),
      maintainers: ["alice"],
      storage,
      vault: encryptedCredentialVault(storage, ENCRYPTION_KEY),
      publicUrl: BASE,
      logger: silentLogger,
      activity: (await import("../src/activity.js")).activityHistory({
        store: {
          record: async (event) => void events.push(event as ToolCallActivityEvent),
          list: async () => ({ events: [...events] as any }),
        },
      }),
      executor: scriptedExecutor(async (fns) => {
        const outcome = async (work: Promise<unknown>) =>
          work.then(
            (value) => ({ value }),
            (error: Error) => ({ error: error.message }),
          );
        return {
          call: await outcome(fns.call!(`${target}.read`, {})),
          describe: await outcome(fns.describe!(`${target}.read`)),
        };
      }),
      pools: {
        team: { tools: ["notes.search", "journal", "mailbox"], members: ["bob", "carol"] },
        nat: { tools: ["journal", "wiki"], members: ["bob", "carol"], surface: "native" },
      },
    });
    return { c, events, reads: () => reads, setTarget: (id: string) => (target = id) };
  }

  /** Same text once the hidden connector's name is replaced by one that never existed. */
  const asUnknown = (hidden: unknown, absent: unknown, name: string) => {
    const timeless = (value: unknown) =>
      JSON.stringify(value).replace(/(\\?"durationMs\\?":)\d+/g, (_, key: string) => `${key}0`);
    expect(timeless(hidden).replaceAll(name, "ghost")).toBe(timeless(absent));
  };

  it("INV-4: a non-member meets an unknown connector on every MCP surface, maintainers at plain /mcp included", async () => {
    const { c, reads, setTarget } = await membersDeployment();
    for (const [path, user] of [
      ["/mcp/team", "carol"],
      ["/mcp", "alice"],
    ] as const) {
      // Endpoint facts, instructions, discovery and search name nothing of it.
      const initialized = await readJsonRpc(
        await c.fetch(
          request(path, user, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
            }),
          }),
        ),
      );
      expect(JSON.stringify(initialized)).toContain("notes");
      expect(JSON.stringify(initialized)).not.toMatch(/journal|mailbox/);
      const search = await rpc(c, path, user, "search_tools", { query: "read entries", limit: 20 });
      expect(JSON.stringify(search), `${path} ${user}`).not.toContain("journal");
      asUnknown(
        await rpc(c, path, user, "search_tools", { connector: "journal", query: "", limit: 20 }),
        await rpc(c, path, user, "search_tools", { connector: "ghost", query: "", limit: 20 }),
        "journal",
      );
      expect(JSON.stringify(await rpc(c, path, user, "skills", {}))).not.toContain("journal");
      // Direct calls, both tools, and authorization.
      for (const tool of ["call_tool", "call_destructive_tool"])
        asUnknown(
          await rpc(c, path, user, tool, { address: "journal.read", args: {} }),
          await rpc(c, path, user, tool, { address: "ghost.read", args: {} }),
          "journal",
        );
      for (const hidden of ["journal", "mailbox"])
        asUnknown(
          await rpc(c, path, user, "authorize_connector", { connector: hidden }),
          await rpc(c, path, user, "authorize_connector", { connector: "ghost" }),
          hidden,
        );
      // Programs, including a guessed address, through both program tools.
      for (const tool of ["execute_code", "execute_read_code"]) {
        setTarget("journal");
        const hidden = await rpc(c, path, user, tool, { code: "return 1" });
        setTarget("ghost");
        asUnknown(hidden, await rpc(c, path, user, tool, { code: "return 1" }), "journal");
      }
    }
    // A native pool lists none of its tools for a non-member.
    const native = async (user: string) =>
      readJsonRpc(
        await c.fetch(
          request("/mcp/nat", user, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
          }),
        ),
      ) as Promise<any>;
    const carolNative = JSON.stringify(await native("carol"));
    expect(carolNative).toContain("wiki");
    expect(carolNative).not.toContain("journal");
    expect(JSON.stringify(await native("bob"))).toContain("journal");
    expect(reads()).toBe(0);
    // The listed member reaches it on the same endpoints.
    expect(
      JSON.stringify(await rpc(c, "/mcp/team", "bob", "search_tools", { query: "read entries", limit: 20 })),
    ).toContain("journal.read");
    expect(
      (await rpc(c, "/mcp/team", "bob", "call_tool", { address: "journal.read", args: {} })).result.isError,
    ).toBeFalsy();
    setTarget("journal");
    expect(JSON.stringify(await rpc(c, "/mcp/team", "bob", "execute_read_code", { code: "return 1" }))).toContain(
      "entries",
    );
    expect(reads()).toBe(2);
    await c.close();
  });

  it("INV-4: the member page, management permissions, connect flows, and activity follow connector members", async () => {
    const { c } = await membersDeployment();
    const get = async (path: string, user: string) => c.fetch(request(path, user, { headers: { Origin: BASE } }));
    // A member page names neither the connectors nor their pool grants.
    const carol = await (await get("/ui/api/config", "carol")).text();
    expect(carol).toContain("notes");
    expect(carol).not.toMatch(/journal|mailbox/);
    expect(await (await get("/ui/api/config", "bob")).text()).toMatch(/journal[\s\S]*mailbox|mailbox[\s\S]*journal/);
    // Personal auth management: a non-member gets the unknown-connector refusal.
    const manage = (user: string, id: string) =>
      c.fetch(request(`/ui/oauth/${id}`, user, { method: "POST", headers: { Origin: BASE } }));
    const hidden = await manage("carol", "mailbox");
    const absent = await manage("carol", "ghost");
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).toBe(await absent.text());
    expect((await manage("bob", "mailbox")).status).toBe(200);
    // Maintainers keep the operator catalog and shared administration, but
    // not someone else's personal connection, and their own /mcp lacks both.
    expect((await manage("alice", "mailbox")).status).toBe(403);
    const data = (await (await get("/ui/data", "alice")).json()) as any;
    const permissions = (id: string) =>
      data.connectors.find((connector: { id: string }) => connector.id === id).permissions;
    expect(permissions("journal")).toEqual({ use: false, manageSharedAuth: true, connectPersonal: false });
    expect(permissions("mailbox")).toEqual({ use: false, manageSharedAuth: false, connectPersonal: false });
    expect(permissions("notes")).toMatchObject({ use: true });
    // The member's own connect link starts; nobody else can open a flow for it.
    const link = JSON.parse(
      (await rpc(c, "/mcp/team", "bob", "authorize_connector", { connector: "mailbox" })).result.content[0].text,
    ).authorizationUrl as string;
    expect((await c.fetch(new Request(link, { headers: { Authorization: "Bearer bob" } }))).status).toBe(302);
    // Activity is use: a maintainer the members omit reads none of it.
    expect(
      (await rpc(c, "/mcp/team", "bob", "call_tool", { address: "journal.read", args: {} })).result.isError,
    ).toBeFalsy();
    expect(
      (await rpc(c, "/mcp/team", "bob", "call_tool", { address: "notes.search", args: {} })).result.isError,
    ).toBeFalsy();
    const activity = (await (await get("/ui/activity", "alice")).json()) as any;
    const connectors = activity.events.map((event: { connectorId: string }) => event.connectorId);
    expect(connectors).toContain("notes");
    expect(connectors).not.toContain("journal");
    await c.close();
  });

  it("INV-11: describeConfig lists resolved connector members", async () => {
    const { c } = await membersDeployment();
    const described = c.describeConfig().connectors;
    expect(described.find((connector) => connector.id === "journal")?.members).toEqual([
      { kind: "human", namespace: NAMESPACE, id: "bob" },
    ]);
    expect(described.find((connector) => connector.id === "notes")).not.toHaveProperty("members");
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
      storage: memoryStorage(),
      accessTokens: accessTokens(memoryStorage()),
      ...config,
    } as ConnectaConfig);

  it.each([undefined, "alice@example.com"])("INV-11: refuses mixed pool membership with owner %s", (owner) => {
    for (const members of [
      ["bob", "agent:assistant"],
      ["agent:assistant", { namespace: NAMESPACE, id: "bob" }],
    ]) {
      const attempt = build({
        auth: users(),
        maintainers: ["alice"],
        agents: ["assistant"],
        pools: { personal: { tools: ["wiki"], members, ...(owner ? { owner } : {}) } },
      });
      expect(attempt).toThrow(ConfigError);
      expect(attempt).toThrow("ConnectaConfig.pools.personal.members mixes people and agents; list only one kind.");
    }
  });

  it("INV-11: accepts people-only and agent-only pools regardless of names, tools, and owner", async () => {
    const c = build({
      auth: users(),
      maintainers: ["alice"],
      agents: ["assistant", "other"],
      pools: {
        assistant: {
          tools: ["wiki"],
          members: ["bob", { namespace: NAMESPACE, id: "carol" }],
          owner: "alice@example.com",
        },
        team: { tools: ["wiki"], members: ["agent:assistant", "agent:other"] },
        personal: { tools: ["wiki"], members: ["agent:assistant"], owner: "alice@example.com" },
      },
    })();
    await c.close();
  });

  it.each([
    [[], "is empty"],
    ["bob", "must be an array"],
    [["agent:ghost"], 'names agent "ghost"'],
    [["bob", { namespace: NAMESPACE, id: "bob" }], "repeats an earlier member"],
    [["bob:1"], 'contains ":"'],
  ])("INV-11: refuses connector members %j (#1377)", (members, message) => {
    const attempt = build({
      auth: users(),
      maintainers: ["alice"],
      agents: ["assistant"],
      connectors: [...teamConnectors(), { ...teamConnectors()[1]!, id: "diary", members } as Connector],
    });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(`Connector("diary").members`);
    expect(attempt).toThrow(message);
  });

  it("INV-11: refuses an agent on a personal connector's members and a bare id with no interactive provider (#1377)", () => {
    expect(
      build({
        auth: users(),
        maintainers: ["alice"],
        agents: ["assistant"],
        connectors: [{ ...personalOAuth("mailbox"), members: ["bob", "agent:assistant"] }],
      }),
    ).toThrow('Connector("mailbox").members[1] is an agent; personal connectors never reach agents.');
    expect(
      build({
        agents: ["assistant"],
        connectors: [...teamConnectors(), { ...teamConnectors()[1]!, id: "diary", members: ["bob"] } as Connector],
      }),
    ).toThrow("resolves only when exactly one interactive auth provider is configured");
  });

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
