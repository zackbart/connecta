// Operator contract v2 as the server serves it (#837 P6b,
// decisions/0006-pools-are-the-access-model.md). Every member assertion runs
// against a real `GET /ui/api/config` body, checked by
// `expectMemberViewWithholds` against a projection built from config,
// membership and each member's own partition, never from the response.
import { afterEach, describe, expect, it } from "vitest";
import { accessTokens } from "../src/access-tokens.js";
import { activityHistory, type ToolCallActivityEvent } from "../src/activity.js";
import { AGENT_NAMESPACE } from "../src/agent-identity.js";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import type { DescribedMember } from "../src/describe-config.js";
import { identityStorageKey } from "../src/identity.js";
import type {
  OperatorGrant,
  OperatorMember,
  OperatorMemberManage,
  OperatorPoolV2,
  OperatorUiContract,
} from "../src/operator-ui/contract.js";
import { drive } from "../src/providers/drive/index.js";
import { gmail } from "../src/providers/gmail/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectaConfig } from "../src/index.js";
import type { Connector, InboundAuth, KVStorage } from "../src/types.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { machineAuth, TEST_MACHINE_NAMESPACE } from "./helpers/machine-auth.js";
import {
  expectMemberViewWithholds,
  memberViewExpectation,
  type MemberPartition,
} from "./helpers/operator-member-view.js";

const BASE = "https://connecta.test";
const NAMESPACE = "https://directory.test";
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const PEOPLE = ["alice", "bob", "lin", "carol", "dave"] as const;
const LABELS: Record<string, string> = { alice: "Alice Example", bob: "Bob Example" };

const keys = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
const SERVICE_ACCOUNT = {
  clientEmail: "operator@project.iam.gserviceaccount.com",
  privateKey: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`,
};

/** Interactive people behind a Clerk-style sign-in, with a directory for labels when `labels` is set. */
function people(labels = true): InboundAuth {
  return {
    kind: "test-people",
    interactiveOperator: true,
    uiAuth: { kind: "clerk", frontendApiUrl: NAMESPACE, publishableKey: "pk_test_fake" },
    activityActorNamespace: NAMESPACE,
    ...(labels ? { activityActorLabel: (id: string) => LABELS[id] } : {}),
    recognizesCredential: (request) => PEOPLE.some((user) => request.headers.get("authorization") === `Bearer ${user}`),
    authorize(request) {
      const user = PEOPLE.find((candidate) => request.headers.get("authorization") === `Bearer ${candidate}`);
      return user
        ? { ok: true, userId: user }
        : { ok: false, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
    },
  };
}

const READ = { annotations: { readOnlyHint: true } };

/** A personal or shared OAuth connector whose grant lives in its partition's storage. */
function oauthConnector(id: string, authScope: "shared" | "personal", granted = false): Connector {
  return {
    id,
    authScope,
    listTools: async () => [
      { name: "read", ...READ },
      { name: "send", annotations: { readOnlyHint: false } },
    ],
    callTool: async () => null,
    status: async (ctx) => (granted || (await ctx.storage.get("token")) ? { state: "ok" } : { state: "auth_required" }),
    startAuth: async () => ({ state: "auth_required", authorizationUrl: "https://provider.test/authorize?state=s" }),
    verifyState: async () => true,
    finishAuth: async (_code, ctx) => ctx.storage.set("token", "granted"),
    disconnectAuth: async (ctx) => ctx.storage.delete("token"),
  };
}

const disconnects: string[] = [];
/** Provisioned out of band: it can drop its grant but never start one. */
const calendar: Connector = {
  id: "calendar",
  authScope: "personal",
  listTools: async () => [{ name: "list", ...READ }],
  callTool: async () => null,
  status: async () => ({ state: "ok" }),
  disconnectAuth: async () => {
    disconnects.push("calendar");
  },
};

const NOTES_SLOT = {
  label: "Integration token",
  fields: [
    { name: "workspace", label: "Workspace" },
    { name: "token", label: "Token", description: "An internal integration secret" },
  ],
};
const notes = () =>
  api("notes", {
    authScope: "personal",
    credential: NOTES_SLOT,
    testCredentials: async () => ({ ok: true }),
    tools: [{ name: "query", description: "Query notes", ...READ, handler: () => null }],
  });

const wiki = () =>
  api("wiki", {
    tools: [
      { name: "read", description: "Read the wiki", ...READ, handler: () => null },
      { name: "edit", description: "Edit the wiki", annotations: { readOnlyHint: false }, handler: () => null },
    ],
  });

const apps: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  disconnects.length = 0;
});

function deploy(config: Omit<ConnectaConfig, "executor" | "readOnly"> & { readOnly?: boolean }) {
  const app = createTestConnecta({ logger: silentLogger, publicUrl: BASE, ...config });
  apps.push(app);
  return app;
}

function sender(app: ReturnType<typeof createTestConnecta>) {
  return (user: string | null, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (user) headers.set("Authorization", `Bearer ${user}`);
    headers.set("Origin", BASE);
    if (init.body) headers.set("Content-Type", "application/json");
    return app.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
  };
}

const principalKey = (id: string) => identityStorageKey({ namespace: NAMESPACE, id });

/** The team deployment: one pool of each kind of connector a member can see. */
async function team(options: { vault?: boolean; activity?: ToolCallActivityEvent[] } = {}) {
  const storage: KVStorage = memoryStorage();
  const vault = options.vault === false ? undefined : encryptedCredentialVault(storage, KEY);
  const app = deploy({
    connectors: [wiki(), oauthConnector("mail", "personal"), notes(), calendar, api("hidden", { tools: [] })],
    auth: [people(), machineAuth("machine")],
    maintainers: ["alice", { namespace: TEST_MACHINE_NAMESPACE, id: "machine" }],
    agents: ["bot", "idle", "gone"],
    accessTokens: accessTokens(storage),
    classification: { mail: { read: "read", send: "write" }, calendar: { list: "read" } },
    pools: {
      team: {
        tools: ["wiki.read", "mail", "notes", "calendar"],
        owner: "team@example.com",
        members: ["bob", "lin", "agent:bot"],
      },
      ops: { tools: ["wiki", "hidden"], members: ["carol", "agent:gone"] },
    },
    ...(options.activity
      ? {
          activity: activityHistory({
            store: { record() {}, list: async () => ({ events: options.activity! }) },
          }),
        }
      : {}),
    storage,
    ...(vault ? { vault } : {}),
  });
  // Bob has saved his Notes credential in his own partition; Lin has not.
  if (vault)
    await vault.setAll("notes", { workspace: "acme", token: "secret-notes-token" }, "bob", await principalKey("bob"));
  return { app, storage, vault, send: sender(app) };
}

async function read(send: ReturnType<typeof sender>, user: string | null): Promise<OperatorUiContract> {
  const response = await send(user, "/ui/api/config");
  expect(response.status, String(user)).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return (await response.json()) as OperatorUiContract;
}

/** Described pool `tools` entries as contract grants. */
function poolGrants(entries: readonly string[]): OperatorGrant[] {
  const grants = new Map<string, OperatorGrant>();
  for (const entry of entries) {
    const dot = entry.indexOf(".");
    const connectorId = dot < 0 ? entry : entry.slice(0, dot);
    const current = grants.get(connectorId);
    if (dot < 0 || current?.tools === "all") {
      grants.set(connectorId, { connectorId, tools: "all" });
      continue;
    }
    const tool = { name: entry.slice(dot + 1), requireReadOnly: false };
    grants.set(connectorId, { connectorId, tools: [...(current?.tools ?? []), tool] });
  }
  return [...grants.values()];
}

/** Every pool from the deployment's own description, with its members. */
function describedPools(app: ReturnType<typeof createTestConnecta>): OperatorPoolV2[] {
  const member = (reference: DescribedMember): OperatorMember =>
    reference.kind === "agent" ? reference : { ...reference, label: null };
  return app.describeConfig().pools.map((pool) => ({
    name: pool.name,
    humanPath: pool.path,
    agentPath: `/agent/${pool.name}`,
    readOnly: pool.readOnly,
    owner: pool.owner,
    tools: poolGrants(pool.tools),
    members: (pool.members ?? []).map(member),
  }));
}

const notesManage = (actions: Array<"save" | "test" | "clear">): OperatorMemberManage => ({
  kind: "credential",
  ...NOTES_SLOT,
  actions,
});

describe("operator contract v2 server", () => {
  it("INV-4: /ui/api/config is the one gate: 401 signed out, the private 404 for nobody, 200 with a role otherwise", async () => {
    const { send, storage } = await team();
    const signedOut = await send(null, "/ui/api/config");
    expect(signedOut.status).toBe(401);
    expect(signedOut.headers.get("WWW-Authenticate")).toBeTruthy();
    expect(signedOut.headers.get("Cache-Control")).toBe("no-store");
    for (const user of ["dave"]) {
      const refused = await send(user, "/ui/api/config");
      expect(refused.status).toBe(404);
      expect(refused.headers.get("Cache-Control")).toBe("no-store");
      expect(await refused.json()).toEqual({ error: "not found" });
    }
    // An agent listed in a pool is a member there, never on an operator page.
    const { issueAgentToken } = await import("./helpers/agent-tokens.js");
    const bot = await issueAgentToken(storage, "bot");
    expect((await send(bot, "/ui/api/config")).status).toBe(404);
    expect((await read(send, "alice")).role).toBe("maintainer");
    expect((await read(send, "machine")).role).toBe("maintainer");
    expect((await read(send, "bob")).role).toBe("member");
    expect((await read(send, "carol")).role).toBe("member");
  });

  it("INV-4: /ui/data and connector details stay maintainer-only; a member gets the private 404", async () => {
    const { send } = await team();
    for (const path of ["/ui/data", "/ui/connectors/mail", "/ui/connectors/wiki"]) {
      for (const user of ["bob", "carol", "dave"]) {
        const refused = await send(user, path);
        expect(refused.status, `${user} ${path}`).toBe(404);
        expect(await refused.json()).toEqual({ error: "not found" });
      }
      expect((await send("alice", path)).status, path).toBe(200);
    }
  });

  it("INV-4 INV-5 INV-6: each member's real view is exactly their projection from config, membership and partition", async () => {
    const { app, send } = await team();
    const pools = describedPools(app);
    const connectors = app.describeConfig().connectors;
    // Every served tool's registry verdict, from the deployment's declarations.
    type Tool = { address: string; classification: "read" | "write" };
    const tools: Record<"wiki" | "mail" | "notes" | "calendar", Tool[]> = {
      wiki: [
        { address: "wiki.read", classification: "read" },
        { address: "wiki.edit", classification: "write" },
      ],
      mail: [
        { address: "mail.read", classification: "read" },
        { address: "mail.send", classification: "write" },
      ],
      notes: [{ address: "notes.query", classification: "read" }],
      calendar: [{ address: "calendar.list", classification: "read" }],
    };
    // What each member's own partition can list: a connector that is not
    // connected there lists nothing.
    const catalog = (connected: Array<keyof typeof tools>) => connected.flatMap((id) => tools[id]);
    const mail: MemberPartition = {
      connection: { state: "auth_required", problem: "oauth_required" },
      manage: { kind: "oauth", actions: ["connect", "restart", "disconnect"] },
    };
    const calendarPartition: MemberPartition = {
      connection: { state: "ok" },
      manage: { kind: "oauth", actions: ["disconnect"] },
    };
    const bob = await read(send, "bob");
    expectMemberViewWithholds(
      bob,
      memberViewExpectation({
        member: { namespace: NAMESPACE, id: "bob" },
        pools,
        connectors,
        catalog: catalog(["wiki", "notes", "calendar"]),
        personal: {
          mail,
          // Stored in Bob's partition, in the declared shape, with testCredentials.
          notes: { connection: { state: "ok" }, manage: notesManage(["save", "test", "clear"]) },
          calendar: calendarPartition,
        },
      }),
    );
    const lin = await read(send, "lin");
    expectMemberViewWithholds(
      lin,
      memberViewExpectation({
        member: { namespace: NAMESPACE, id: "lin" },
        pools,
        connectors,
        catalog: catalog(["wiki", "calendar"]),
        personal: {
          mail,
          // Nothing stored in Lin's partition: save alone.
          notes: {
            connection: { state: "credential_required", problem: "credential_required" },
            manage: notesManage(["save"]),
          },
          calendar: calendarPartition,
        },
      }),
    );
    const carol = await read(send, "carol");
    expectMemberViewWithholds(
      carol,
      memberViewExpectation({
        member: { namespace: NAMESPACE, id: "carol" },
        pools,
        connectors,
        catalog: catalog(["wiki"]),
        personal: {},
      }),
    );
    // The projection covers every kind the decision record names.
    expect(bob.connectors.map((c) => `${c.id}:${c.authScope}:${c.manage.kind}`)).toEqual([
      "wiki:shared:none",
      "mail:personal:oauth",
      "notes:personal:credential",
      "calendar:personal:oauth",
    ]);
    // A member never reads another member, an owner, an agent, or a secret.
    const body = JSON.stringify([bob, lin, carol]);
    for (const absent of ["team@example.com", '"bot"', '"gone"', "alice", "secret-notes-token", "acme", "lastFour"])
      expect(body, absent).not.toContain(absent);
    expect(JSON.stringify(lin)).not.toContain('"bob"');
    // Carol's pool serves "hidden"; Bob's and Lin's does not.
    expect(JSON.stringify([bob, lin])).not.toContain("hidden");
  });

  it("INV-4 INV-5: without a vault a member is offered no credential action", async () => {
    const { send } = await team({ vault: false });
    const bob = await read(send, "bob");
    expect(bob.connectors.find((c) => c.id === "notes")?.manage).toEqual({ kind: "none" });
    // OAuth connect needs a signing vault too; disconnect does not.
    expect(bob.connectors.find((c) => c.id === "mail")?.manage).toEqual({ kind: "oauth", actions: ["disconnect"] });
  });

  it("INV-4: a non-interactive member manages nothing", async () => {
    const app = deploy({
      connectors: [oauthConnector("mail", "personal")],
      auth: [people(), machineAuth("machine", { subjectId: "worker" })],
      maintainers: ["alice"],
      pools: { team: { tools: ["mail"], members: [{ namespace: TEST_MACHINE_NAMESPACE, id: "worker" }] } },
      storage: memoryStorage(),
    });
    const view = await read(sender(app), "machine");
    expect(view.role).toBe("member");
    expect(view.you.interactive).toBe(false);
    expect(view.connectors[0]?.manage).toEqual({ kind: "none" });
  });

  it("INV-4: a disconnect-only connector disconnects through its route and refuses connect", async () => {
    const { send } = await team();
    expect((await send("bob", "/ui/oauth/calendar?mode=continue", { method: "POST" })).status).toBe(404);
    expect(disconnects).toEqual([]);
    const dropped = await send("bob", "/ui/oauth/calendar", { method: "DELETE" });
    expect(dropped.status).toBe(204);
    expect(disconnects).toEqual(["calendar"]);
    // A full OAuth connector still connects.
    const connect = await send("bob", "/ui/oauth/mail?mode=continue", { method: "POST" });
    expect(connect.status).toBe(200);
    expect(await connect.json()).toMatchObject({ state: "auth_required" });
  });

  it("INV-4 INV-5: the maintainer sees owners, labelled people, every agent and the whole matrix; a member sees no owner", async () => {
    const { send } = await team();
    const alice = await read(send, "alice");
    expect(alice.root).toEqual({
      path: "/mcp",
      readOnly: false,
      maintainers: [
        { kind: "human", namespace: NAMESPACE, id: "alice", label: "Alice Example" },
        { kind: "human", namespace: TEST_MACHINE_NAMESPACE, id: "machine", label: null },
      ],
    });
    expect(alice.pools).toEqual([
      {
        name: "team",
        humanPath: "/mcp/team",
        agentPath: "/agent/team",
        readOnly: false,
        owner: "team@example.com",
        tools: [
          { connectorId: "wiki", tools: [{ name: "read", requireReadOnly: false }] },
          { connectorId: "mail", tools: "all" },
          { connectorId: "notes", tools: "all" },
          { connectorId: "calendar", tools: "all" },
        ],
        members: [
          { kind: "human", namespace: NAMESPACE, id: "bob", label: "Bob Example" },
          // No directory entry: null, never the id.
          { kind: "human", namespace: NAMESPACE, id: "lin", label: null },
          { kind: "agent", name: "bot" },
        ],
      },
      {
        name: "ops",
        humanPath: "/mcp/ops",
        agentPath: "/agent/ops",
        readOnly: false,
        owner: null,
        tools: [
          { connectorId: "wiki", tools: "all" },
          { connectorId: "hidden", tools: "all" },
        ],
        members: [
          { kind: "human", namespace: NAMESPACE, id: "carol", label: null },
          { kind: "agent", name: "gone" },
        ],
      },
    ]);
    expect(alice.agents.map((agent) => [agent.name, agent.pools])).toEqual([
      ["bot", ["team"]],
      ["idle", []],
      ["gone", ["ops"]],
    ]);
    expect(alice.connectors).toEqual([]);
    expect(alice.live.connectors.map((c) => c.id)).toEqual(["wiki", "mail", "notes", "calendar", "hidden"]);
    expect(alice.matrix.map((cell) => [cell.connectorId, cell.pool, cell.tools])).toEqual([
      ["wiki", null, "all"],
      ["wiki", "team", ["read"]],
      ["wiki", "ops", "all"],
      ["mail", null, "all"],
      ["mail", "team", "all"],
      ["notes", null, "all"],
      ["notes", "team", "all"],
      ["calendar", null, "all"],
      ["calendar", "team", "all"],
      ["hidden", null, "all"],
      ["hidden", "ops", "all"],
    ]);
    // A machine maintainer's read is not interactive, so it carries no directory label.
    const machine = await read(send, "machine");
    expect(machine.root?.maintainers.map((m) => m.kind === "human" && m.label)).toEqual([null, null]);
    // The same pool, read by a member: no owner and no members.
    expect((await read(send, "bob")).pools.find((pool) => pool.name === "team")).toMatchObject({
      owner: null,
      members: [],
    });
  });

  it("INV-4: maintainer agents[] lists every declared agent and matches GET /ui/access-tokens field by field", async () => {
    const at = "2026-10-08T12:00:00.000Z";
    const { send } = await team({
      activity: [
        {
          schemaVersion: 1,
          id: "bot-call",
          requestId: "r1",
          occurredAt: at,
          actor: { kind: "access_token", id: "bot", namespace: AGENT_NAMESPACE },
          connectorId: "wiki",
          toolName: "read",
          address: "wiki.read",
          source: "call_tool",
          outcome: "success",
          durationMs: 1,
          attempts: 1,
          serverName: "test",
          serverVersion: "1",
          pool: "team",
        },
        // Later, but on a tool the pool it was recorded in does not grant: not visible, so not seen.
        {
          schemaVersion: 1,
          id: "bot-hidden",
          requestId: "r2",
          occurredAt: "2026-10-09T12:00:00.000Z",
          actor: { kind: "access_token", id: "bot", namespace: AGENT_NAMESPACE },
          connectorId: "wiki",
          toolName: "edit",
          address: "wiki.edit",
          source: "call_tool",
          outcome: "success",
          durationMs: 1,
          attempts: 1,
          serverName: "test",
          serverVersion: "1",
          pool: "team",
        },
      ],
    });
    const list = async () =>
      (
        (await (await send("alice", "/ui/access-tokens")).json()) as {
          agents: Array<{ name: string; revision: string }>;
        }
      ).agents;
    const revision = async (name: string) => (await list()).find((agent) => agent.name === name)!.revision;
    for (const name of ["bot", "gone"]) {
      const issued = await send("alice", `/ui/access-tokens/${name}`, {
        method: "POST",
        body: JSON.stringify({ expect: await revision(name) }),
      });
      expect(issued.status, name).toBe(200);
    }
    const revoked = await send("alice", "/ui/access-tokens/gone", {
      method: "DELETE",
      body: JSON.stringify({ expect: await revision("gone") }),
    });
    expect(revoked.status).toBe(200);
    const slots = await list();
    const alice = await read(send, "alice");
    expect(alice.agents.map(({ name, token }) => ({ name, ...token }))).toEqual(slots);
    expect(alice.agents.map((agent) => agent.token.state)).toEqual(["issued", "none", "revoked"]);
    expect(alice.agents.map((agent) => [agent.name, agent.lastSeenAt])).toEqual([
      ["bot", at],
      ["idle", null],
      ["gone", null],
    ]);
    expect(alice.live.activity).toBe("available");
    // Without activity, nobody has been seen.
    const quiet = await team();
    const view = await read(quiet.send, "alice");
    expect(view.live.activity).toBe("unconfigured");
    expect(view.agents.map((agent) => agent.lastSeenAt)).toEqual([null, null, null]);
  });

  it("INV-4 INV-5 INV-6: matrix runsAs covers every variant, from real config", async () => {
    const storage = memoryStorage();
    const vault = encryptedCredentialVault(storage, KEY);
    const open = Object.assign(remoteMcp("open_mcp", { url: "https://open.example/mcp" }), {
      status: async () => ({ state: "ok" as const }),
      listTools: async () => [],
    });
    const app = deploy({
      connectors: [
        api("vaulted", { credential: { label: "API key" }, tools: [] }),
        api("slot", { credential: { label: "API key" }, tools: [] }),
        oauthConnector("needs_grant", "shared"),
        oauthConnector("granted", "shared", true),
        open,
        api("coded", { tools: [] }),
        notes(),
        gmail("gmail", { purpose: "Mail", serviceAccount: SERVICE_ACCOUNT, subject: () => undefined }),
        drive("drive", { purpose: "Files", serviceAccount: SERVICE_ACCOUNT, subject: "shared@example.com" }),
      ],
      auth: people(),
      maintainers: ["alice"],
      pools: {
        owned: { tools: ["gmail", "notes"], owner: "owner@example.com", members: ["bob", "lin"] },
        group: { tools: ["gmail", "drive.search_files"], members: ["bob"] },
      },
      storage,
      vault,
    });
    const saved = await vault.set("vaulted", "secret-api-key", "alice");
    await vault.setAll("notes", { workspace: "acme", token: "secret-notes-token" }, "bob", await principalKey("bob"));
    const view = await read(sender(app), "alice");
    const cell = (id: string, pool: string | null = null) =>
      view.matrix.find((c) => c.connectorId === id && c.pool === pool)?.runsAs;
    expect(cell("vaulted")).toEqual({ kind: "shared", source: "vault", savedAt: saved.updatedAt });
    expect(cell("slot")).toEqual({ kind: "shared", source: "missing", savedAt: null });
    expect(cell("needs_grant")).toEqual({ kind: "shared", source: "missing", savedAt: null });
    expect(cell("granted")).toEqual({ kind: "shared", source: "oauth", savedAt: null });
    expect(cell("open_mcp")).toEqual({ kind: "shared", source: "unauthenticated", savedAt: null });
    expect(cell("coded")).toEqual({ kind: "shared", source: "config", savedAt: null });
    // Bob saved Notes; Lin did not; alice, the only maintainer, did not.
    expect(cell("notes", "owned")).toEqual({ kind: "personal", connectedMembers: 1, members: 2 });
    expect(cell("notes")).toEqual({ kind: "personal", connectedMembers: 0, members: 1 });
    // A subject mapping: humans act as themselves, agents as the pool owner, none at plain /mcp.
    expect(cell("gmail")).toEqual({ kind: "workspace", humans: "self", agents: null });
    expect(cell("gmail", "owned")).toEqual({ kind: "workspace", humans: "self", agents: "owner@example.com" });
    expect(cell("gmail", "group")).toEqual({ kind: "workspace", humans: "self", agents: null });
    // A fixed subject: every caller acts as it, in every column.
    expect(cell("drive")).toEqual({ kind: "workspaceFixed", subject: "shared@example.com" });
    expect(cell("drive", "group")).toEqual({ kind: "workspaceFixed", subject: "shared@example.com" });
    expect(view.matrix.find((c) => c.connectorId === "drive" && c.pool === "group")?.tools).toEqual(["search_files"]);
    const body = JSON.stringify(view);
    for (const secret of ["secret-api-key", "secret-notes-token", "acme", SERVICE_ACCOUNT.privateKey])
      expect(body).not.toContain(secret);
  });
});
