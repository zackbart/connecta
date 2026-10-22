// Operator contract v2 as the server serves it (#837 P6b,
// decisions/0006-pools-are-the-access-model.md). Every member assertion runs
// against a real `GET /ui/api/config` body, checked by
// `expectMemberViewWithholds` against a projection built from config,
// membership and each member's own partition, never from the response.
import { afterEach, describe, expect, it } from "vitest";
import { accessTokens } from "../src/access-tokens.js";
import { activityHistory, type ToolCallActivityEvent } from "../src/activity.js";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import type { DescribedMember } from "../src/describe-config.js";
import { identityStorageKey } from "../src/identity.js";
import type { ConnectaConfig } from "../src/index.js";
import type {
  OperatorGrant,
  OperatorMember,
  OperatorMemberManage,
  OperatorPoolV2,
  OperatorUiContract,
} from "../src/operator-ui/contract.js";
import { drive } from "../src/providers/drive/index.js";
import { gmail } from "../src/providers/gmail/index.js";
import { accessTokenKeys } from "../src/storage/keys.js";
import { memoryStorage } from "../src/storage/memory.js";
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

/** Provisioned out of band: it can drop its grant but never start one. */
const calendar: Connector = {
  id: "calendar",
  authScope: "personal",
  listTools: async () => [{ name: "list", ...READ }],
  callTool: async () => null,
  status: async () => ({ state: "ok" }),
  disconnectAuth: async () => {},
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

type Vault = ReturnType<typeof encryptedCredentialVault>;

/** The same vault with its metadata read replaced, as a stalled or failing store would answer. */
function withMetadata(vault: Vault, metadata: Vault["metadata"]): Vault {
  return new Proxy(vault, {
    get(target, key) {
      if (key === "metadata") return metadata;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A read that never settles. */
const stalled = () => new Promise<never>(() => {});

/** The team deployment: one pool of each kind of connector a member can see. */
async function team(
  options: {
    activity?: ToolCallActivityEvent[];
    storage?: KVStorage;
    probeTimeoutMs?: number;
  } = {},
) {
  const storage: KVStorage = options.storage ?? memoryStorage();
  const vault = encryptedCredentialVault(storage, KEY);
  const app = deploy({
    ...(options.probeTimeoutMs ? { discovery: { probeTimeoutMs: options.probeTimeoutMs } } : {}),
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
    vault,
  });
  // Bob has saved his Notes credential in his own partition; Lin has not.
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

  it("INV-7: a stalled vault never hangs the maintainer matrix; its cells read conservatively", async () => {
    const storage = memoryStorage();
    const vault = encryptedCredentialVault(storage, KEY);
    const app = deploy({
      connectors: [api("vaulted", { credential: { label: "API key" }, tools: [] }), notes()],
      auth: people(),
      maintainers: ["alice"],
      pools: { owned: { tools: ["notes"], members: ["bob"] } },
      discovery: { probeTimeoutMs: 100 },
      storage,
      vault: withMetadata(vault, stalled),
    });
    await vault.set("vaulted", "secret-api-key", "alice");
    await vault.setAll("notes", { workspace: "acme", token: "secret-notes-token" }, "bob", await principalKey("bob"));
    const started = Date.now();
    const view = await read(sender(app), "alice");
    expect(Date.now() - started).toBeLessThan(3_000);
    const cell = (id: string, pool: string | null = null) =>
      view.matrix.find((c) => c.connectorId === id && c.pool === pool)?.runsAs;
    // Saved values the stalled vault cannot confirm are claimed by nobody.
    expect(cell("vaulted")).toEqual({ kind: "shared", source: "missing", savedAt: null });
    expect(cell("notes", "owned")).toEqual({ kind: "personal", connectedMembers: 0, members: 1 });
  });

  it("INV-4 INV-7: a failed or stalled token slot read answers the maintainer 503, never a partial agents list", async () => {
    for (const mode of ["fails", "stalls"] as const) {
      const memory = memoryStorage();
      let broken = false;
      const slot = accessTokenKeys.agent("bot");
      const storage: KVStorage = {
        ...memory,
        capabilities: memory.capabilities,
        get: (key) =>
          broken && key === slot
            ? mode === "fails"
              ? Promise.reject(new Error("SENTINEL-storage"))
              : stalled()
            : memory.get(key),
        set: (key, value, options) => memory.set(key, value, options),
        delete: (key) => memory.delete(key),
        list: (prefix) => memory.list(prefix),
        compareAndSet: (key, expected, next, options) => memory.compareAndSet(key, expected, next, options),
      };
      const { send } = await team({ storage, probeTimeoutMs: 100 });
      broken = true;
      const response = await send("alice", "/ui/api/config");
      expect(response.status, mode).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "agent token slots could not be read" });
      // A member's view reads no slot.
      expect((await send("bob", "/ui/api/config")).status).toBe(200);
    }
  });

  it("INV-4 INV-5: the routes accept exactly the actions manage lists, for every kind", async () => {
    const { send, vault } = await team();
    const bob = await read(send, "bob");
    const manage = (id: string) => bob.connectors.find((c) => c.id === id)!.manage;
    const json = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body) });
    const notesValues = { values: { workspace: "acme", token: "secret-notes-token-2" } };
    // Lin's partition is empty: save is listed, test and clear are not.
    const lin = await read(send, "lin");
    expect(lin.connectors.find((c) => c.id === "notes")!.manage).toMatchObject({ actions: ["save"] });
    const clearEmpty = await send("lin", "/ui/credentials/notes", { method: "DELETE" });
    expect(clearEmpty.status).toBe(409);
    expect(await clearEmpty.json()).toEqual({
      error: "no credential is stored to clear",
      problem: "credential_required",
    });
    const testEmpty = await send("lin", "/ui/credentials/notes/test", { method: "POST" });
    expect(testEmpty.status).toBe(409);
    expect(await testEmpty.json()).toMatchObject({ problem: "credential_required" });
    expect((await send("lin", "/ui/credentials/notes", json(notesValues))).status).toBe(200);
    // Bob's partition holds a value: save, test and clear are all listed and all succeed.
    expect(manage("notes")).toMatchObject({ actions: ["save", "test", "clear"] });
    expect((await send("bob", "/ui/credentials/notes", json(notesValues))).status).toBe(200);
    const tested = await send("bob", "/ui/credentials/notes/test", { method: "POST" });
    expect(tested.status).toBe(200);
    expect(await tested.json()).toEqual({ ok: true });
    expect((await send("bob", "/ui/credentials/notes", { method: "DELETE" })).status).toBe(204);
    expect(await vault.metadata("notes", await principalKey("bob"))).toBeNull();
    // Full OAuth: connect, restart and disconnect all succeed.
    expect(manage("mail")).toEqual({ kind: "oauth", actions: ["connect", "restart", "disconnect"] });
    expect((await send("bob", "/ui/oauth/mail?mode=continue", { method: "POST" })).status).toBe(200);
    expect((await send("bob", "/ui/oauth/mail?mode=restart", { method: "POST" })).status).toBe(200);
    expect((await send("bob", "/ui/oauth/mail", { method: "DELETE" })).status).toBe(204);
    // Disconnect-only: disconnect succeeds, connect and restart are refused.
    expect(manage("calendar")).toEqual({ kind: "oauth", actions: ["disconnect"] });
    expect((await send("bob", "/ui/oauth/calendar?mode=continue", { method: "POST" })).status).toBe(404);
    expect((await send("bob", "/ui/oauth/calendar?mode=restart", { method: "POST" })).status).toBe(404);
    expect((await send("bob", "/ui/oauth/calendar", { method: "DELETE" })).status).toBe(204);
    // None (shared): every write is refused.
    expect(manage("wiki")).toEqual({ kind: "none" });
    expect((await send("bob", "/ui/credentials/wiki", json({ value: "x" }))).status).toBe(404);
    expect((await send("bob", "/ui/oauth/wiki?mode=continue", { method: "POST" })).status).toBe(404);
    expect((await send("bob", "/ui/oauth/wiki", { method: "DELETE" })).status).toBe(404);
  });
});
