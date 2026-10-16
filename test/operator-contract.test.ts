import { afterEach, describe, expect, it } from "vitest";
import { activityHistory, type ToolCallActivityEvent } from "../src/activity.js";
import { TEST_MACHINE_NAMESPACE, machineAuth } from "./helpers/machine-auth.js";
import { createConnecta, customExecutor, type Connector, type InboundAuth } from "../src/index.js";
import { operatorUi, type OperatorUiContract } from "../src/ui.js";
import type { ConnectaConfigDescription } from "../src/describe-config.js";
import { memoryStorage } from "../src/storage/memory.js";
import { SECRETS, VAULT_KEY, secretBearingDeployment } from "./fixtures/describe-config.js";

const BASE = "https://connecta.example";
const executor = customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });
const apps: Array<ReturnType<typeof createConnecta>> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
function deployment(config: Parameters<typeof createConnecta>[0]) {
  const app = createConnecta(config);
  apps.push(app);
  return app;
}
const human: InboundAuth = {
  kind: "human",
  interactiveOperator: true,
  activityActorNamespace: "directory",
  authorize: (request) => ({ ok: true, userId: request.headers.get("X-User") ?? "alice" }),
};
/** Operator routes serve maintainers only (#837); alice is one, in `human`'s namespace. */
const maintainers = ["alice"];
const tools = [
  { name: "read", description: "Read metadata", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "write" },
];
function connector(
  id: string,
  extra: Partial<Omit<Connector, "staticTools">> & { staticTools?: Connector["staticTools"] | null } = {},
): Connector {
  const { staticTools = tools, ...rest } = extra;
  return {
    id,
    ...(staticTools ? { staticTools } : {}),
    listTools: async () => tools,
    callTool: async () => null,
    ...rest,
  };
}
/** A maintainer's view, whose config and root are always present. */
type MaintainerView = OperatorUiContract & {
  config: ConnectaConfigDescription;
  root: NonNullable<OperatorUiContract["root"]>;
};
async function read(app: ReturnType<typeof createConnecta>, headers?: HeadersInit) {
  const response = await app.fetch(new Request(`${BASE}/ui/api/config`, headers ? { headers } : undefined));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = (await response.json()) as OperatorUiContract;
  expect(body).toMatchObject({ schemaVersion: 2, role: "maintainer" });
  return body as MaintainerView;
}

describe("operator config contract", () => {
  it("INV-4 INV-10: a connector-filtered config read probes and discloses only the admitted connector", async () => {
    const probes: string[] = [];
    const app = deployment({
      connectors: ["selected", "unrelated", "hidden"].map((id) =>
        connector(id, {
          status: async () => {
            probes.push(id);
            return { state: "ok" };
          },
        }),
      ),
      executor,
      readOnly: true,
      auth: human,
      ui: operatorUi(),
      logger: "silent",
      classification: { selected: { read: "read" }, unrelated: { read: "read" } },
      pools: { shared: { tools: ["selected", "unrelated", "hidden"], members: ["alice"] } },
      maintainers,
    });
    const response = await app.fetch(new Request(`${BASE}/ui/api/config?connector=selected`));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as MaintainerView;
    expect(body.config.connectors.map(({ id }) => id)).toEqual(["selected"]);
    expect(body.live.connectors.map(({ id }) => id)).toEqual(["selected"]);
    expect(body.matrix.map(({ connectorId, pool }) => [connectorId, pool])).toEqual([
      ["selected", null],
      ["selected", "shared"],
    ]);
    expect(probes).toEqual(["selected"]);
    // Pools list their declared tools whole; everything else names only the selected connector.
    expect(JSON.stringify({ ...body, pools: [] })).not.toMatch(/unrelated|hidden/);
    for (const id of ["missing"]) {
      const refused = await app.fetch(new Request(`${BASE}/ui/api/config?connector=${id}`));
      expect(refused.status).toBe(404);
      expect(refused.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(probes).toEqual(["selected"]);
  });

  it("INV-5 INV-6: reuses the config sentinel set and excludes secrets, raw status, and credential metadata", async () => {
    const { config, vault, storage } = secretBearingDeployment();
    await vault.set("vaulted_mcp", SECRETS.storedCredential, "operator");
    await storage.set("access-token:sentinel", SECRETS.storedAccessToken);
    // Preserve every secret-bearing config position. A local status seam
    // avoids outbound calls while also trying to publish a secret in status.
    for (const c of config.connectors)
      c.status = async () => ({
        state: "error",
        message: SECRETS.headerValue,
        authorizationUrl: SECRETS.storedAccessToken,
      });
    const app = deployment(config);
    const data = await read(app, { Authorization: `Bearer ${SECRETS.machineToken}` });
    const json = JSON.stringify(data);
    for (const [position, secret] of Object.entries(SECRETS)) expect(json, position).not.toContain(secret);
    expect(json).not.toContain(VAULT_KEY);
    expect(json).not.toContain("lastFour");
    expect(json).not.toContain("SENTINEL");
    expect(data.config).toEqual(app.describeConfig());
    expect(data.you.interactive).toBe(false);
    // The machine operator is a maintainer: plain /mcp serves every connector whole, and every pool is listed.
    const root = data.matrix.filter((cell) => cell.pool === null);
    expect(root.every((cell) => cell.tools === "all")).toBe(true);
    expect(root.map((cell) => cell.connectorId)).toEqual(app.describeConfig().connectors.map((c) => c.id));
    expect(data.pools).toMatchObject([
      {
        name: "support",
        humanPath: "/mcp/support",
        agentPath: "/agent/support",
        readOnly: false,
        tools: [{ connectorId: "static_api", tools: "all" }],
      },
    ]);
  });

  it("INV-5: serves pool owner addresses only to an authenticated maintainer, never to an open deployment's anonymous caller", async () => {
    const pools = {
      mine: { tools: ["shared"], owner: "alice@example.com", members: [{ namespace: "directory", id: "alice" }] },
      group: { tools: ["shared"], members: [{ namespace: "directory", id: "bob" }] },
    };
    const open = deployment({
      connectors: [connector("shared")],
      executor,
      ui: operatorUi(),
      logger: "silent",
      readOnly: true,
      pools,
    });
    const anonymous = await read(open);
    expect(anonymous.config.pools.map((pool) => [pool.name, pool.owner])).toEqual([
      ["mine", null],
      ["group", null],
    ]);
    expect(anonymous.pools.map((pool) => [pool.name, pool.owner])).toEqual([
      ["mine", null],
      ["group", null],
    ]);
    expect(JSON.stringify(anonymous)).not.toContain("alice@example.com");
    // The local snapshot is the deployment's own and stays whole.
    expect(open.describeConfig().pools[0]?.owner).toBe("alice@example.com");

    const authenticated = deployment({
      connectors: [connector("shared")],
      executor,
      auth: human,
      maintainers,
      ui: operatorUi(),
      logger: "silent",
      readOnly: true,
      pools,
    });
    const maintainer = await read(authenticated);
    expect(maintainer.config.pools.map((pool) => [pool.name, pool.owner])).toEqual([
      ["mine", "alice@example.com"],
      ["group", null],
    ]);
    expect(maintainer.pools.map((pool) => [pool.name, pool.owner])).toEqual([
      ["mine", "alice@example.com"],
      ["group", null],
    ]);
  });

  it("INV-4: shows a maintainer every connector, tool, and pool, and refuses everyone else", async () => {
    const app = deployment({
      connectors: [connector("shared"), connector("personal", { authScope: "personal" }), connector("hidden")],
      executor,
      auth: human,
      maintainers,
      ui: operatorUi(),
      logger: "silent",
      classification: { shared: { read: "read", write: "write" }, hidden: { read: "read" } },
      readOnly: true,
      pools: {
        support: { tools: ["shared", "hidden"], readOnly: false, members: ["bob"] },
        reader: { tools: ["shared.read"], members: ["alice"] },
      },
    });
    const alice = await read(app);
    expect(alice.config).not.toHaveProperty("hasGrant");
    expect(alice.config.maintainers).toEqual([{ namespace: "directory", id: "alice" }]);
    expect(alice.config.connectors.map((c) => c.id)).toEqual(["shared", "personal", "hidden"]);
    expect(alice.config.connectors[0]?.tools?.map((t) => t.name)).toEqual(["read", "write"]);
    expect(alice.config.classification).toEqual({ shared: { read: "read", write: "write" }, hidden: { read: "read" } });
    expect(alice.config.pools).toEqual([
      {
        name: "support",
        path: "/mcp/support",
        tools: ["shared", "hidden"],
        members: [{ kind: "human", namespace: "directory", id: "bob" }],
        readOnly: false,
        owner: null,
      },
      {
        name: "reader",
        path: "/mcp/reader",
        tools: ["shared.read"],
        members: [{ kind: "human", namespace: "directory", id: "alice" }],
        readOnly: true,
        owner: null,
      },
    ]);
    expect(alice.live.connectors[0]?.tools.map((t) => [t.address, t.classification])).toEqual([
      ["shared.read", "read"],
      ["shared.write", "write"],
    ]);
    expect(alice.root).toEqual({
      path: "/mcp",
      readOnly: true,
      maintainers: [{ kind: "human", namespace: "directory", id: "alice", label: null }],
    });
    // Every declared pool with exactly its declared tools; guarded grants
    // are gone, so requireReadOnly is always false.
    expect(alice.pools).toEqual([
      {
        name: "support",
        humanPath: "/mcp/support",
        agentPath: "/agent/support",
        readOnly: false,
        owner: null,
        tools: [
          { connectorId: "shared", tools: "all" },
          { connectorId: "hidden", tools: "all" },
        ],
        members: [{ kind: "human", namespace: "directory", id: "bob", label: null }],
      },
      {
        name: "reader",
        humanPath: "/mcp/reader",
        agentPath: "/agent/reader",
        readOnly: true,
        owner: null,
        tools: [{ connectorId: "shared", tools: [{ name: "read", requireReadOnly: false }] }],
        members: [{ kind: "human", namespace: "directory", id: "alice", label: null }],
      },
    ]);
    expect(alice.matrix.map(({ connectorId, pool, tools }) => [connectorId, pool, tools])).toEqual([
      ["shared", null, "all"],
      ["shared", "support", "all"],
      ["shared", "reader", ["read"]],
      ["personal", null, "all"],
      ["hidden", null, "all"],
      ["hidden", "support", "all"],
    ]);
    expect(alice.connectors).toEqual([]);
    // Bob is a pool member, not a maintainer: his own member view (#837).
    const bob = await app.fetch(new Request(`${BASE}/ui/api/config`, { headers: { "X-User": "bob" } }));
    expect(bob.status).toBe(200);
    expect(await bob.json()).toMatchObject({ role: "member", config: null, root: null, matrix: [] });
    // Neither a maintainer nor a member: the private 404.
    const carol = await app.fetch(new Request(`${BASE}/ui/api/config`, { headers: { "X-User": "carol" } }));
    expect(carol.status).toBe(404);
    expect(carol.headers.get("Cache-Control")).toBe("no-store");
    expect(await carol.json()).toEqual({ error: "not found" });
    expect(app.describeConfig().connectors).toHaveLength(3);
  });

  it("INV-1 INV-6: allows catalog descriptions and schemas, withholds invalid names, and uses registry classification", async () => {
    const listing = [
      {
        name: "safe",
        description: "Authenticated catalog text",
        inputSchema: { type: "object", description: "schema text" },
        outputSchema: { type: "string" },
        annotations: { readOnlyHint: true },
        arbitrarySecret: "SENTINEL-extra",
      },
      { name: "space SENTINEL-name", description: "Allowed description", inputSchema: { type: "object" } },
      { name: "SENTINEL\ncontrol", description: "Dropped at intake" },
      { name: "contradiction", annotations: { readOnlyHint: true, destructiveHint: true } },
    ];
    const app = deployment({
      readOnly: false,
      connectors: [
        connector("svc", {
          staticTools: null,
          listTools: async () => listing,
          status: async () => ({ state: "ok", message: "SENTINEL-status" }),
        }),
      ],
      executor,
      auth: human,
      maintainers,
      ui: operatorUi(),
      logger: "silent",
      classification: { svc: { safe: "write" } },
    });
    const data = await read(app);
    expect(data.live.connectors[0]?.tools).toEqual([
      {
        name: "safe",
        address: "svc.safe",
        description: "Authenticated catalog text",
        inputSchema: { type: "object", description: "schema text" },
        outputSchema: { type: "string" },
        annotations: { readOnlyHint: false, destructiveHint: true },
        classification: "write",
      },
      {
        name: "<withheld>",
        address: "svc.<withheld>",
        description: "Allowed description",
        inputSchema: { type: "object" },
        classification: "write",
      },
      {
        name: "contradiction",
        address: "svc.contradiction",
        annotations: { readOnlyHint: true, destructiveHint: true },
        classification: "write",
      },
    ]);
    expect(JSON.stringify(data)).not.toContain("SENTINEL");
    expect(data.live.connectors[0]?.catalogAgeMs).toBeGreaterThanOrEqual(0);
  });

  it("INV-10: catalog age reports completed observations and static catalogs have no age", async () => {
    const storage = memoryStorage();
    const app = deployment({
      readOnly: false,
      connectors: [
        connector("things", { staticTools: null, status: async () => ({ state: "ok" }), listTools: async () => tools }),
        connector("static"),
      ],
      storage,
      executor,
      auth: human,
      maintainers,
      ui: operatorUi(),
      logger: "silent",
    });
    const data = await read(app);
    expect(data.live.connectors[0]?.catalogAgeMs).toBeGreaterThanOrEqual(0);
    expect(data.live.connectors[1]?.catalogAgeMs).toBeNull();
  });

  it("INV-6 INV-4: last call includes only validated time/outcome from visible tools and the personal owner", async () => {
    const event = (connectorId: string, toolName: string, occurredAt: string, extra: Record<string, unknown> = {}) =>
      ({
        connectorId,
        toolName,
        occurredAt,
        outcome: "success",
        actor: { kind: "human", id: "alice", namespace: "directory" },
        ...extra,
      }) as unknown as ToolCallActivityEvent;
    const app = deployment({
      readOnly: false,
      connectors: [connector("svc"), connector("personal", { authScope: "personal" })],
      executor,
      auth: human,
      maintainers,
      ui: operatorUi(),
      logger: "silent",
      pools: { reader: { tools: ["svc.read"], members: ["alice"] } },
      activity: activityHistory({
        store: {
          record() {},
          list: async () => ({
            events: [
              // Outside the tools the pool it was recorded in declares.
              event("svc", "write", "2026-10-08T01:03:00.000Z", { pool: "reader" }),
              // Recorded in a pool that is no longer declared.
              event("svc", "read", "2026-10-08T01:04:00.000Z", { pool: "retired" }),
              event("svc", "read", "SENTINEL-time"),
              event("svc", "read", "2026-10-08T01:02:00.000Z", { outcome: "SENTINEL-outcome" }),
              event("svc", "read", "2026-10-08T01:01:00.000Z", {
                arguments: "SENTINEL-args",
                result: "SENTINEL-result",
                errorCode: "SENTINEL-error",
                outcome: "timeout",
              }),
              event("personal", "read", "2026-10-08T01:02:00.000Z", {
                actorBasis: "principal",
                actor: { kind: "human", id: "bob", namespace: "directory" },
              }),
              event("personal", "read", "2026-10-08T01:01:00.000Z"), // Legacy subject actor does not prove ownership.
              event("personal", "read", "2026-10-08T01:00:00.000Z", { actorBasis: "principal" }),
            ],
          }),
        },
      }),
    });
    const data = await read(app);
    expect(data.live.connectors.map((c) => c.lastCall)).toEqual([
      { at: "2026-10-08T01:01:00.000Z", outcome: "timeout" },
      { at: "2026-10-08T01:00:00.000Z", outcome: "success" },
    ]);
    expect(data.live.activity).toBe("available");
    expect(JSON.stringify(data)).not.toContain("SENTINEL");
  });

  it.each(["forbidden", "gate_throws", "unavailable", "machine", "unconfigured"])(
    "INV-4 INV-6: handles %s activity without widening access or returning errors",
    async (mode) => {
      let calls = 0;
      const app = deployment({
        readOnly: false,
        connectors: [connector("svc")],
        executor,
        auth: mode === "machine" ? machineAuth("token") : human,
        maintainers: mode === "machine" ? [{ namespace: TEST_MACHINE_NAMESPACE, id: "machine" }] : maintainers,
        ui: operatorUi(),
        logger: "silent",
        ...(mode === "unconfigured"
          ? {}
          : {
              activity: activityHistory({
                readGate: () => {
                  if (mode === "gate_throws") throw new Error("SENTINEL-gate");
                  return mode !== "forbidden";
                },
                store: {
                  record() {},
                  list: async () => {
                    calls++;
                    throw new Error("SENTINEL-store");
                  },
                },
              }),
            }),
      });
      const data = await read(app, { Authorization: "Bearer token" });
      // A non-interactive maintainer principal reads activity too (#837), so
      // its failing store is unavailable, never a wider view.
      const reads = mode === "unavailable" || mode === "machine";
      expect(data.live.activity).toBe(mode === "gate_throws" ? "forbidden" : reads ? "unavailable" : mode);
      expect(data.live.connectors[0]?.lastCall).toBeNull();
      expect(calls).toBe(reads ? 1 : 0);
      expect(JSON.stringify(data)).not.toContain("SENTINEL");
    },
  );

  it("INV-4 INV-10: preserves the data-route auth challenge, rejects mutations, and requires the UI module", async () => {
    const app = deployment({
      readOnly: false,
      connectors: [],
      executor,
      auth: machineAuth("token"),
      maintainers: [{ namespace: TEST_MACHINE_NAMESPACE, id: "machine" }],
      ui: operatorUi(),
      logger: "silent",
    });
    const response = await app.fetch(new Request(`${BASE}/ui/api/config`));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    for (const method of ["POST", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const refusal = await app.fetch(new Request(`${BASE}/ui/api/config`, { method }));
      expect(refusal.status).toBe(405);
    }
    const noUi = deployment({ readOnly: false, connectors: [], executor, logger: "silent" });
    expect((await noUi.fetch(new Request(`${BASE}/ui/api/config`))).status).toBe(404);
  });

  it("INV-6: status and catalog failures are closed problem codes, and authorization hooks never run", async () => {
    let starts = 0;
    const app = deployment({
      readOnly: false,
      connectors: [
        connector("oauth", {
          status: async () => ({ state: "auth_required", message: "SENTINEL-status" }),
          startAuth: async () => {
            starts++;
            return { state: "error" };
          },
        }),
        connector("broken", {
          status: async () => {
            throw new Error("SENTINEL-status");
          },
        }),
        connector("catalog", {
          staticTools: null,
          status: async () => ({ state: "ok" }),
          listTools: async () => {
            throw new Error("SENTINEL-catalog");
          },
        }),
      ],
      executor,
      auth: human,
      maintainers,
      ui: operatorUi(),
      logger: "silent",
    });
    const data = await read(app);
    expect(data.live.connectors.map((c) => c.problem)).toEqual([
      "oauth_required",
      "connector_unavailable",
      "catalog_failed",
    ]);
    expect(starts).toBe(0);
    expect(JSON.stringify(data)).not.toContain("SENTINEL");
  });
  it("INV-7: a probe deadline produces a typed failure and closes every connector scope", async () => {
    const closed: string[] = [];
    let aborted = false;
    const app = deployment({
      readOnly: false,
      connectors: [
        connector("slow", {
          status: (ctx) =>
            new Promise((_resolve, reject) =>
              ctx.signal!.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(new Error("SENTINEL-abort"));
                },
                { once: true },
              ),
            ),
          closeScope: async () => {
            closed.push("slow");
          },
        }),
        connector("fast", {
          closeScope: async () => {
            closed.push("fast");
          },
        }),
      ],
      executor,
      auth: human,
      maintainers,
      ui: operatorUi(),
      logger: "silent",
      discovery: { probeTimeoutMs: 20, concurrency: 2 },
    });
    const data = await read(app);
    expect(data.live.connectors[0]).toMatchObject({ status: "error", problem: "connector_unavailable", tools: [] });
    expect(data.live.connectors[1]?.status).toBe("ok");
    expect(closed.sort()).toEqual(["fast", "slow"]);
    expect(aborted).toBe(true);
    expect(JSON.stringify(data)).not.toContain("SENTINEL");
  });

  it("INV-7: cancelling an activity read never starts its next page", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: (value: { events: ToolCallActivityEvent[]; nextCursor: string }) => void;
    const page = new Promise<{ events: ToolCallActivityEvent[]; nextCursor: string }>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const app = deployment({
      readOnly: false,
      connectors: [connector("svc")],
      executor,
      auth: human,
      maintainers,
      ui: operatorUi(),
      logger: "silent",
      activity: activityHistory({
        store: {
          record() {},
          list: async () => {
            calls++;
            entered();
            return page;
          },
        },
      }),
    });
    const controller = new AbortController();
    const pending = app
      .fetch(new Request(`${BASE}/ui/api/config`, { signal: controller.signal }))
      .catch(() => undefined);
    await started;
    controller.abort();
    await pending;
    release({ events: [], nextCursor: "next" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1);
  });
});
