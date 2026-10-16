import { afterEach, describe, expect, it } from "vitest";
import { accessTokens } from "../src/access-tokens.js";
import { activityHistory } from "../src/activity.js";
import { api } from "../src/connectors/api.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { identityStorageKey } from "../src/identity.js";
import type { OperatorUiContract } from "../src/operator-ui/contract.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, InboundAuth } from "../src/types.js";
import { issueAgentToken } from "./helpers/agent-tokens.js";
import { machineAuth, TEST_MACHINE_NAMESPACE } from "./helpers/machine-auth.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { readJsonRpc } from "./fixtures/http.js";

// Management collapses to maintainers (#837 P2, decisions/0006): shared auth,
// agent tokens and activity are a maintainer's; a pool member manages only
// their own account on a personal connector in one of their pools.

const BASE = "https://connecta.test";
const NAMESPACE = "https://identity.test";
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const PEOPLE = ["alice", "bob", "carol", "dave"] as const;

/** Interactive people: alice is the maintainer, bob and carol pool members, dave nobody. */
function people(): InboundAuth {
  return {
    kind: "test-people",
    interactiveOperator: true,
    uiAuth: { kind: "clerk", frontendApiUrl: NAMESPACE, publishableKey: "pk_test_fake" },
    activityActorNamespace: NAMESPACE,
    recognizesCredential: (request) => PEOPLE.some((user) => request.headers.get("authorization") === `Bearer ${user}`),
    authorize(request) {
      const user = PEOPLE.find((candidate) => request.headers.get("authorization") === `Bearer ${candidate}`);
      return user
        ? { ok: true, userId: user }
        : { ok: false, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
    },
  };
}

function oauth(id: string, authScope: "shared" | "personal"): Connector {
  return {
    id,
    authScope,
    async listTools() {
      return [{ name: "read", annotations: { readOnlyHint: true } }];
    },
    async callTool() {
      return { ok: true };
    },
    async status(ctx) {
      return (await ctx.storage.get("token")) ? { state: "ok" } : { state: "auth_required" };
    },
    async startAuth(ctx) {
      const state = crypto.randomUUID();
      await ctx.storage.set("pending", state);
      return { state: "auth_required", authorizationUrl: `https://provider.test/authorize?state=${state}` };
    },
    async verifyState(state, ctx) {
      return state !== null && state === (await ctx.storage.get("pending"));
    },
    async finishAuth(_code, ctx) {
      await ctx.storage.set("token", "connected");
      await ctx.storage.delete("pending");
    },
    async disconnectAuth(ctx) {
      await ctx.storage.delete("token");
      await ctx.storage.delete("pending");
    },
  };
}

const deployments: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(deployments.splice(0).map((deployment) => deployment.close()));
});

async function setup() {
  const storage = memoryStorage();
  const vault = encryptedCredentialVault(storage, KEY);
  const bot = await issueAgentToken(storage, "bot");
  const app = createTestConnecta({
    connectors: [
      oauth("shared", "shared"),
      oauth("personal", "personal"),
      api("vaulted", { credential: { label: "Token" }, tools: [] }),
      api("own_key", { credential: { label: "Token" }, authScope: "personal", tools: [] }),
      api("wiki", {
        tools: [
          {
            name: "read",
            description: "Read the wiki",
            annotations: { readOnlyHint: true },
            handler: async () => ({ ok: true }),
          },
        ],
      }),
    ],
    auth: [people(), machineAuth("machine")],
    // The machine principal is a maintainer too: non-interactive, so it reads
    // activity and manages nothing.
    maintainers: ["alice", { namespace: TEST_MACHINE_NAMESPACE, id: "machine" }],
    agents: ["bot"],
    accessTokens: accessTokens(storage),
    pools: {
      team: { tools: ["shared", "personal", "vaulted", "own_key"], members: ["bob", "agent:bot"] },
      // Carol's pool holds no personal connector.
      other: { tools: ["wiki"], members: ["carol"] },
    },
    activity: activityHistory({ store: { record() {}, list: async () => ({ events: [] }) } }),
    storage,
    vault,
    publicUrl: BASE,
    logger: silentLogger,
  });
  deployments.push(app);
  const send = (user: string, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${user}`);
    headers.set("Origin", BASE);
    if (init.body) headers.set("Content-Type", "application/json");
    return app.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
  };
  const authorizeConnector = async (user: string, connector: string, pool?: string) => {
    // Agents use /agent/<pool>; human endpoints refuse their cta_ token (#837).
    const endpoint = user.startsWith("cta_") && pool ? `/agent/${pool}` : `/mcp${pool ? `/${pool}` : ""}`;
    const response = await send(user, endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "authorize_connector", arguments: { connector } },
      }),
    });
    const rpc = await readJsonRpc(response);
    const text = rpc.result.content[0].text as string;
    // A refusal such as "Unknown connector" is plain text; a handoff is JSON.
    return (text.startsWith("{") ? JSON.parse(text) : { message: text }) as Record<string, any>;
  };
  /** A browser visit to a connect link, continuing a maintainer's UI hop with start=1 as the Auth tab does. */
  const visit = async (user: string, link: string) => {
    const response = await send(user, new URL(link).pathname + new URL(link).search);
    const location = response.headers.get("Location");
    if (location && new URL(location, BASE).pathname.startsWith("/connectors/")) {
      const start = new URL(link);
      start.searchParams.set("start", "1");
      return send(user, start.pathname + start.search);
    }
    return response;
  };
  /** Connect `user` through a link they were issued, through consent and the callback. */
  const connect = async (user: string, link: string, id = "personal") => {
    const started = await visit(user, link);
    expect(started.status, `${user} start`).toBe(302);
    const state = new URL(started.headers.get("Location")!).searchParams.get("state");
    return send(user, `/oauth/callback/${id}?code=code&state=${state}`);
  };
  const state = async (id: string, user?: string) =>
    (
      await app.registry
        .scoped({
          connectorIds: [id],
          ...(user ? { principalKey: await identityStorageKey({ namespace: NAMESPACE, id: user }) } : {}),
        })
        .statusFor(id, BASE, {})
    ).state;
  return { app, storage, vault, bot, send, authorizeConnector, visit, connect, state };
}

describe("management collapses to maintainers", () => {
  it("INV-4 INV-5: a non-maintainer is refused shared credentials and OAuth grants on every route while a maintainer succeeds", async () => {
    const flow = await setup();
    const routes: Array<[string, RequestInit]> = [
      ["/ui/oauth/shared", { method: "POST" }],
      ["/ui/oauth/shared", { method: "DELETE" }],
      ["/ui/credentials/vaulted", { method: "PUT", body: JSON.stringify({ value: "shared-secret-value" }) }],
      ["/ui/credentials/vaulted", { method: "DELETE" }],
      ["/ui/credentials/vaulted/test", { method: "POST" }],
    ];
    // A member of the pool holding both shared connectors is refused, as are
    // an agent in that pool and a non-interactive maintainer.
    for (const [user, status] of [
      ["bob", 403],
      [flow.bot, 403],
      ["machine", 403],
      ["carol", 404],
      ["dave", 404],
    ] as const) {
      for (const [path, init] of routes) {
        const refused = await flow.send(user, path, init);
        expect(refused.status, `${user} ${init.method} ${path}`).toBe(status);
        expect(await refused.text()).not.toContain("shared-secret-value");
      }
    }
    expect(await flow.vault.get("vaulted")).toBeNull();
    // Issuance: authorize_connector for the member and the agent in their pool.
    for (const user of ["bob", flow.bot]) {
      const handoff = await flow.authorizeConnector(user, "shared", "team");
      expect(handoff).not.toHaveProperty("authorizationUrl");
      expect(JSON.stringify(handoff)).toContain("not permitted");
    }
    // A maintainer's own link, visited and called back by the member, stops at both steps.
    const link = (await flow.authorizeConnector("alice", "shared")).authorizationUrl as string;
    expect(link).toContain("/connect/shared?h=");
    expect((await flow.visit("bob", link)).status).toBe(403);
    expect(await flow.state("shared")).toBe("auth_required");
    // The maintainer succeeds on every step.
    expect((await flow.connect("alice", link, "shared")).status).toBe(200);
    expect(await flow.state("shared")).toBe("ok");
    expect((await flow.send("alice", "/ui/oauth/shared", { method: "POST" })).status).toBe(200);
    expect((await flow.send("alice", "/ui/oauth/shared", { method: "DELETE" })).status).toBe(204);
    expect(await flow.state("shared")).toBe("auth_required");
    const saved = await flow.send("alice", "/ui/credentials/vaulted", {
      method: "PUT",
      body: JSON.stringify({ value: "shared-secret-value" }),
    });
    expect(saved.status).toBe(200);
    expect(await flow.vault.get("vaulted")).toBe("shared-secret-value");
    expect((await flow.send("alice", "/ui/credentials/vaulted", { method: "DELETE" })).status).toBe(204);
  });

  it("INV-4 INV-5: a member connects and disconnects their own personal connector in their pool, in their own partition", async () => {
    const flow = await setup();
    // The maintainer connects their own account first, from plain /mcp.
    const own = (await flow.authorizeConnector("alice", "personal")).authorizationUrl as string;
    expect((await flow.connect("alice", own)).status).toBe(200);
    // The member's link comes from their pool and binds their principal.
    const link = (await flow.authorizeConnector("bob", "personal", "team")).authorizationUrl as string;
    expect(link).toContain("/connect/personal?h=");
    expect((await flow.visit("carol", link)).status).toBe(403);
    expect((await flow.visit("alice", link)).status).toBe(403);
    expect((await flow.connect("bob", link)).status).toBe(200);
    expect(await flow.state("personal", "bob")).toBe("ok");
    // The operator OAuth route starts and disconnects the member's own account only.
    const started = await flow.send("bob", "/ui/oauth/personal", { method: "POST" });
    expect(started.status).toBe(200);
    expect(((await started.json()) as { authorizationUrl: string }).authorizationUrl).toContain("/connect/personal?h=");
    expect((await flow.send("bob", "/ui/oauth/personal", { method: "DELETE" })).status).toBe(204);
    expect(await flow.state("personal", "bob")).toBe("auth_required");
    expect(await flow.state("personal", "alice")).toBe("ok");
    // A personal credential lands in the member's partition, never the maintainer's or the shared slot.
    for (const [user, value] of [
      ["bob", "bob-secret-value"],
      ["alice", "alice-secret-value"],
    ] as const) {
      const response = await flow.send(user, "/ui/credentials/own_key", {
        method: "PUT",
        body: JSON.stringify({ value }),
      });
      expect(response.status, user).toBe(200);
    }
    const partition = async (user: string) => identityStorageKey({ namespace: NAMESPACE, id: user });
    expect(await flow.vault.get("own_key", "value", await partition("bob"))).toBe("bob-secret-value");
    expect(await flow.vault.get("own_key", "value", await partition("alice"))).toBe("alice-secret-value");
    expect(await flow.vault.get("own_key")).toBeNull();
    expect((await flow.send("bob", "/ui/credentials/own_key", { method: "DELETE" })).status).toBe(204);
    expect(await flow.vault.get("own_key", "value", await partition("bob"))).toBeNull();
    expect(await flow.vault.get("own_key", "value", await partition("alice"))).toBe("alice-secret-value");
  });

  it("INV-4 INV-5: a member of a pool without the personal connector, and an agent, are refused it", async () => {
    const flow = await setup();
    // Carol's pool holds no personal connector: issuance does not know it and
    // the operator routes resolve none of her pools' connectors as it.
    const handoff = await flow.authorizeConnector("carol", "personal", "other");
    expect(handoff).not.toHaveProperty("authorizationUrl");
    expect(JSON.stringify(handoff)).toContain("Unknown connector");
    for (const [path, init] of [
      ["/ui/oauth/personal", { method: "POST" }],
      ["/ui/oauth/personal", { method: "DELETE" }],
      ["/ui/credentials/own_key", { method: "PUT", body: JSON.stringify({ value: "carol-secret-value" }) }],
    ] as const) {
      expect((await flow.send("carol", path, init)).status, `${init.method} ${path}`).toBe(404);
      // A person in no pool gets the operator routes' private 404.
      const nobody = await flow.send("dave", path, init);
      expect(nobody.status).toBe(404);
      expect(await nobody.json()).toEqual({ error: "not found" });
      // An agent has no principal and manages nothing.
      expect((await flow.send(flow.bot, path, init)).status).toBe(403);
    }
    expect(await flow.state("personal", "carol")).toBe("auth_required");
    const agentHandoff = await flow.authorizeConnector(flow.bot, "personal", "team");
    expect(agentHandoff).not.toHaveProperty("authorizationUrl");
  });

  it("INV-4: a maintainer manages their own personal connector from plain /mcp and the operator routes", async () => {
    const flow = await setup();
    const started = await flow.send("alice", "/ui/oauth/personal", { method: "POST" });
    expect(started.status).toBe(200);
    const link = ((await started.json()) as { authorizationUrl: string }).authorizationUrl;
    expect((await flow.connect("alice", link)).status).toBe(200);
    expect(await flow.state("personal", "alice")).toBe("ok");
    expect(await flow.state("personal", "bob")).toBe("auth_required");
    expect((await flow.send("alice", "/ui/oauth/personal", { method: "DELETE" })).status).toBe(204);
    expect(await flow.state("personal", "alice")).toBe("auth_required");
  });

  it("INV-4: activity reads take a maintainer principal, interactive or not; members get the private 404 and agents a 401", async () => {
    const flow = await setup();
    for (const user of ["alice", "machine"]) {
      expect((await flow.send(user, "/ui/api/activity")).status, user).toBe(200);
    }
    for (const user of ["bob", "carol", "dave"]) {
      for (const path of ["/ui/activity", "/ui/api/activity"]) {
        const refused = await flow.send(user, path);
        expect(refused.status, `${user} ${path}`).toBe(404);
        expect(await refused.json()).toEqual({ error: "not found" });
      }
    }
    // Operator routes are human routes: an agent token is refused outright (#837).
    for (const path of ["/ui/activity", "/ui/api/activity"]) {
      expect((await flow.send(flow.bot, path)).status, path).toBe(401);
    }
  });

  it("INV-4: agent token management takes an interactive maintainer; machines and agents manage nothing", async () => {
    const flow = await setup();
    for (const [user, status] of [
      [flow.bot, 403],
      ["machine", 403],
      ["bob", 404],
      ["dave", 404],
    ] as const) {
      expect((await flow.send(user, "/ui/access-tokens")).status, user).toBe(status);
      expect((await flow.send(user, "/ui/access-tokens/bot", { method: "POST" })).status, user).toBe(status);
      expect((await flow.send(user, "/ui/access-tokens/bot", { method: "DELETE" })).status, user).toBe(status);
    }
    const listed = await flow.send("alice", "/ui/access-tokens");
    expect(listed.status).toBe(200);
    const { agents } = (await listed.json()) as { agents: Array<{ name: string; revision: string }> };
    const rotated = await flow.send("alice", "/ui/access-tokens/bot", {
      method: "POST",
      body: JSON.stringify({ expect: agents.find((agent) => agent.name === "bot")?.revision }),
    });
    expect(rotated.status).toBe(200);
  });

  it("INV-4: the operator contract follows the maintainer rules: whole for maintainers, own manage for members", async () => {
    const flow = await setup();
    const contract = async (user: string) =>
      (await (await flow.send(user, "/ui/api/config")).json()) as OperatorUiContract;
    // Both maintainers get the whole view, interactive or not.
    for (const user of ["alice", "machine"]) {
      const view = await contract(user);
      expect(view.role, user).toBe("maintainer");
      expect(view.config?.connectors.map((c) => c.id)).toEqual(["shared", "personal", "vaulted", "own_key", "wiki"]);
      expect(view.agents.map((agent) => agent.name)).toEqual(["bot"]);
    }
    // Bob manages his own account on the personal connectors in his pool, and nothing shared.
    const bob = await contract("bob");
    expect(bob.role).toBe("member");
    expect(bob.connectors.map((c) => [c.id, c.manage])).toEqual([
      ["shared", { kind: "none" }],
      ["personal", { kind: "oauth", actions: ["connect", "restart", "disconnect"] }],
      ["vaulted", { kind: "none" }],
      ["own_key", { kind: "credential", label: "Token", actions: ["save"] }],
    ]);
    // Carol's pool holds no personal connector, so she manages nothing.
    const carol = await contract("carol");
    expect(carol.connectors.map((c) => [c.id, c.manage])).toEqual([["wiki", { kind: "none" }]]);
    // Dave is nobody, and an agent never reads an operator contract: its
    // token is refused on every human route with the machine-only challenge.
    expect((await flow.send("dave", "/ui/api/config")).status).toBe(404);
    expect((await flow.send(flow.bot, "/ui/api/config")).status).toBe(401);
  });
});
