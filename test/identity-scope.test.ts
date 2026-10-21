import { machineAuth } from "./helpers/machine-auth.js";
import { InvocationFailure } from "../src/invocation.js";
import { ConnectorCallError } from "../src/errors.js";
import { fetchTestUiDetails } from "./helpers.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { accessTokens } from "../src/access-tokens.js";
import { describe, expect, it } from "vitest";
import { api } from "../src/connectors/api.js";
import { callerOf } from "../src/connector-caller.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { createConnecta, customExecutor, type ConnectaConfig } from "../src/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import { identityStorageKey } from "../src/identity.js";
import type { Connector, InboundAuth, KVStorage, ToolDef } from "../src/types.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { scriptedExecutor } from "./fixtures/misc.js";

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

const listTools = (c: { fetch: (request: Request) => Promise<Response> }, path: string, user: string) =>
  c.fetch(
    request(path, user, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );

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

const searchText = async (c: ReturnType<typeof deployment>, path: string, user: User) =>
  JSON.stringify(await rpc(c, path, user, "search_tools", { query: "team data", limit: 50 }));

describe("maintainers and plain /mcp", () => {
  it.each(["subject", "principal"] as const)(
    "INV-4: isolates guest result pages for maintainer %s identities without an activity namespace",
    async (identityKind) => {
      const auth: InboundAuth | InboundAuth[] =
        identityKind === "subject"
          ? [machineAuth("alice", { subjectId: "alice" }), machineAuth("bob", { subjectId: "bob" })]
          : {
              kind: "access_token",
              authorize(request) {
                const id = /^Bearer (alice|bob)$/.exec(request.headers.get("authorization") ?? "")?.[1];
                return id
                  ? { ok: true, principal: { namespace: "directory", id } }
                  : { ok: false, response: new Response(null, { status: 401 }) };
              },
            };
      const connecta = createTestConnecta({
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
        ...(identityKind === "principal"
          ? {
              maintainers: [
                { namespace: "directory", id: "alice" },
                { namespace: "directory", id: "bob" },
              ],
            }
          : {}),
        executor: scriptedExecutor((fns) => fns.result!(resultId)),
        calls: { maxResultBytes: 100 },
        logger: silentLogger,
      });
      const call = async (token: string, name: string, args: object) =>
        (await readJsonRpc(await mcpRpc(connecta, "tools/call", { name, arguments: args }, { token }))).result;
      const result = await call("alice", "call_tool", { address: "docs.read" });
      const { resultId } = JSON.parse(result.content[0].text.split("\n")[0]);
      expect(resultId).toBeTypeOf("string");
      expect(
        (await call("alice", "execute_code", { code: "async () => await connecta.result(id)" })).isError,
      ).toBeFalsy();
      expect((await call("bob", "execute_code", { code: "async () => await connecta.result(id)" })).isError).toBe(true);
      await connecta.close();
    },
  );

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

  it("INV-4: binds result handles to their endpoint", async () => {
    let resultId = "";
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
      auth: users(),
      maintainers: ["alice"],
      pools: { team: { tools: ["docs"], members: ["alice"] } },
      storage: memoryStorage(),
      calls: { maxResultBytes: 100 },
      logger: silentLogger,
      executor: scriptedExecutor(async (fns) => fns.result!(resultId, { maxBytes: 100 })),
    });
    const page = async (path: string) =>
      (await rpc(c, path, "alice", "execute_code", { code: "return await connecta.result(id)" })).result;
    for (const [minted, other] of [
      ["/mcp", "/mcp/team"],
      ["/mcp/team", "/mcp"],
    ] as const) {
      const first = (await rpc(c, minted, "alice", "call_tool", { address: "docs.read" })).result;
      resultId = JSON.parse(first.content[0].text.split("\n")[0]).resultId;
      expect(resultId).toBeTypeOf("string");
      expect((await page(minted)).isError).toBeFalsy();
      expect((await page(other)).isError).toBe(true);
    }
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

  it("refuses static headers disguised as personal auth", () => {
    expect(() =>
      remoteMcp("bad", {
        url: "https://mcp.test",
        authScope: "personal",
        auth: { type: "headers", headers: { Authorization: "secret" } },
      }),
    ).toThrow('cannot combine authScope "personal" with static headers');
  });

  it("INV-5: isolates personal vault entries while shared auth stays editable", async () => {
    const personal = api("personal", {
      description: "Personal connection",
      authScope: "personal",
      credential: { label: "Personal token" },
      tools: [],
    });
    personal.status = async (ctx) => {
      const value = await ctx.credential?.get();
      return value ? { state: "ok", message: value.slice(-4) } : { state: "auth_required" };
    };
    const shared = api("shared", {
      description: "Shared connection",
      credential: { label: "Shared token" },
      tools: [],
    });
    const connecta = createTestConnecta({
      connectors: [personal, shared],
      auth: users(),
      maintainers: ["alice", "bob"],
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
    const aliceData = (await alice.json()) as any;
    const bobData = (await bob.json()) as any;
    expect(aliceData.connectors.find((item: any) => item.id === "personal").credential.lastFour).toBe("1111");
    expect(bobData.connectors.find((item: any) => item.id === "personal").credential.lastFour).toBe("2222");
    expect(bobData.connectors.find((item: any) => item.id === "shared").credential.lastFour).toBe("4444");

    const retired = await connecta.fetch(request("/ui/access-tokens", "alice"));
    expect(retired.status).toBe(404);
  });

  it("returns a personal OAuth callback to the principal that started it", async () => {
    const connecta = createTestConnecta({
      connectors: [personalOAuth()],
      auth: users(),
      maintainers: ["alice", "bob"],
      vault: encryptedCredentialVault(memoryStorage(), ENCRYPTION_KEY),
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
    const link = ((await started.json()) as any).authorizationUrl;
    const consent = await connecta.fetch(new Request(link, { headers: { Authorization: "Bearer alice" } }));
    expect(consent.status).toBe(302);
    const authorizationUrl = new URL(consent.headers.get("Location")!);
    const state = authorizationUrl.searchParams.get("state");
    const fixedByAnotherUser = await connecta.fetch(request(`/oauth/callback/oauth?code=code&state=${state}`, "bob"));
    expect(fixedByAnotherUser.status).toBe(400);
    const callback = await connecta.fetch(request(`/oauth/callback/oauth?code=code&state=${state}`, "alice"));
    expect(callback.status).toBe(200);
    const replay = await connecta.fetch(request(`/oauth/callback/oauth?code=code&state=${state}`, "alice"));
    expect(replay.status).toBe(400);

    const alice = await fetchTestUiDetails(connecta, request("/ui/data", "alice"));
    const bob = await fetchTestUiDetails(connecta, request("/ui/data", "bob"));
    expect(((await alice.json()) as any).connectors[0].status).toBe("ok");
    expect(((await bob.json()) as any).connectors[0].status).toBe("auth_required");
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
  it("INV-4: a member gets exactly the pool's tools, with no intersection or widening", async () => {
    const deleted = { count: 0 };
    const c = deployment({
      connectors: teamConnectors(() => {
        deleted.count++;
      }),
      pools: {
        support: { tools: ["notes.search", "notes.fetch", "wiki"], members: ["alice", "bob"] },
        whole: { tools: ["notes.search", "notes"], members: ["bob"] },
      },
    });
    for (const user of ["alice", "bob"] as const) {
      const pooled = await searchText(c, "/mcp/support", user);
      expect(pooled).toContain("notes.search");
      expect(pooled).toContain("notes.fetch");
      expect(pooled).toContain("wiki.read");
      expect(pooled).not.toContain("notes.delete");
      expect(pooled).not.toContain("billing.invoices");
    }
    // A maintainer's own plain /mcp view never leaks into a pool.
    const ungranted = await rpc(c, "/mcp/support", "alice", "call_destructive_tool", {
      address: "notes.delete",
      args: {},
    });
    const absent = await rpc(c, "/mcp/support", "alice", "call_destructive_tool", { address: "notes.purge", args: {} });
    const code = (body: any) =>
      body.result.structuredContent?.error?.code ?? JSON.parse(body.result.content[0].text).error.code;
    expect(code(ungranted)).toBe("unknown_tool");
    expect(code(absent)).toBe("unknown_tool");
    expect(deleted.count).toBe(0);
    // A bare id beside addresses for the same connector is the whole connector.
    expect(await searchText(c, "/mcp/whole", "bob")).toContain("notes.delete");
    expect(
      (await rpc(c, "/mcp/whole", "bob", "call_destructive_tool", { address: "notes.delete", args: {} })).result
        .isError,
    ).toBeFalsy();
    expect(deleted.count).toBe(1);
    // Arguments never name a scope.
    const forged = await rpc(c, "/mcp/support", "bob", "search_tools", {
      query: "team data",
      limit: 50,
      pool: "whole",
      connector: "billing",
    });
    expect(JSON.stringify(forged)).not.toContain("billing.invoices");
    await c.close();
  });

  it("INV-3 INV-4: scopes a program's search and call through the pool's view", async () => {
    const outcomes: Record<string, unknown> = {};
    const deleted = { count: 0 };
    const c = deployment({
      connectors: teamConnectors(() => {
        deleted.count++;
      }),
      pools: { support: { tools: ["notes.search", "notes.fetch", "wiki"], members: ["bob"] } },
      executor: {
        async execute(
          _code: string,
          providers: Array<{ name: string; fns: Record<string, (...args: any[]) => Promise<unknown>> }>,
        ) {
          const fns = providers.find((provider) => provider.name === "connecta")!.fns;
          outcomes.search = await fns.search!({ query: "notes", limit: 20 });
          try {
            outcomes.call = await fns.call!("notes.delete", {});
          } catch (error) {
            outcomes.call = error instanceof InvocationFailure ? error.details : String(error);
          }
          return { result: null };
        },
      },
    });
    await rpc(c, "/mcp/support", "bob", "execute_code", { code: "return 1" });
    const searched = JSON.stringify(outcomes.search);
    expect(searched).toContain("notes.search");
    expect(searched).not.toContain("notes.delete");
    expect(outcomes.call).toMatchObject({ code: "unknown_tool" });
    expect(deleted.count).toBe(0);
    await c.close();
  });

  it("INV-2 INV-4: connector readOnly applies to maintainers and pools", async () => {
    let writes = 0;
    const connectors = teamConnectors(() => writes++);
    connectors[0]!.readOnly = true;
    const c = deployment({
      connectors,
      pools: {
        writers: { tools: ["notes"], readOnly: false, members: ["alice"] },
        readers: { tools: ["notes"], readOnly: true, members: ["alice"] },
      },
    });
    try {
      for (const path of ["/mcp", "/mcp/writers", "/mcp/readers"]) {
        const search = await searchText(c, path, "alice");
        expect(search).toContain("notes.search");
        expect(search).not.toContain("notes.delete");
        for (const name of ["call_tool", "call_destructive_tool"]) {
          const result = await rpc(c, path, "alice", name, { address: "notes.delete", args: {} });
          expect(JSON.stringify(result)).toContain("read_only_endpoint");
        }
      }
      expect(writes).toBe(0);
    } finally {
      await c.close();
    }
  });

  it("INV-2: a readOnly pool refuses writes while the maintainer's writable /mcp does not", async () => {
    const deleted = { count: 0 };
    const c = deployment({
      connectors: teamConnectors(() => {
        deleted.count++;
      }),
      pools: { readers: { tools: ["notes"], readOnly: true, members: ["alice"] } },
    });
    const refused = await rpc(c, "/mcp/readers", "alice", "call_destructive_tool", {
      address: "notes.delete",
      args: {},
    });
    expect(JSON.stringify(refused)).toContain("read_only_endpoint");
    expect(await searchText(c, "/mcp/readers", "alice")).not.toContain("notes.delete");
    expect(
      (await rpc(c, "/mcp", "alice", "call_destructive_tool", { address: "notes.delete", args: {} })).result.isError,
    ).toBeFalsy();
    expect(deleted.count).toBe(1);
    await c.close();
  });

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

  it("INV-4: answers a non-member, an undeclared pool, and a non-maintainer at /mcp identically after auth", async () => {
    const c = deployment({
      pools: {
        closed: { tools: ["wiki"], members: ["carol"] },
        open: { tools: ["wiki"], members: ["bob"] },
      },
    });
    const bodies = new Set<string>();
    for (const path of ["/mcp/missing", "/mcp/closed", "/mcp"]) {
      const response = await listTools(c, path, "bob");
      expect(response.status, path).toBe(404);
      bodies.add(JSON.stringify(await wire(response)));
    }
    expect(bodies.size).toBe(1);
    expect((await listTools(c, "/mcp/open", "bob")).status).toBe(200);
    const unauthenticated = await c.fetch(
      new Request(`${BASE}/mcp/closed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(unauthenticated.status).toBe(401);
    await c.close();
  });
});

describe("member references at construction", () => {
  const twoProviders = (): InboundAuth[] => [
    users(),
    { ...users(), kind: "second", activityActorNamespace: "https://second.test" },
  ];
  const build = (config: Partial<ConnectaConfig>) => () =>
    createConnecta({
      connectors: teamConnectors(),
      readOnly: false,
      executor: customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }),
      logger: silentLogger,
      ...config,
    } as ConnectaConfig);
  const withAgents = (storage: KVStorage = memoryStorage()) => ({
    storage,
    agents: ["bot"],
    accessTokens: accessTokens(storage),
  });

  it("INV-11: resolves bare ids in the interactive provider's namespace, explicit refs, and declared agents", () => {
    const app = build({
      auth: users(),
      ...withAgents(),
      maintainers: ["alice", { namespace: "custom", id: "has:colon" }],
      pools: { team: { tools: ["wiki"], members: ["bob", "agent:bot", { namespace: NAMESPACE, id: "carol" }] } },
    })();
    const described = app.describeConfig();
    expect(described.maintainers).toEqual([
      { namespace: NAMESPACE, id: "alice" },
      { namespace: "custom", id: "has:colon" },
    ]);
    expect(described.pools).toEqual([
      {
        name: "team",
        path: "/mcp/team",
        tools: ["wiki"],
        readOnly: false,
        owner: null,
        description: null,
        members: [
          { kind: "human", namespace: NAMESPACE, id: "bob" },
          { kind: "agent", name: "bot" },
          { kind: "human", namespace: NAMESPACE, id: "carol" },
        ],
      },
    ]);
    expect(described).not.toHaveProperty("hasGrant");
    expect(described.pools[0]).not.toHaveProperty("hasGrant");
    expect(described).not.toHaveProperty("identity");
  });

  it.each([
    [
      "a bare id with two interactive providers",
      () => ({ auth: twoProviders(), maintainers: ["alice"] }),
      "ConnectaConfig.maintainers[0] is a bare principal id, which resolves only when exactly one interactive auth provider is configured (found 2)",
    ],
    [
      "a bare id with a colon",
      () => ({ auth: users(), maintainers: ["user:alice"] }),
      'ConnectaConfig.maintainers[0] contains ":". Write a principal whose id contains ":" as { namespace, id }',
    ],
    [
      "an unknown agent",
      () => ({
        auth: users(),
        ...withAgents(),
        maintainers: ["alice"],
        pools: { team: { tools: ["wiki"], members: ["agent:ghost"] } },
      }),
      'ConnectaConfig.pools.team.members[0] names agent "ghost", which ConnectaConfig.agents does not declare',
    ],
    [
      "missing members",
      () => ({ auth: users(), maintainers: ["alice"], pools: { team: { tools: ["wiki"] } } }),
      "ConnectaConfig.pools.team.members is required",
    ],
    [
      "an agent among maintainers",
      () => ({ auth: users(), ...withAgents(), maintainers: ["alice", "agent:bot"] }),
      "ConnectaConfig.maintainers[1] is an agent. Agents are never maintainers",
    ],
    [
      "missing maintainers with inbound auth",
      () => ({ auth: users() }),
      "ConnectaConfig.maintainers is required with inbound auth",
    ],
    [
      "maintainers without inbound auth",
      () => ({ maintainers: [{ namespace: NAMESPACE, id: "alice" }] }),
      "ConnectaConfig.maintainers needs an inbound auth provider that admits people",
    ],
  ])("INV-11: refuses %s at construction", (_name, config, message) => {
    expect(build(config() as Partial<ConnectaConfig>)).toThrow(message);
  });

  it.each([
    [
      "identity.connectorAccess",
      { identity: { connectorAccess: () => "all" } },
      "identity.connectorAccess was removed (#837): pools are the access model. List who may use plain /mcp in maintainers, and give each pool its tools and members. A guarded { tool, requireReadOnly: true } grant becomes a pool with readOnly: true.",
    ],
    [
      "the top-level grant",
      { grant: () => true },
      "The top-level grant was removed (#837); list the people who may use plain /mcp in maintainers.",
    ],
    [
      "a pool grant",
      { pools: { team: { tools: ["wiki"], members: ["bob"], grant: () => true } } },
      "Pool grant was removed (#837); list who may open the pool in its members.",
    ],
  ])("INV-11: refuses the removed %s and names its replacement", (_name, config, message) => {
    const attempt = build({ auth: users(), maintainers: ["alice"], ...(config as Partial<ConnectaConfig>) });
    expect(attempt).toThrow(message);
  });

  it("INV-11: refuses a misdeclared pool at construction", () => {
    const attempt = (pools: Record<string, unknown>) =>
      build({ auth: users(), maintainers: ["alice"], pools: pools as ConnectaConfig["pools"] });
    expect(attempt({ "Bad Name": { tools: ["wiki"], members: ["bob"] } })).toThrow("must match");
    expect(attempt({ ghost: { tools: ["nope"], members: ["bob"] } })).toThrow('unknown connector "nope"');
    expect(attempt({ typo: { tools: ["notes.serach"], members: ["bob"] } })).toThrow('no tool "serach"');
    expect(attempt({ empty: { tools: [], members: ["bob"] } })).toThrow("at least one");
    expect(attempt({ shape: { tools: "wiki", members: ["bob"] } })).toThrow("must be an array");
    expect(
      attempt({ guarded: { tools: [{ tool: "notes.search", requireReadOnly: true }], members: ["bob"] } }),
    ).toThrow("tools must be connector ids or connector.tool addresses");
    expect(attempt({ typo: { tools: ["wiki"], members: ["bob"], grants: () => true } })).toThrow(
      "ConnectaConfig.pools.typo.grants",
    );
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
      maintainers: ["alice"],
      pools: { team: { tools: ["who"], members: ["bob"] } },
      logger: silentLogger,
    });
    const me = async (path: string, user: "alice" | "bob") => {
      const body = await rpc(connecta, path, user, "call_tool", {
        address: "who.me",
        args: { identity: { actor: { kind: "forged", id: "mallory" } }, caller: "mallory" },
      });
      return JSON.parse(body.result.content[0].text);
    };
    const direct = await me("/mcp", "alice");
    expect(direct).toEqual({
      identity: {
        actor: { kind: "test-users", id: "alice", namespace: NAMESPACE },
        subject: { namespace: NAMESPACE, id: "alice" },
        principal: { namespace: NAMESPACE, id: "alice" },
        interactive: true,
      },
      authenticated: true,
    });
    const pooled = await me("/mcp/team", "bob");
    expect(pooled).toMatchObject({ identity: { actor: { id: "bob" } }, pool: "team" });
    expect(JSON.stringify([direct, pooled])).not.toContain("mallory");
  });

  it("is marked unauthenticated when an open deployment admits the request", async () => {
    const connecta = createTestConnecta({ connectors: [whoami()], logger: silentLogger });
    const response = await connecta.fetch(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "call_tool", arguments: { address: "who.me", args: { authenticated: true } } },
        }),
      }),
    );
    const body = await readJsonRpc(response);
    expect(JSON.parse(body.result.content[0].text)).toEqual({
      identity: { actor: { kind: "anonymous" }, interactive: false },
      authenticated: false,
    });
  });
});
