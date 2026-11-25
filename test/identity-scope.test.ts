import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../src/config-schema.js";
import { accessTokens } from "../src/access-tokens.js";
import { api } from "../src/connectors/api.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { ConnectorCallError } from "../src/errors.js";
import { identityStorageKey } from "../src/identity.js";
import { createConnecta, customExecutor, inlineSkills, type ConnectaConfig } from "../src/index.js";
import type { ToolCallActivityEvent } from "../src/activity.js";
import { memoryStorage } from "../src/storage/memory.js";
import { operatorUi } from "../src/ui.js";
import type { Connector, InboundAuth, ToolDef } from "../src/types.js";
import { readJsonRpc } from "./fixtures/http.js";
import { scriptedExecutor } from "./fixtures/misc.js";
import { createTestConnecta, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const NAMESPACE = "https://identity.test";
const ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

type User = "alice" | "bob" | "carol" | "dave" | "erin";

function users(): InboundAuth {
  return {
    kind: "test-users",
    interactiveOperator: true,
    uiAuth: { kind: "clerk", frontendApiUrl: NAMESPACE, publishableKey: "pk_test_fake" },
    activityActorNamespace: NAMESPACE,
    authorize(request) {
      const user = /^Bearer (alice|bob|carol|dave|erin)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
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
  it("serves a single-pool person exactly that pool at /mcp, preserving maintainer precedence and private refusals", async () => {
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
          members: [{ namespace: NAMESPACE, id: "bob" }],
          readOnly: true,
          description: "Team tools",
        },
      },
    });
    const initialized = (await readJsonRpc(
      await c.fetch(
        request("/mcp", "bob", {
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
    )) as any;
    expect(initialized.result.instructions).toContain("Team tools");
    expect(initialized.result.capabilities.extensions["dev.connecta/endpoint"]).toMatchObject({
      readOnly: true,
      connectors: [{ id: "notes" }],
    });
    const found = (await rpc(c, "/mcp", "bob", "search_tools", { connector: "notes", query: "", limit: 20 })).result
      .structuredContent.tools;
    expect(found.map((tool: { address: string; callable?: false }) => [tool.address, tool.callable])).toEqual([
      ["notes.search", undefined],
      ["notes.delete", false],
    ]);
    // The pool grants the write; its readOnly refuses it before dispatch.
    const refused = (await rpc(c, "/mcp", "bob", "call_destructive_tool", { address: "notes.delete", args: {} }))
      .result;
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("read_only_endpoint");
    expect(deletes).toBe(0);
    expect((await rpc(c, "/mcp", "bob", "call_tool", { address: "wiki.read", args: {} })).result.isError).toBe(true);
    events.length = 0;
    expect(
      (await rpc(c, "/mcp", "bob", "call_tool", { address: "notes.search", args: {} })).result.isError,
    ).toBeFalsy();
    expect(events.map((event) => event.pool)).toEqual(["team"]);
    expect(
      (await rpc(c, "/mcp", "alice", "call_tool", { address: "billing.invoices", args: {} })).result.isError,
    ).toBeFalsy();
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
        team: { tools: ["notes.search", "crm"], members: [{ namespace: NAMESPACE, id: "bob" }] },
        other: { tools: ["billing"], members: ["dave"], surface: "native", executeCode: false, readOnly: true },
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
    const team = {
      surface: "meta",
      executeCode: true,
      executeReadCode: true,
      readOnly: false,
      connectors: [{ id: "notes" }, crm],
    };
    for (const method of ["server/discover", "initialize"] as const) {
      // A person's plain /mcp is their one pool, never the deployment's roster.
      expect(await facts("/mcp", "bob", method)).toEqual(team);
      // A pool path is no endpoint, even for that pool's member.
      expect(await facts("/mcp/team", "bob", method)).toBe(404);
      // A person's plain /mcp serves their pool's surface, and the facts say so.
      expect(await facts("/mcp", "carol", method)).toEqual({
        surface: "native",
        executeCode: true,
        executeReadCode: false,
        readOnly: false,
        connectors: [{ id: "wiki" }],
      });
      // A maintainer's plain /mcp is the whole catalog, in registry order.
      expect(await facts("/mcp", "alice", method)).toEqual({
        ...team,
        connectors: [{ id: "notes" }, { id: "wiki" }, { id: "billing" }, crm],
      });
      expect(await facts("/mcp", "dave", method)).toEqual({
        surface: "native",
        executeCode: false,
        executeReadCode: false,
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
    // Same roster for every member, on either handshake, whatever the request carries.
    expect(await send("/mcp", "carol")).toBe(bob);
    expect(await send("/mcp", "bob", "server/discover")).toBe(bob);
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
    await c.close();
  });

  it("refuses a non-maintainer in no pool with the endpoint's own 404, logging only not_maintainer", async () => {
    const warnings: unknown[][] = [];
    const c = deployment({
      pools: { team: { tools: ["wiki"], members: ["bob"] } },
      logger: {
        ...silentLogger,
        warn: (...args) => {
          warnings.push(args);
        },
      },
    });
    const refused = await wire(await c.fetch(request("/mcp", "carol")));
    expect(refused.status).toBe(404);
    expect(refused.body).toContain("MCP endpoint not found.");
    expect(await wire(await c.fetch(request("/mcp/missing", "carol")))).toEqual(refused);
    const reasons = warnings
      .flat()
      .flatMap((entry) => ((entry as { reason?: string })?.reason ? [(entry as { reason: string }).reason] : []));
    expect(reasons).toEqual(["not_maintainer"]);
    await c.close();
  });

  it("binds a person's result handles to their pool across deployments", async () => {
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
    await c.close();
    const moved = build("other");
    expect(
      (await rpc(moved, "/mcp", "bob", "execute_code", { code: "return await connecta.result(id)" })).result.isError,
    ).toBe(true);
    await moved.close();
  });

  it("INV-4: an open deployment keeps anonymous /mcp and answers every pool path with the 404", async () => {
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
        return user && signedIn
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
      pools: { team: { tools: ["docs"], members: ["bob"] } },
      storage: memoryStorage(),
      calls: { maxResultBytes: 100 },
      logger: silentLogger,
      executor: scriptedExecutor(async (fns) => {
        if (revokeInProgram) signedIn = false;
        return fns.result!(resultId, { maxBytes: 100 });
      }),
    });
    for (const user of ["alice", "bob"]) {
      signedIn = true;
      revokeInProgram = false;
      const first = (await rpc(c, "/mcp", user, "call_tool", { address: "docs.read" })).result;
      resultId = JSON.parse(first.content[0].text.split("\n")[0]).resultId;
      revokeInProgram = true;
      const paged = (await rpc(c, "/mcp", user, "execute_code", { code: "return await connecta.result(id)" })).result;
      expect(paged.isError, user).toBe(true);
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
      const issued = await rpc(c, "/mcp", "bob", "authorize_connector", { connector: "shared", force });
      expect(text(issued)).not.toContain("/connect/");
      expect(JSON.parse(issued.result.content[0].text)).toMatchObject({ recovery: "unavailable" });
    }
    const failed = await rpc(c, "/mcp", "bob", "call_tool", { address: "shared.read", args: {} });
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
      (await rpc(c, "/mcp", "bob", "authorize_connector", { connector: "oauth" })).result.content[0].text,
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
    const handoff = async (user: User, connector: string) =>
      JSON.parse((await rpc(c, "/mcp", user, "authorize_connector", { connector })).result.content[0].text);
    const link = await handoff("bob", "oauth");
    expect(link.authorizationUrl).toMatch(new RegExp(`^${BASE}/connect/oauth\\?h=`));
    // A connector outside the member's pools reads like one that never existed.
    const hidden = await rpc(c, "/mcp", "bob", "authorize_connector", { connector: "elsewhere" });
    const absent = await rpc(c, "/mcp", "bob", "authorize_connector", { connector: "absent" });
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
      members: ["bob", "dave"],
      callAdmission: { rules: [{ maxConcurrency: 4 }] },
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
        nat: { tools: ["journal", "wiki"], members: ["dave", "erin"], surface: "native" },
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
    for (const user of ["carol", "alice"]) {
      // Endpoint facts, instructions, discovery and search name nothing of it.
      const initialized = await readJsonRpc(
        await c.fetch(
          request("/mcp", user, {
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
      const search = await rpc(c, "/mcp", user, "search_tools", { query: "read entries", limit: 20 });
      expect(JSON.stringify(search), user).not.toContain("journal");
      asUnknown(
        await rpc(c, "/mcp", user, "search_tools", { connector: "journal", query: "", limit: 20 }),
        await rpc(c, "/mcp", user, "search_tools", { connector: "ghost", query: "", limit: 20 }),
        "journal",
      );
      expect(JSON.stringify(await rpc(c, "/mcp", user, "skills", {}))).not.toContain("journal");
      // Direct calls, both tools, and authorization.
      for (const tool of ["call_tool", "call_destructive_tool"])
        asUnknown(
          await rpc(c, "/mcp", user, tool, { address: "journal.read", args: {} }),
          await rpc(c, "/mcp", user, tool, { address: "ghost.read", args: {} }),
          "journal",
        );
      for (const hidden of ["journal", "mailbox"])
        asUnknown(
          await rpc(c, "/mcp", user, "authorize_connector", { connector: hidden }),
          await rpc(c, "/mcp", user, "authorize_connector", { connector: "ghost" }),
          hidden,
        );
      // Programs, including a guessed address, through both program tools.
      for (const tool of ["execute_code", "execute_read_code"]) {
        setTarget("journal");
        const hidden = await rpc(c, "/mcp", user, tool, { code: "return 1" });
        setTarget("ghost");
        asUnknown(hidden, await rpc(c, "/mcp", user, tool, { code: "return 1" }), "journal");
      }
    }
    // A native pool lists none of its tools for a non-member.
    const native = async (user: string) =>
      readJsonRpc(
        await c.fetch(
          request("/mcp", user, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
          }),
        ),
      ) as Promise<any>;
    const outsider = JSON.stringify(await native("erin"));
    expect(outsider).toContain("wiki");
    expect(outsider).not.toContain("journal");
    expect(JSON.stringify(await native("dave"))).toContain("journal");
    expect(reads()).toBe(0);
    // The listed member reaches it on the same endpoints.
    expect(JSON.stringify(await rpc(c, "/mcp", "bob", "search_tools", { query: "read entries", limit: 20 }))).toContain(
      "journal.read",
    );
    expect(
      (await rpc(c, "/mcp", "bob", "call_tool", { address: "journal.read", args: {} })).result.isError,
    ).toBeFalsy();
    setTarget("journal");
    expect(JSON.stringify(await rpc(c, "/mcp", "bob", "execute_read_code", { code: "return 1" }))).toContain("entries");
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
      (await rpc(c, "/mcp", "bob", "authorize_connector", { connector: "mailbox" })).result.content[0].text,
    ).authorizationUrl as string;
    expect((await c.fetch(new Request(link, { headers: { Authorization: "Bearer bob" } }))).status).toBe(302);
    // Public health neither counts the restricted connectors nor moves when a member uses one.
    const health = async () => (await (await c.fetch(new Request(`${BASE}/health`))).json()) as any;
    const before = await health();
    expect(before.connectors).toBe(3);
    // Activity is use: a maintainer the members omit reads none of it.
    expect(
      (await rpc(c, "/mcp", "bob", "call_tool", { address: "journal.read", args: {} })).result.isError,
    ).toBeFalsy();
    expect(
      (await rpc(c, "/mcp", "bob", "call_tool", { address: "notes.search", args: {} })).result.isError,
    ).toBeFalsy();
    expect((await health()).admission.downstreamCalls).toEqual(before.admission.downstreamCalls);
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
      { kind: "human", namespace: NAMESPACE, id: "dave" },
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
    const call = (name: string, address: string) => rpc(c, "/mcp", "bob", name, { address, args: {} });
    expect((await call("call_tool", "notes.read")).result.isError).toBeFalsy();
    tools = [
      { name: "read", annotations: { readOnlyHint: false, destructiveHint: true } },
      { name: "new_read", annotations: { readOnlyHint: true } },
    ];
    await c.registry.invalidateStored("notes");
    const discovered = JSON.stringify(
      await rpc(c, "/mcp", "bob", "search_tools", { connector: "notes", query: "", limit: 20 }),
    );
    expect(discovered).toContain("notes.read");
    expect(discovered).not.toContain("notes.new_read");
    expect((await call("call_tool", "notes.read")).result.isError).toBe(true);
    expect((await call("call_destructive_tool", "notes.read")).result.isError).toBeFalsy();
    expect(calls).toEqual(["read", "read"]);
    await c.close();
  });

  it("INV-2: a read-only pool serves exactly its granted writes and refuses every other, a later vendor write included (#1409)", async () => {
    let tools: ToolDef[] = [
      { name: "find", annotations: { readOnlyHint: true } },
      { name: "save", annotations: { readOnlyHint: false } },
      { name: "drop", annotations: { readOnlyHint: false, destructiveHint: true } },
    ];
    const calls: string[] = [];
    const crm: Connector = {
      id: "crm",
      kind: "api",
      description: "Customer records",
      async listTools() {
        return tools;
      },
      async callTool(name) {
        calls.push(name);
        return { ok: name };
      },
    };
    let program: (fns: Record<string, (...args: unknown[]) => Promise<unknown>>) => Promise<unknown> = async () => null;
    const c = deployment({
      connectors: [...teamConnectors(), crm],
      executor: scriptedExecutor((fns) => program(fns)),
      pools: {
        team: { tools: ["crm", "wiki"], readOnly: true, writes: ["crm.save"], unlisted: ["wiki"], members: ["bob"] },
        native: { tools: ["crm"], readOnly: true, writes: ["crm.save"], surface: "native", members: ["carol"] },
      },
    });
    const call = (user: User, name: string, address: string) =>
      rpc(c, "/mcp", user, name, {
        address,
        args: {},
        ...(name === "call_destructive_tool" ? { reason: "test" } : {}),
      });
    const code = (outcome: any) => JSON.stringify(outcome).match(/"code":"([a-z_]+)"/u)?.[1];
    const search = async (user: User) =>
      (
        (await rpc(c, "/mcp", user, "search_tools", { connector: "crm", query: "", limit: 20 })) as any
      ).result.structuredContent.tools.map((tool: { address: string; callable?: false }) => [
        tool.address,
        tool.callable,
      ]);
    const list = async (user: User) =>
      (
        (await readJsonRpc(
          await c.fetch(
            request("/mcp", user, {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
            }),
          ),
        )) as any
      ).result.tools as Array<{ name: string; annotations?: { destructiveHint?: boolean } }>;

    const meta = await list("bob");
    expect(meta.map((tool) => tool.name)).toContain("call_destructive_tool");
    expect(meta.find((tool) => tool.name === "execute_code")?.annotations?.destructiveHint).toBe(true);
    expect(await search("bob")).toEqual([
      ["crm.find", undefined],
      ["crm.save", undefined],
      ["crm.drop", false],
    ]);
    expect((await call("bob", "call_destructive_tool", "crm.save")).result.isError).toBeFalsy();
    expect(code(await call("bob", "call_destructive_tool", "crm.drop"))).toBe("read_only_endpoint");
    expect(code(await call("bob", "call_tool", "crm.save"))).toBe("destructive_tool_requires_approval");
    expect(calls).toEqual(["save"]);

    const described = (address: string, fns: Record<string, (...args: unknown[]) => Promise<unknown>>) =>
      fns.describe!({ address }).then((value: any) =>
        value.tools[0].error ? "absent" : value.tools[0].callable === false ? "not callable" : "shown",
      );
    const refusal = (error: unknown) =>
      String(error).includes("this endpoint is read-only") ? "refused" : String(error);
    program = async (fns) => ({
      described: await described("crm.save", fns),
      refused: await described("crm.drop", fns),
      saved: await fns.call!("crm.save", {}).then(() => "sent", refusal),
      dropped: await fns.call!("crm.drop", {}).then(() => "sent", refusal),
    });
    const ran = (await rpc(c, "/mcp", "bob", "execute_code", { code: "async () => null" })).result;
    expect(ran.structuredContent.result).toEqual({
      described: "shown",
      refused: "not callable",
      saved: "sent",
      dropped: "refused",
    });
    expect(calls).toEqual(["save", "save"]);

    const nativeNames = (await list("carol")).map((tool) => tool.name);
    const nativeSave = nativeNames.find((name) => name.startsWith("crm__") && name.endsWith("save"));
    expect(nativeSave).toBeDefined();
    expect(nativeNames.some((name) => name.endsWith("drop"))).toBe(false);
    expect((await rpc(c, "/mcp", "carol", nativeSave!, {})).result.isError).toBeFalsy();
    expect(calls).toEqual(["save", "save", "save"]);
    program = async (fns) =>
      ((await fns.search!({ query: "" })) as any).tools.map(
        (tool: { address: string; callable?: false }) => `${tool.address}${tool.callable === false ? " refused" : ""}`,
      );
    const nativeSearch = (await rpc(c, "/mcp", "carol", "execute_code", { code: "async () => null" })).result;
    expect(nativeSearch.structuredContent.result).toEqual(["crm.find", "crm.save", "crm.drop refused"]);

    tools = [...tools, { name: "purge", annotations: { readOnlyHint: false, destructiveHint: true } }];
    await c.registry.invalidateStored("crm");
    expect(await search("bob")).toContainEqual(["crm.purge", false]);
    expect(code(await call("bob", "call_destructive_tool", "crm.purge"))).toBe("read_only_endpoint");
    expect((await list("carol")).some((tool) => tool.name.endsWith("purge"))).toBe(false);
    expect(calls).toEqual(["save", "save", "save"]);

    const facts = (await readJsonRpc(
      await c.fetch(
        request("/mcp", "bob", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } },
          }),
        }),
      ),
    )) as any;
    expect(facts.result.capabilities.extensions["dev.connecta/endpoint"]).toEqual({
      surface: "meta",
      executeCode: true,
      executeReadCode: true,
      readOnly: false,
      connectors: [{ id: "wiki", unlisted: true }, { id: "crm" }],
    });
    expect((await call("bob", "call_tool", "wiki.read")).result.isError).toBeFalsy();
    expect(c.describeConfig().pools.find((pool) => pool.name === "team")).toMatchObject({
      readOnly: true,
      writes: ["crm.save"],
      unlisted: ["wiki"],
    });
    await c.close();
  });

  it("INV-11: refuses write grants that name a whole connector, a missing tool, or a writable pool, and unlisted ids outside the pool (#1409)", () => {
    const pool = (fields: Record<string, unknown>) => () =>
      deployment({ pools: { team: { tools: ["wiki"], readOnly: true, members: ["bob"], ...fields } } });
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ writes: ["notes"] }, 'ConnectaConfig.pools.team.writes[0] names the whole connector "notes"'],
      [{ writes: ["notes.nope"] }, 'ConnectaConfig.pools.team.writes: connector "notes" has no tool "nope".'],
      [{ writes: ["ghost.save"] }, 'ConnectaConfig.pools.team.writes: unknown connector "ghost".'],
      [{ writes: ["notes.delete"], readOnly: false }, "ConnectaConfig.pools.team.writes needs readOnly: true."],
      [{ writes: [] }, "ConnectaConfig.pools.team.writes is empty; omit it instead."],
      [{ writes: "notes.delete" }, "ConnectaConfig.pools.team.writes must be an array"],
      [
        { unlisted: ["billing"] },
        "ConnectaConfig.pools.team.unlisted[0] must be a connector id this pool's tools or writes reach.",
      ],
      [{ unlisted: ["wiki", "wiki"] }, 'ConnectaConfig.pools.team.unlisted[1] repeats "wiki".'],
    ];
    for (const [fields, message] of refusals) {
      expect(pool(fields)).toThrow(ConfigError);
      expect(pool(fields)).toThrow(message);
    }
    const inherited = deployment({
      readOnly: true,
      pools: { team: { tools: [], writes: ["notes.delete", "notes.search"], unlisted: ["notes"], members: ["bob"] } },
    });
    expect(inherited.describeConfig().pools[0]).toMatchObject({
      readOnly: true,
      writes: ["notes.delete", "notes.search"],
    });
  });
});

describe("skill sources at construction", () => {
  const holes = (length: number, last?: unknown) => {
    const array: unknown[] = [];
    array.length = length;
    if (last !== undefined) array[length - 1] = last;
    return array;
  };
  const skill = (name: string, document = `---\nname: ${name}\ndescription: Do ${name}.\n---\n\nSteps.\n`) => ({
    [name]: { "SKILL.md": document },
  });

  it("INV-11: refuses pool skills that are not an array, empty, repeated or unknown, naming the pool", () => {
    const pool = (skills: unknown) => () =>
      deployment({
        skills: [inlineSkills("team", skill("review"))],
        pools: { support: { tools: ["wiki"], members: ["bob"], skills: skills as string[] } },
      });
    const refusals: Array<[unknown, string]> = [
      ["team", "ConnectaConfig.pools.support.skills must be an array of skill source ids."],
      [[], "ConnectaConfig.pools.support.skills is empty; omit it instead."],
      [["team", "team"], 'ConnectaConfig.pools.support.skills[1] repeats "team".'],
      [["ops"], "ConnectaConfig.pools.support.skills[0] must be the id of a source in ConnectaConfig.skills."],
      [["team:review"], "ConnectaConfig.pools.support.skills[0] must be the id of a source in ConnectaConfig.skills."],
      [holes(2), "ConnectaConfig.pools.support.skills[0] must be the id of a source in ConnectaConfig.skills."],
      [holes(2, "team"), "ConnectaConfig.pools.support.skills[0] must be the id of a source in ConnectaConfig.skills."],
    ];
    for (const [skills, message] of refusals) {
      expect(pool(skills)).toThrow(ConfigError);
      expect(pool(skills)).toThrow(message);
    }
    expect(pool(["team"])).not.toThrow();
  });

  it("INV-4: pages a retained source skill only while the pool still sees its source", async () => {
    const storage = memoryStorage();
    const body = "Step. ".repeat(20_000);
    const handbook = inlineSkills("team", {
      handbook: {
        "SKILL.md": `---\nname: handbook\ndescription: The team handbook.\n---\n\n${body}`,
        "references/long.md": body,
      },
    });
    let read: "skill" | "file" | "page" = "skill";
    let resultId = "";
    const build = (skills: string[] | undefined) =>
      deployment({
        storage,
        skills: [handbook],
        pools: { team: { tools: ["wiki"], members: ["bob"], ...(skills ? { skills } : {}) } },
        executor: scriptedExecutor(async (fns) =>
          read === "page"
            ? fns.result!(resultId, { maxBytes: 200 })
            : read === "file"
              ? fns.skill!("team:handbook", { file: "references/long.md" })
              : fns.skill!("team:handbook"),
        ),
      });
    for (const kind of ["skill", "file"] as const) {
      const granted = build(["team"]);
      read = kind;
      const first = (await rpc(granted, "/mcp", "bob", "execute_code", { code: "async () => null" })).result;
      resultId = first.structuredContent.result.resultId;
      expect(resultId, kind).toEqual(expect.any(String));
      read = "page";
      const kept = (await rpc(granted, "/mcp", "bob", "execute_code", { code: "async () => null" })).result;
      expect(kept.structuredContent.result.text, kind).toContain("Step.");
      await granted.close();
      const revoked = build(undefined);
      const refused = (await rpc(revoked, "/mcp", "bob", "execute_code", { code: "async () => null" })).result;
      expect(refused.structuredContent.error, kind).toMatchObject({ code: "not_found" });
      expect(JSON.stringify(refused), kind).not.toContain("Step.");
      await revoked.close();
    }
  });

  it("INV-11: refuses invalid source ids, descriptions and skills when the source is built", () => {
    const refusals: Array<[() => unknown, string]> = [
      [() => inlineSkills("Team", skill("review")), "id must be lowercase"],
      [() => inlineSkills("a".repeat(65), skill("review")), "at most 64 characters"],
      [() => inlineSkills("connector", skill("review")), 'id "connector" is reserved'],
      [() => inlineSkills("connecta", skill("review")), 'id "connecta" is reserved'],
      [() => inlineSkills("downstream", skill("review")), 'id "downstream" is reserved'],
      [() => inlineSkills("team", skill("review"), { description: "  " }), "description must be one line"],
      [() => inlineSkills("team", skill("review"), { description: "a\nb" }), "description must be one line"],
      [() => inlineSkills("team", skill("review"), { description: "x".repeat(121) }), "description must be one line"],
      [() => inlineSkills("team", { Review: { "SKILL.md": "x" } }), "Agent Skills name rule"],
      [() => inlineSkills("team", { review: { "notes.md": "x" } }), "has no SKILL.md"],
      [() => inlineSkills("team", skill("review", "# no frontmatter\n")), "no supported YAML frontmatter"],
      [
        () => inlineSkills("team", skill("review", "---\nname: other\ndescription: x\n---\n")),
        "differs from the directory",
      ],
      [() => inlineSkills("team", skill("review", "---\nname: review\n---\n")), "description must be"],
      [() => inlineSkills("team", { review: { ...skill("review").review, "../x.md": "x" } }), "relative path"],
      [() => inlineSkills("team", { review: { ...skill("review").review, "a\\b.md": "x" } }), "relative path"],
      [() => inlineSkills("team", { review: { ...skill("review").review, "a//b.md": "x" } }), "relative path"],
      [() => inlineSkills("team", { review: { ...skill("review").review, "notes\ud800.md": "x" } }), "relative path"],
      [
        () =>
          inlineSkills(
            "team",
            skill(
              "review",
              `---\nname: review\ndescription: x\n${Array.from({ length: 12 }, (_, depth) => `${"  ".repeat(depth)}k${depth}:`).join("\n")} x\n---\n`,
            ),
          ),
        "no supported YAML frontmatter",
      ],
      [
        () => inlineSkills("team", skill("review", '---\n{"name": "review", "description": "x"}\n---\n')),
        "no supported YAML frontmatter",
      ],
    ];
    for (const [build, message] of refusals) {
      expect(build).toThrow(ConfigError);
      expect(build).toThrow(message);
    }
    expect(() => deployment({ skills: [inlineSkills("team", skill("a")), inlineSkills("team", skill("b"))] })).toThrow(
      'ConnectaConfig.skills[1] repeats the source id "team".',
    );
    expect(() => deployment({ skills: holes(2, inlineSkills("team", skill("a"))) as never })).toThrow(
      "ConnectaConfig.skills[0] must be a skill source built with inlineSkills.",
    );
    expect(() => deployment({ skills: [{ id: "team" } as never] })).toThrow(
      "ConnectaConfig.skills[0] must be a skill source built with inlineSkills.",
    );
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

  it("INV-11: refuses a maintainer listed in any pool, by bare id or namespaced reference", () => {
    for (const members of [
      ["bob", "alice"],
      ["bob", { namespace: NAMESPACE, id: "alice" }],
    ]) {
      const attempt = build({
        auth: users(),
        maintainers: ["alice"],
        pools: { team: { tools: ["wiki"], members: ["carol"] }, other: { tools: ["wiki"], members } },
      });
      expect(attempt).toThrow(ConfigError);
      expect(attempt).toThrow(
        "ConnectaConfig.pools.other.members[1] is a maintainer. Maintainers receive the whole catalog at plain /mcp and belong to no pool",
      );
    }
  });

  it("INV-11: refuses a person listed in two pools, naming the second listing and the first pool", () => {
    const attempt = build({
      auth: users(),
      maintainers: ["alice"],
      pools: {
        one: { tools: ["wiki"], members: ["bob"] },
        two: { tools: ["wiki"], members: ["carol", { namespace: NAMESPACE, id: "bob" }] },
      },
    });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow('ConnectaConfig.pools.two.members[1] is already a member of pool "one".');
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

  it("INV-11: refuses a shared OAuth connector whose members list no maintainer when no operator UI can connect it (#1377)", async () => {
    const restricted = (members: string[], ui: boolean) =>
      build({
        auth: users(),
        maintainers: ["alice"],
        connectors: [{ ...sharedOAuth(), members }],
        ...(ui ? { ui: operatorUi() } : {}),
      });
    expect(restricted(["bob"], false)).toThrow(
      'Connector("shared").members lists no maintainer and ui is unset, so no one can connect it.',
    );
    await restricted(["alice", "bob"], false)().close();
    // With the operator UI, the maintainer the list omits still connects it there.
    const storage = memoryStorage();
    const c = createTestConnecta({
      connectors: [{ ...sharedOAuth(), members: ["bob"] }],
      auth: users(),
      maintainers: ["alice"],
      pools: { team: { tools: ["shared"], members: ["bob"] } },
      vault: encryptedCredentialVault(storage, ENCRYPTION_KEY),
      storage,
      publicUrl: BASE,
      logger: silentLogger,
    });
    const started = await c.fetch(request("/ui/oauth/shared", "alice", { method: "POST", headers: { Origin: BASE } }));
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ state: "auth_required", authorizationUrl: expect.any(String) });
    await c.close();
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
